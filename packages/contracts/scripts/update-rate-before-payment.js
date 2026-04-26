import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.ARC_TESTNET_RPC_URL;
const STABLEFX_ADAPTER_ADDRESS = process.env.STABLEFX_ADAPTER_ADDRESS;

// StableFX Adapter ABI
const ADAPTER_ABI = [
  'function updateExchangeRate(uint256 _rate) external',
  'function getCurrentRate() external view returns (uint256)',
  'function getRateTimestamp() external view returns (uint256)',
  'function rateExpirySeconds() external view returns (uint256)',
  'event ExchangeRateUpdated(uint256 indexed newRate, uint256 indexed timestamp)'
];

async function updateExchangeRate() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║        Update StableFX Exchange Rate - 1 EUR = 1.10 USD         ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log(`📍 Wallet: ${signer.address}`);
  console.log(`📍 StableFX Adapter: ${STABLEFX_ADAPTER_ADDRESS}\n`);
  
  try {
    const adapter = new ethers.Contract(STABLEFX_ADAPTER_ADDRESS, ADAPTER_ABI, signer);
    
    // Step 1: Check current rate
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 1: Check Current Rate');
    console.log('');
    
    try {
      const currentRate = await adapter.getCurrentRate();
      const currentTimestamp = await adapter.getRateTimestamp();
      const rateExpiry = await adapter.rateExpirySeconds();
      
      const now = Math.floor(Date.now() / 1000);
      const age = now - Number(currentTimestamp);
      const timeUntilExpiry = Number(rateExpiry) - age;
      
      console.log(`Current stored rate: ${ethers.formatUnits(currentRate, 6)} USDC per EURC`);
      console.log(`Rate timestamp: ${new Date(Number(currentTimestamp) * 1000).toISOString()}`);
      console.log(`Rate age: ${age} seconds`);
      console.log(`Rate expiry in: ${Math.max(0, timeUntilExpiry)} seconds`);
      
      if (timeUntilExpiry <= 0) {
        console.log('⚠️  Rate is EXPIRED - needs update\n');
      } else {
        console.log(`✅ Rate is valid for ${timeUntilExpiry} more seconds\n`);
      }
    } catch (error) {
      console.log('⚠️  Could not read current rate, contract might need initialization\n');
    }
    
    // Step 2: Set new rate
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 2: Update Rate to 1.10 USDC per EURC');
    console.log('');
    
    // New rate: 1 EURC = 1.10 USDC
    const newRate = ethers.parseUnits('1.10', 6);
    console.log(`New rate: 1.10 USDC per EURC`);
    console.log(`As contract value (6 decimals): ${newRate.toString()}\n`);
    
    console.log('Executing updateExchangeRate transaction...');
    const updateTx = await adapter.updateExchangeRate(newRate);
    console.log(`Transaction hash: ${updateTx.hash}`);
    console.log('Waiting for confirmation...\n');
    
    const receipt = await updateTx.wait();
    console.log(`✅ Rate updated! Block: ${receipt.blockNumber}`);
    console.log(`Gas used: ${receipt.gasUsed.toString()}\n`);
    
    // Step 3: Verify update
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 3: Verify Rate Update');
    console.log('');
    
    const updatedRate = await adapter.getCurrentRate();
    const updatedTimestamp = await adapter.getRateTimestamp();
    const rateExpiry2 = await adapter.rateExpirySeconds();
    
    const now2 = Math.floor(Date.now() / 1000);
    const validUntil = Number(updatedTimestamp) + Number(rateExpiry2);
    
    console.log(`Verified rate: ${ethers.formatUnits(updatedRate, 6)} USDC per EURC`);
    console.log(`Updated timestamp: ${new Date(Number(updatedTimestamp) * 1000).toISOString()}`);
    console.log(`Valid for: ${Number(rateExpiry2)} seconds`);
    console.log(`Valid until: ${new Date(validUntil * 1000).toISOString()}`);
    console.log('');
    
    if (ethers.formatUnits(updatedRate, 6) === '1.1') {
      console.log('✅ Rate update SUCCESSFUL!\n');
    }
    
    // Step 4: Extract event
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 4: Event Details');
    console.log('');
    
    const iface = new ethers.Interface(ADAPTER_ABI);
    for (const log of receipt.logs) {
      try {
        const decoded = iface.parseLog(log);
        if (decoded?.name === 'ExchangeRateUpdated') {
          console.log('ExchangeRateUpdated Event:');
          console.log(`  New Rate: ${ethers.formatUnits(decoded.args[0], 6)} USDC per EURC`);
          console.log(`  Timestamp: ${new Date(Number(decoded.args[1]) * 1000).toISOString()}`);
        }
      } catch (e) {
        // Not our event
      }
    }
    console.log('');
    
    console.log('✅ Exchange Rate Update Complete!');
    console.log('💡 Ready to execute payment flow with current rate.\n');
    
    return true;
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.data) {
      console.error('Revert data:', error.data);
    }
    return false;
  }
}

updateExchangeRate().catch(console.error);
