import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.ARC_TESTNET_RPC_URL;
const WIZPAY_ADDRESS = process.env.WIZPAY_ADDRESS;

// ARC Addresses
const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

// WizPay Contract ABI
const WIZPAY_ABI = [
  'function updateExchangeRate(uint256 newRate) external',
  'function getCurrentRate() external view returns (uint256)',
  'function executePayment(address token, uint256 amount, uint256 minOutput, address recipient) external',
  'function owner() external view returns (address)',
  'event ExchangeRateUpdated(uint256 indexed newRate, uint256 indexed timestamp)'
];

// ERC20 ABI
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)'
];

async function demonstrateManualRateUpdate() {
  console.log('💱 WizPay Manual Exchange Rate Update System\n');
  console.log('📋 Scenario: Update exchange rate for EURC → USDC conversion\n');
  
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log(`Wallet: ${signer.address}`);
  console.log(`WizPay Contract: ${WIZPAY_ADDRESS}\n`);
  
  try {
    const wizPay = new ethers.Contract(WIZPAY_ADDRESS, WIZPAY_ABI, signer);
    
    // Step 1: Get current rate
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 1: Get Current Exchange Rate');
    
    const currentRate = await wizPay.getCurrentRate();
    const rateInDecimals = ethers.formatUnits(currentRate, 6);
    console.log(`Current stored rate: ${rateInDecimals} (1 EURC = X USDC)\n`);
    
    // Step 2: Prepare new rate
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 2: Prepare New Exchange Rate');
    
    // Example: 1 EURC = 1.10 USDC (realistic EUR/USD rate)
    const newRate = ethers.parseUnits('1.10', 6);
    console.log(`New rate to set: 1.10 USDC per EURC`);
    console.log(`As contract value: ${newRate.toString()}`);
    console.log(`In decimals: ${ethers.formatUnits(newRate, 6)}\n`);
    
    // Step 3: Check owner
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 3: Verify Owner');
    
    const owner = await wizPay.owner();
    console.log(`WizPay owner: ${owner}`);
    console.log(`Your wallet: ${signer.address}`);
    
    if (owner.toLowerCase() === signer.address.toLowerCase()) {
      console.log('✅ You are the owner - can update rates\n');
    } else {
      console.log('⚠️  You are NOT the owner - cannot update rates\n');
      console.log('💡 To enable this feature:');
      console.log('   1. Deploy WizPay with your wallet as owner');
      console.log('   2. Or transfer ownership to your wallet\n');
      return;
    }
    
    // Step 4: Simulate update (don't execute, just show the transaction)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 4: Transaction Details (Ready to Execute)');
    console.log('');
    console.log('Function: updateExchangeRate(uint256 newRate)');
    console.log(`Parameter: ${newRate.toString()}`);
    console.log('');
    console.log('📊 What this does:');
    console.log('   - Sets new EUR/USD exchange rate on-chain');
    console.log('   - All future payments use this rate');
    console.log('   - Emits ExchangeRateUpdated event');
    console.log('   - Gas cost: ~50,000 gas (ARC pricing)\n');
    
    // Step 5: Show manual rate update workflow
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 5: Complete Manual Rate Update Workflow\n');
    
    console.log('📋 Process:');
    console.log(`
1. Get real exchange rate from:
   - Yahoo Finance API
   - Alpha Vantage
   - Coingecko
   - Or any trusted rate provider

2. Verify rate is reasonable:
   - EUR/USD typically: 0.95 - 1.15
   - Add small buffer for safety

3. Update contract:
   ${`await wizPay.updateExchangeRate(newRate)`}

4. Verify update:
   - Check on-chain rate
   - Monitor events
   - Ensure payments use new rate

5. Repeat periodically:
   - Update every hour/day
   - Or on-demand based on volatility
    `);
    
    // Step 6: Show actual payment with new rate
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 6: Example Payment with New Rate\n');
    
    const eurcAmount = ethers.parseUnits('1', 6); // 1 EURC
    const expectedUsdc = (BigInt(1) * newRate) / ethers.parseUnits('1', 6);
    
    console.log('Example transaction:');
    console.log(`   Input: 1 EURC`);
    console.log(`   Output (expected): ${ethers.formatUnits(expectedUsdc, 6)} USDC`);
    console.log(`   Rate applied: 1.10 USDC/EURC`);
    console.log('');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// Show how to integrate external rate feeds
async function showRateFeedIntegration() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Integration Options for Exchange Rates\n');
  
  console.log('Option 1: Yahoo Finance');
  console.log('  API: https://query1.finance.yahoo.com/v10/finance/quoteSummary/EURUSD');
  console.log('  Update frequency: Every 5 minutes\n');
  
  console.log('Option 2: Alpha Vantage');
  console.log('  API: https://www.alphavantage.co/query');
  console.log('  Free tier: 5 calls/minute\n');
  
  console.log('Option 3: Open Exchange Rates');
  console.log('  API: https://openexchangerates.org/api/latest');
  console.log('  Freemium: Good for production\n');
  
  console.log('Option 4: Build cron job');
  console.log('  Schedule: Every hour or on-demand');
  console.log('  Fetch real rate → Update contract\n');
}

console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║         WizPay Manual Exchange Rate Management System          ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

demonstrateManualRateUpdate().catch(console.error);
showRateFeedIntegration();
