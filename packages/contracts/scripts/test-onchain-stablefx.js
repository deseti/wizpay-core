import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.ARC_TESTNET_RPC_URL;

// ARC Contract Addresses
const FX_ESCROW = '0x1f91886C7028986aD885ffCee0e40b75C9cd5aC1';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const USDC = '0x3600000000000000000000000000000000000000'; // Native USDC (18 decimals on Arc)
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'; // EURC (6 decimals)

// FxEscrow ABI - Settlement functions
const FX_ESCROW_ABI = [
  'function settle(address maker, address taker, address makerToken, address takerToken, uint256 makerAmount, uint256 takerAmount, uint256 nonce, bytes calldata makerSignature, bytes calldata takerSignature) external',
  'function getExchangeRate(address tokenFrom, address tokenTo) external view returns (uint256)',
  'function getNonce(address user) external view returns (uint256)',
  'function verifyQuote(bytes calldata quoteData) external view returns (bool)'
];

// ERC20 ABI for token operations
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function decimals() external view returns (uint8)'
];

// Permit2 ABI
const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration) external',
  'function transferFrom(address from, address to, uint160 amount, address token) external'
];

async function testOnChainStableFX() {
  console.log('🔗 Testing On-Chain StableFX Settlement\n');
  console.log('ARC Contract Addresses:');
  console.log(`  FxEscrow: ${FX_ESCROW}`);
  console.log(`  Permit2: ${PERMIT2}`);
  console.log(`  USDC (native): ${USDC}`);
  console.log(`  EURC: ${EURC}\n`);
  
  // Setup provider and signer
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log(`📍 Wallet Address: ${signer.address}\n`);
  
  try {
    // Step 1: Check contract code
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 1: Verify FxEscrow Contract Exists');
    
    const fxEscrowCode = await provider.getCode(FX_ESCROW);
    console.log(`FxEscrow contract code length: ${fxEscrowCode.length} bytes`);
    
    if (fxEscrowCode === '0x') {
      console.log('❌ FxEscrow contract not found at address!');
      return;
    }
    console.log('✅ FxEscrow contract exists\n');
    
    // Step 2: Check user balances
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 2: Check Token Balances');
    
    const usdcBalance = await provider.getBalance(signer.address);
    console.log(`USDC (native) balance: ${ethers.formatUnits(usdcBalance, 18)} USDC`);
    
    // Check EURC balance
    const eurcContract = new ethers.Contract(EURC, ERC20_ABI, provider);
    const eurcBalance = await eurcContract.balanceOf(signer.address);
    const eurcDecimals = await eurcContract.decimals();
    console.log(`EURC balance: ${ethers.formatUnits(eurcBalance, eurcDecimals)} EURC`);
    console.log('');
    
    // Step 3: Try to get exchange rate from contract (if method exists)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 3: Query Exchange Rate from FxEscrow');
    
    try {
      const fxEscrowContract = new ethers.Contract(FX_ESCROW, FX_ESCROW_ABI, provider);
      
      // Try to get exchange rate
      const rate = await fxEscrowContract.getExchangeRate(EURC, USDC);
      console.log(`Exchange rate (1 EURC = ? USDC): ${ethers.formatUnits(rate, 18)}`);
      console.log('✅ Successfully retrieved exchange rate from contract\n');
    } catch (error) {
      console.log(`⚠️  Could not get exchange rate from contract: ${error.message}`);
      console.log('This is expected if getExchangeRate is not public or uses different params\n');
    }
    
    // Step 4: Setup Permit2 approval
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 4: Setup Permit2 Approval (Dry Run)');
    console.log('Note: The flow for StableFX settlement:');
    console.log('  1. Maker and Taker agree on quote off-chain');
    console.log('  2. Both approve Permit2 for token spending');
    console.log('  3. Call FxEscrow.settle() with both signatures');
    console.log('  4. Contract verifies signatures and executes swap\n');
    
    // Step 5: Display settlement flow
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 5: On-Chain Settlement Flow');
    console.log(`
Expected Settlement Process:
1️⃣  Market Makers quote rates via Circle StableFX API
2️⃣  Takers accept quote and prepare settlement
3️⃣  Both parties grant Permit2 allowance:
    - Maker approves spending makerToken
    - Taker approves spending takerToken
4️⃣  Settlement via FxEscrow.settle():
    - Verify both signatures
    - Transfer makerToken from maker to taker
    - Transfer takerToken from taker to maker
    - Emit settlement event
5️⃣  Post-settlement verification on-chain

Current Implementation Status:
  ✅ FxEscrow contract verified
  ✅ Token balances checked
  ✅ Can query contract state
  ⏳ Waiting for: Circle StableFX API access for quote generation
    `);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testOnChainStableFX().catch(console.error);
