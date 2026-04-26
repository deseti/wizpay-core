import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.ARC_TESTNET_RPC_URL;
const WIZPAY_ADDRESS = process.env.WIZPAY_ADDRESS;

// Contract addresses
const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

// ABIs
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function decimals() external view returns (uint8)',
  'function name() external view returns (string)',
  'function symbol() external view returns (string)'
];

const WIZPAY_ABI = [
  'function routeAndPay(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient) external returns (uint256)',
  'event PaymentRouted(address indexed sender, address indexed recipient, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 feeAmount)'
];

async function testCompletePaymentFlow() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║      WizPay Complete Payment Flow Test with Real Rates         ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log(`📍 Wallet: ${signer.address}`);
  console.log(`📍 WizPay Contract: ${WIZPAY_ADDRESS}\n`);
  
  try {
    // Step 1: Check balances before
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 1: Check Initial Balances');
    console.log('');
    
    const eurcContract = new ethers.Contract(EURC, ERC20_ABI, provider);
    const usdcBalance = await provider.getBalance(signer.address);
    const eurcBalance = await eurcContract.balanceOf(signer.address);
    const eurcDecimals = await eurcContract.decimals();
    
    console.log(`USDC (native) balance: ${ethers.formatUnits(usdcBalance, 18)} USDC`);
    console.log(`EURC balance: ${ethers.formatUnits(eurcBalance, eurcDecimals)} EURC\n`);
    
    // Step 2: Define payment parameters
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 2: Define Payment Parameters');
    console.log('');
    
    // Real market rate: 1 EUR ≈ 1.10 USD
    const realRate = 1.10;
    const paymentAmount = ethers.parseUnits('1', 6); // 1 EURC
    const expectedOutput = ethers.parseUnits('1.10', 6); // 1.10 USDC
    const slippageTolerance = 0.985; // 1.5% slippage allowed
    const minOutput = ethers.parseUnits('1.0835', 6); // 1.10 * 0.985
    
    console.log(`Payment Details:`);
    console.log(`  Input: ${ethers.formatUnits(paymentAmount, 6)} EURC`);
    console.log(`  Market Rate: 1 EURC = ${realRate} USDC`);
    console.log(`  Expected Output: ${ethers.formatUnits(expectedOutput, 6)} USDC`);
    console.log(`  Slippage Tolerance: 1.5%`);
    console.log(`  Minimum Output: ${ethers.formatUnits(minOutput, 6)} USDC`);
    console.log('');
    
    // Create recipient (can be same wallet for testing)
    const recipient = signer.address;
    console.log(`  Recipient: ${recipient}\n`);
    
    // Step 3: Approve EURC for WizPay
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 3: Approve EURC Token Spending');
    console.log('');
    
    const eurcWithSigner = eurcContract.connect(signer);
    const approveTx = await eurcWithSigner.approve(WIZPAY_ADDRESS, paymentAmount);
    console.log(`Approval tx: ${approveTx.hash}`);
    console.log('Waiting for confirmation...');
    const approveReceipt = await approveTx.wait();
    console.log(`✅ Approved! Block: ${approveReceipt.blockNumber}\n`);
    
    // Step 4: Execute payment
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 4: Execute Payment via WizPay');
    console.log('');
    
    const wizPay = new ethers.Contract(WIZPAY_ADDRESS, WIZPAY_ABI, signer);
    console.log('Calling routeAndPay...');
    
    const paymentTx = await wizPay.routeAndPay(
      EURC,           // tokenIn
      USDC,           // tokenOut
      paymentAmount,  // amountIn: 1 EURC
      minOutput,      // minAmountOut: 1.0835 USDC (with slippage)
      recipient       // recipient
    );
    
    console.log(`Payment tx: ${paymentTx.hash}`);
    console.log('Waiting for confirmation...');
    const paymentReceipt = await paymentTx.wait();
    console.log(`✅ Payment executed! Block: ${paymentReceipt.blockNumber}\n`);
    
    // Step 5: Extract and display events
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 5: Payment Event Details');
    console.log('');
    
    const iface = new ethers.Interface(WIZPAY_ABI);
    for (const log of paymentReceipt.logs) {
      try {
        const decoded = iface.parseLog(log);
        if (decoded?.name === 'PaymentRouted') {
          console.log('PaymentRouted Event:');
          console.log(`  From: ${decoded.args[0]}`);
          console.log(`  To: ${decoded.args[1]}`);
          console.log(`  Token In: ${decoded.args[2]}`);
          console.log(`  Token Out: ${decoded.args[3]}`);
          console.log(`  Amount In: ${ethers.formatUnits(decoded.args[4], 6)}`);
          console.log(`  Amount Out: ${ethers.formatUnits(decoded.args[5], 6)}`);
          console.log(`  Fee Collected: ${ethers.formatUnits(decoded.args[6], 6)}`);
        }
      } catch (e) {
        // Log not from WizPay
      }
    }
    console.log('');
    
    // Step 6: Check final balances
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 6: Check Final Balances');
    console.log('');
    
    const usdcBalanceAfter = await provider.getBalance(signer.address);
    const eurcBalanceAfter = await eurcContract.balanceOf(signer.address);
    
    const usdcDiff = ethers.formatUnits(usdcBalanceAfter.toString(), 18);
    const eurcDiff = ethers.formatUnits(eurcBalanceAfter.toString(), 6);
    
    console.log(`USDC balance after: ${usdcDiff} USDC`);
    console.log(`EURC balance after: ${eurcDiff} EURC`);
    console.log('');
    
    // Step 7: Summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 7: Payment Summary');
    console.log('');
    
    console.log('✅ Payment Flow Complete!');
    console.log(`\n📊 Summary:`);
    console.log(`  Input: 1 EURC`);
    console.log(`  Output: ~${realRate} USDC (based on market rate)`);
    console.log(`  Transaction Hash: ${paymentTx.hash}`);
    console.log(`  Block Number: ${paymentReceipt.blockNumber}`);
    console.log(`  Gas Used: ${paymentReceipt.gasUsed.toString()}`);
    console.log('');
    
    console.log('💡 This demonstrates:');
    console.log('  ✓ Real EUR/USD exchange rate (1.10)');
    console.log('  ✓ Token approval flow');
    console.log('  ✓ Cross-stablecoin payment routing');
    console.log('  ✓ On-chain settlement');
    console.log('  ✓ Event-based verification');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.data) {
      console.error('Revert data:', error.data);
    }
  }
}

testCompletePaymentFlow().catch(console.error);
