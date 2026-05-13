import { ethers } from 'ethers';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Production Mode Guard
// When NEXT_PUBLIC_USE_REAL_STABLEFX=true, this script MUST NOT run.
// All FX pricing in production comes exclusively from Circle StableFX RFQ.
// Requirements: 8.3, 8.5
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.NEXT_PUBLIC_USE_REAL_STABLEFX === 'true') {
  console.error(
    '❌ PRODUCTION MODE ACTIVE (NEXT_PUBLIC_USE_REAL_STABLEFX=true)\n' +
    '   auto-update-rates is DISABLED in production.\n' +
    '   All FX pricing must come from Circle StableFX RFQ.\n' +
    '   This script must not run in production environments.\n' +
    '   Exiting without updating rates.'
  );
  process.exit(1);
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.ARC_TESTNET_RPC_URL;
const ADAPTER_ADDRESS = process.env.STABLEFX_ADAPTER_ADDRESS;
const EURC = process.env.ARC_EURC;
const USDC = process.env.ARC_USDC;

const ADAPTER_ABI = [
  'function setExchangeRate(address tokenIn, address tokenOut, uint256 rate) external',
  'function getExchangeRate(address tokenIn, address tokenOut) external view returns (uint256 rate)',
  'function rateTimestamps(address, address) external view returns (uint256)',
  'function owner() external view returns (address)',
];

async function fetchMarketRate() {
  console.log('📊 Fetching current market rate from CoinGecko...');

  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=euro-coin&vs_currencies=usd');

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data['euro-coin'] && data['euro-coin'].usd) {
      const rate = data['euro-coin'].usd;
      console.log(`✅ Current rate: 1 EURC = ${rate} USD`);
      return rate;
    }

    throw new Error('Invalid response from CoinGecko');

  } catch (error) {
    console.log(`⚠️  Failed to fetch from CoinGecko: ${error.message}`);
    console.log('Using fallback rate: 1.09');
    return 1.09;
  }
}

async function updateAdapterRate() {
  console.log('🔄 Auto-Update StableFXAdapter with Real Market Rates\n');

  try {
    // Fetch current market rate
    const marketRate = await fetchMarketRate();
    const rateForContract = ethers.parseUnits(marketRate.toString(), 18); // 18 decimals for contract
    console.log(`Contract rate value: ${rateForContract.toString()}`);
    console.log('');

    // Connect to blockchain
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const adapter = new ethers.Contract(ADAPTER_ADDRESS, ADAPTER_ABI, wallet);

    console.log('🔑 Adapter Address:', ADAPTER_ADDRESS);
    console.log('👤 Updating from:', wallet.address);
    console.log('');

    // Check current rate in contract (skip if rate is expired)
    console.log('🔍 Checking current rate in contract...');
    try {
      const currentRate = await adapter.getExchangeRate(EURC, USDC);
      const currentRateDecimal = parseFloat(ethers.formatUnits(currentRate, 18)); // 18 decimals

      const lastUpdate = await adapter.rateTimestamps(EURC, USDC);
      const lastUpdateDate = new Date(Number(lastUpdate) * 1000);

      console.log(`Current rate in contract: ${currentRateDecimal}`);
      console.log(`Last update: ${lastUpdateDate.toISOString()}`);
      console.log('');

      // Check if update is needed
      const rateDifference = Math.abs(currentRateDecimal - marketRate);
      const percentDifference = (rateDifference / currentRateDecimal) * 100;

      console.log(`Rate difference: ${rateDifference.toFixed(4)} (${percentDifference.toFixed(2)}%)`);

      if (percentDifference < 0.1) {
        console.log('✅ Rate is up-to-date, no update needed');
        console.log(`   (Threshold: 0.1% difference)`);
        return;
      }
      console.log('');
    } catch (error) {
      if (error.message.includes('Rate expired')) {
        console.log('⚠️  Current rate is expired (>5 minutes old)');
        console.log('   Proceeding with update...');
        console.log('');
      } else {
        throw error;
      }
    }

    console.log('🔏 Updating rate in contract...');

    // Update rate
    const tx = await adapter.setExchangeRate(EURC, USDC, rateForContract);
    console.log('Transaction hash:', tx.hash);
    console.log('⏳ Waiting for confirmation...');

    const receipt = await tx.wait();
    console.log('✅ Rate updated successfully!');
    console.log(`   Block: ${receipt.blockNumber}`);
    console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
    console.log('');

    // Verify new rate
    try {
      const newRate = await adapter.getExchangeRate(EURC, USDC);
      const newRateDecimal = parseFloat(ethers.formatUnits(newRate, 18));
      const newUpdate = await adapter.rateTimestamps(EURC, USDC);
      console.log('✅ Verified new rate:', newRateDecimal);
      console.log(`   Updated at: ${new Date(Number(newUpdate) * 1000).toISOString()}`);
    } catch (error) {
      console.log('⚠️  Could not verify new rate (likely still propagating)');
      console.log(`   Expected rate: ${marketRate}`);
    }
  } catch (error) {
    console.error('❌ Error updating rate:', error.message);

    if (error.code === 'INSUFFICIENT_FUNDS') {
      console.log('');
      console.log('💡 Your wallet needs more USDC for gas fees');
      console.log('   Visit: https://faucet.circle.com');
    }
  }
}

// Execute with optional interval
const args = process.argv.slice(2);
const mode = args[0];

if (mode === '--watch') {
  const intervalMinutes = parseInt(args[1]) || 60; // Default 60 minutes
  console.log(`👀 Watch mode enabled - updating every ${intervalMinutes} minutes`);
  console.log('Press Ctrl+C to stop\n');

  // Initial update
  updateAdapterRate();

  // Set interval
  setInterval(updateAdapterRate, intervalMinutes * 60 * 1000);
} else {
  // Single update
  updateAdapterRate();
}
