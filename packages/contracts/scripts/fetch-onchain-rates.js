import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.ARC_TESTNET_RPC_URL;
const STABLEFX_ESCROW = process.env.STABLEFX_ESCROW || '0x1f91886C7028986aD885ffCee0e40b75C9cd5aC1';
const EURC = process.env.ARC_EURC;
const USDC = process.env.ARC_USDC;

// FxEscrow ABI (minimal for querying rates)
const FX_ESCROW_ABI = [
  'function getPrice(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut)',
  'function fxEngine() external view returns (address)',
];

async function fetchOnchainRates() {
  console.log('🔍 Fetching Exchange Rates from On-Chain StableFX...\n');
  
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const fxEscrow = new ethers.Contract(STABLEFX_ESCROW, FX_ESCROW_ABI, provider);
    
    console.log('📍 FxEscrow Address:', STABLEFX_ESCROW);
    console.log('🪙 EURC Address:', EURC);
    console.log('🪙 USDC Address:', USDC);
    console.log('');
    
    // Get FX Engine address
    console.log('🔗 Fetching FX Engine address...');
    const fxEngineAddress = await fxEscrow.fxEngine();
    console.log('✅ FX Engine:', fxEngineAddress);
    console.log('');
    
    // Test with 1 EURC (6 decimals)
    const testAmount = ethers.parseUnits('1', 6);
    
    console.log('💱 Getting EUR/USD rate...');
    console.log('Input: 1 EURC');
    
    const amountOut = await fxEscrow.getPrice(EURC, USDC, testAmount);
    const rate = parseFloat(ethers.formatUnits(amountOut, 6));
    
    console.log(`Output: ${rate} USDC`);
    console.log(`Rate: 1 EURC = ${rate} USDC`);
    console.log('');
    
    console.log('💡 This rate can be used to update StableFXAdapter:');
    console.log(`   Rate in wei (6 decimals): ${amountOut.toString()}`);
    console.log(`   Rate for setExchangeRate: ${rate * 1e6}`);
    console.log('');
    
    console.log('✅ Successfully fetched on-chain rate!');
    
    return {
      rate,
      rateWei: amountOut,
      rateForContract: Math.floor(rate * 1e6)
    };
    
  } catch (error) {
    console.error('❌ Error fetching on-chain rates:', error.message);
    
    if (error.message.includes('could not coalesce error')) {
      console.log('');
      console.log('⚠️  This might mean:');
      console.log('   1. StableFX contract not available on testnet yet');
      console.log('   2. Function signature mismatch');
      console.log('   3. Network connectivity issue');
      console.log('');
      console.log('💡 Alternative: Use market rate APIs (e.g., CoinGecko, CoinMarketCap)');
    }
  }
}

fetchOnchainRates();
