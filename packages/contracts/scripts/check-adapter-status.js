import { ethers } from 'ethers';
import dotenv from 'dotenv';

import { readArcTestnetRpcUrl } from './arc-rpc.js';

dotenv.config();

const RPC_URL = readArcTestnetRpcUrl();
const ADAPTER_ADDRESS = process.env.STABLEFX_ADAPTER_ADDRESS;
const EURC = process.env.ARC_EURC;
const USDC = process.env.ARC_USDC;

const ADAPTER_ABI = [
  'function getExchangeRate(address tokenIn, address tokenOut) external view returns (uint256 rate)',
  'function owner() external view returns (address)',
  'function rateTimestamps(address, address) external view returns (uint256)',
];

async function checkAdapter() {
  console.log('🔍 Checking StableFXAdapter Status...\n');
  
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const adapter = new ethers.Contract(ADAPTER_ADDRESS, ADAPTER_ABI, provider);
    
    console.log('📍 Adapter:', ADAPTER_ADDRESS);
    console.log('🪙 EURC:', EURC);
    console.log('🪙 USDC:', USDC);
    console.log('');
    
    // Get owner
    const owner = await adapter.owner();
    console.log('👤 Owner:', owner);
    console.log('');
    
    // Get current rate
    console.log('💱 Fetching EUR/USD rate...');
    const rate = await adapter.getExchangeRate(EURC, USDC);
    const rateDecimal = parseFloat(ethers.formatUnits(rate, 18)); // 18 decimals in contract
    
    // Get last update timestamp
    const lastUpdate = await adapter.rateTimestamps(EURC, USDC);
    const updateDate = new Date(Number(lastUpdate) * 1000);
    const now = new Date();
    const ageMinutes = Math.floor((now - updateDate) / 1000 / 60);
    
    console.log(`✅ Current Rate: 1 EURC = ${rateDecimal} USDC`);
    console.log(`📅 Last Updated: ${updateDate.toISOString()}`);
    console.log(`⏱️  Age: ${ageMinutes} minutes ago`);
    console.log('');
    
    if (ageMinutes >= 5) {
      console.log('⚠️  Rate is expired (>5 minutes old)');
      console.log('   Run: node scripts/auto-update-rates.js');
    } else {
      console.log('✅ Rate is fresh and valid!');
    }
    console.log('');
    
    console.log('📊 Rate Details:');
    console.log(`   Rate (wei): ${rate.toString()}`);
    console.log(`   Rate (decimal): ${rateDecimal}`);
    console.log(`   Validity period: 5 minutes`);
    console.log(`   Time remaining: ${5 - ageMinutes} minutes`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

checkAdapter();
