# WizPay- ARC Smart Payment Router

A **production-ready**, non-custodial Smart Payment Router for the **ARC Layer-1 blockchain** by Circle. WizPay enables atomic cross-stablecoin payments with advanced features like fee collection, emergency pause, and token whitelisting.

## 🌟 Overview

WizPay allows senders to pay using one stablecoin (e.g., EURC) while recipients receive another (e.g., USDC) in a single, atomic transaction. Built specifically for the ARC blockchain, which uses USDC as native gas and features built-in FX capabilities.

### ✨ Key Features

✅ **Atomic Cross-Stablecoin Payments** - Complete payment routing in a single transaction  
✅ **Slippage Protection** - Mandatory `minAmountOut` parameter protects users  
✅ **Non-Custodial Design** - Contract never holds user funds after transactions  
✅ **Emergency Pause** - Owner can pause/unpause contract in emergencies  
✅ **Fee Collection System** - Optional fee (max 1%) with configurable collector  
✅ **Token Whitelist** - Optional security layer to restrict supported tokens  
✅ **Generic FX Integration** - Works with StableFX, Uniswap, or any DEX  
✅ **ReentrancyGuard** - Protection against reentrancy attacks  
✅ **Gas Efficient** - Optimized for ARC's $0.01 per transaction target  

## 🏗️ Architecture

### Core Components

1. **WizPay.sol** - Main router contract (2.07M gas deployment)
2. **StableFXAdapter.sol** - Adapter for Circle's StableFX with real market rates
3. **MockFXEngine.sol** - Test FX engine for local development
4. **IFXEngine.sol** - Generic interface for FX engines
5. **IERC20.sol** - Standard ERC20 token interface
6. **IPermit2.sol** - Interface for Uniswap Permit2 (StableFX compatibility)

### Payment Flow

```mermaid
graph LR
    A[User] -->|1. Approve| B[WizPay]
    A -->|2. routeAndPay| B
    B -->|3. Pull tokenIn| A
    B -->|4. Deduct Fee| C[Fee Collector]
    B -->|5. Swap via StableFXAdapter| D[StableFX]
    D -->|6. Real Market Rates| D
    D -->|7. Send tokenOut| E[Recipient]
```

All steps execute atomically - if any step fails, the entire transaction reverts.

### FX Engine Options

| Engine | Type | Rates | Use Case |
|--------|------|-------|----------|
| **StableFXAdapter** | Production | Real-time market | Mainnet & testnet (recommended) |
| **MockFXEngine** | Test | Hardcoded | Local development only |
| **StableFX Direct** | Production | RFQ-based | Advanced institutional use |

## 📡 ARC Network Information

### ARC Testnet
- **Chain ID**: 5042002
- **RPC Endpoint**: `https://rpc.testnet.arc.network`
- **Native Gas Token**: USDC (18 decimals for gas, 6 decimals for ERC-20)
- **Block Explorer**: https://testnet.arcscan.app
- **Faucet**: https://faucet.circle.com
- **Target Gas Fee**: ~$0.01 per transaction (160 Gwei minimum)

### Official Contract Addresses

| Contract | Address | Description |
|----------|---------|-------------|
| **USDC** | `0x3600000000000000000000000000000000000000` | Native gas token (ERC-20 interface, 6 decimals) |
| **EURC** | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` | Euro stablecoin (6 decimals) |
| **USYC** | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` | Yield-bearing token (6 decimals) |
| **StableFX Escrow** | `0x1f91886C7028986aD885ffCee0e40b75C9cd5aC1` | Institutional FX engine |
| **Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Allowance management |

## 📝 Smart Contract API

### Constructor

```solidity
constructor(
    address _fxEngine,
    address _feeCollector,
    uint256 _feeBps
)
```

**Parameters:**
- `_fxEngine` - Address of FX Engine (StableFX, Uniswap, etc.)
- `_feeCollector` - Address that receives collected fees
- `_feeBps` - Fee in basis points (10 = 0.1%, max 100 = 1%)

### routeAndPay

```solidity
function routeAndPay(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    uint256 minAmountOut,
    address recipient
) external returns (uint256 amountOut)
```

**Parameters:**
- `tokenIn` - Address of input stablecoin (sender pays with this)
- `tokenOut` - Address of output stablecoin (recipient receives this)
- `amountIn` - Amount of input tokens to send
- `minAmountOut` - Minimum acceptable output (slippage protection)
- `recipient` - Address that will receive output tokens

**Requirements:**
- Contract must not be paused
- Tokens must be whitelisted (if whitelist is enabled)
- Sender must approve WizPay for at least `amountIn`
- All addresses must be non-zero
- `amountIn` must be greater than zero

### Admin Functions

#### updateFee
```solidity
function updateFee(uint256 _feeBps) external onlyOwner
```
Update the fee percentage (max 1%).

#### updateFeeCollector
```solidity
function updateFeeCollector(address _feeCollector) external onlyOwner
```
Change the address that receives collected fees.

#### setTokenWhitelist
```solidity
function setTokenWhitelist(address token, bool status) external onlyOwner
```
Add or remove a token from the whitelist.

#### batchSetTokenWhitelist
```solidity
function batchSetTokenWhitelist(address[] calldata tokens, bool status) external onlyOwner
```
Batch whitelist/delist multiple tokens at once.

#### setWhitelistEnabled
```solidity
function setWhitelistEnabled(bool enabled) external onlyOwner
```
Enable or disable whitelist enforcement.

#### pause / unpause
```solidity
function pause() external onlyOwner
function unpause() external onlyOwner
```
Emergency pause/unpause the contract.

### getEstimatedOutput

```solidity
function getEstimatedOutput(
    address tokenIn,
    address tokenOut,
    uint256 amountIn
) external view returns (uint256 estimatedAmountOut)
```

Get estimated output amount before executing a payment.

### updateFXEngine (Owner Only)

```solidity
function updateFXEngine(address _fxEngine) external onlyOwner
```

Update the FX Engine address. Only callable by contract owner.

## 🧪 Testing

The project includes comprehensive test coverage with **23 test cases** covering:

- ✅ Contract deployment and initialization
- ✅ Full payment flow (EURC → USDC and reverse)
- ✅ Fee collection and calculation
- ✅ Slippage protection enforcement
- ✅ Input validation and error handling
- ✅ Non-custodial guarantee (no fund accumulation)
- ✅ Atomic transaction behavior
- ✅ Owner function access control

### Run Tests

```bash
forge test
```

### Test Results

```
16 Foundry tests passing

Coverage includes:
- deployment and owner controls
- fee-aware routing and estimates
- mixed and legacy batch routing
- slippage protection and input validation
- non-custodial balance guarantees
```

## 🚀 Deployment Guide

### Prerequisites

1. **Install Foundry**
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

2. **Clone Submodules and Setup Environment**
```bash
git submodule update --init --recursive
cp .env.example .env
# Edit .env and add PRIVATE_KEY, ARC_TESTNET_RPC_URL, and FX_ENGINE_ADDRESS
```

3. **Get Testnet USDC for Gas**
- Visit https://faucet.circle.com
- Select "Arc Testnet"
- Request USDC (needed for gas fees)

4. **Get Test Tokens** (for testing payments)
- Request USDC, EURC, USYC from faucet
- These are REAL ARC Testnet tokens (official Circle deployments)

### Build, Test, and Deploy

```bash
# Compile contracts
forge build

# Run the Solidity test suite
forge test

# Deploy WizPay using values from .env
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$ARC_TESTNET_RPC_URL" \
  --broadcast
```

### Local Anvil Workflow

```bash
# Start a local node
anvil

# In another shell, point Foundry at Anvil
forge test
forge script script/Deploy.s.sol:Deploy \
  --rpc-url http://127.0.0.1:8545 \
  --broadcast
```

### What Gets Deployed

- ✅ `WizPay` with the configured FX engine address
- ✅ Constructor-level fee and fee collector configuration
- ✅ Foundry-native build, test, and deploy workflow

**Important**: These are official Circle stablecoins on ARC Testnet:
- USDC: `0x3600000000000000000000000000000000000000`
- EURC: `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`
- USYC: `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C`

Legacy Hardhat payment and deployment scripts were removed during the Foundry migration. For new operational flows, add a Foundry script under `script/` or use `cast send` directly against the deployed contracts.

## 📦 Project Structure

```
WizPay_Router/
├── src/
│   ├── WizPay.sol              # Main router
│   ├── StableFXAdapter_V2.sol  # ARC liquidity adapter
│   ├── IERC20.sol              # ERC20 interface
│   ├── IFXEngine.sol           # Generic FX engine interface
│   ├── IPermit2.sol            # Permit2 interface
│   └── mocks/
│       ├── MockERC20.sol       # Test stablecoin
│       └── MockFXEngine.sol    # Test FX engine
├── script/
│   └── Deploy.s.sol            # Foundry deployment script
├── test/
│   └── WizPay.t.sol            # Foundry Solidity test suite
├── lib/
│   ├── forge-std/
│   └── openzeppelin-contracts/
├── deployments/                # Deployment metadata
├── foundry.toml                # Foundry configuration
├── Makefile                    # Common forge commands
├── .env.example                # Environment template
└── README.md
```

## Installation

```bash
# Clone repository
git clone <your-repo-url>
cd WizPay_Router

# Install Foundry if needed
foundryup

# Fetch Solidity dependencies
git submodule update --init --recursive

# Setup environment
cp .env.example .env
# Edit .env with your configuration

# Compile contracts
forge build

# Run tests
forge test

# Deploy to ARC Testnet
forge script script/Deploy.s.sol:Deploy --rpc-url "$ARC_TESTNET_RPC_URL" --broadcast
```

## 🔧 Configuration

### Environment Variables (.env)

```bash
# Wallet & Network
PRIVATE_KEY=your_private_key_here
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network

# Deployment Config
FEE_BPS=10                    # 0.1% fee
FEE_COLLECTOR=0xYourAddress   # Fee recipient
FX_ENGINE_ADDRESS=0xYourFx    # Existing FX engine used by Deploy.s.sol

# Optional Foundry helpers
WIZPAY_ADDRESS=0xYourWizPay
```

### Fee Configuration

- **Default**: 10 basis points (0.1%)
- **Maximum**: 100 basis points (1%)
- **Formula**: `feeAmount = (amountIn × feeBps) / 10000`

### Whitelist Configuration

By default, whitelist is **disabled** (flexible mode). To enable:

```solidity
// Enable whitelist
await wizPay.setWhitelistEnabled(true);

// Add tokens to whitelist
await wizPay.batchSetTokenWhitelist(
  ["0xUSDC", "0xEURC", "0xUSDT"],
  true
);
```

## 💡 Usage Examples

### Basic Payment

```javascript
const { ethers } = require("ethers");

// Setup
const wizPay = await ethers.getContractAt("WizPay", WIZPAY_ADDRESS);
const eurc = await ethers.getContractAt("IERC20", EURC_ADDRESS);

// 1. Approve WizPay
const amount = ethers.parseUnits("1000", 6); // 1000 EURC
await eurc.approve(WIZPAY_ADDRESS, amount);

// 2. Get estimated output
const estimated = await wizPay.getEstimatedOutput(
  EURC_ADDRESS,
  USDC_ADDRESS,
  amount
);

// 3. Execute payment with 1% slippage tolerance
const minOut = (estimated * 99n) / 100n;
await wizPay.routeAndPay(
  EURC_ADDRESS,
  USDC_ADDRESS,
  amount,
  minOut,
  RECIPIENT_ADDRESS
);
```

### Admin Operations

```javascript
// Update fee to 0.2%
await wizPay.updateFee(20);

// Change fee collector
await wizPay.updateFeeCollector(NEW_COLLECTOR);

// Emergency pause
await wizPay.pause();

// Resume operations
await wizPay.unpause();

// Update FX Engine
await wizPay.updateFXEngine(NEW_FX_ENGINE);
```

## Dependencies

- **Solidity**: ^0.8.20
- **Hardhat**: ^2.26.0
- **OpenZeppelin Contracts**: ^5.4.0 (Ownable, Pausable, ReentrancyGuard)
- **Ethers.js**: ^6.x
- **Chai**: ^4.x (for testing)

## 🔒 Security Features

1. **Slippage Protection** - Every swap enforces minimum output amount
2. **Input Validation** - All parameters validated before execution
3. **Non-Custodial** - Contract never holds user funds after transactions
4. **Atomic Execution** - All-or-nothing transaction semantics
5. **Access Control** - Critical functions protected with `onlyOwner`
6. **Emergency Pause** - Owner can pause contract in emergencies
7. **ReentrancyGuard** - Protection against reentrancy attacks
8. **Fee Cap** - Maximum 1% fee enforced at contract level
9. **Token Whitelist** - Optional security layer for token restrictions

### Audit Status

⚠️ **Not yet audited** - This is a testnet/development version. Do not use in production without proper security audit.

## 🎯 Production Considerations

Before mainnet deployment:

1. ✅ **Security Audit** - Engage professional auditors
2. ✅ **FX Engine Integration** - Replace mock with real StableFX or DEX
3. ✅ **Permit2 Support** - Implement gasless approvals (if using StableFX)
4. ✅ **Multi-sig Ownership** - Use multi-sig wallet for owner functions
5. ✅ **Rate Limiting** - Consider adding per-user limits
6. ✅ **Monitoring** - Setup event monitoring and alerts
7. ✅ **Insurance** - Consider insurance/safety modules

## 🚀 Advanced Features Roadmap

- [ ] Multi-hop routing for better rates
- [ ] Batch payment support (multiple recipients)
- [ ] CCTP integration for cross-chain payments
- [ ] Time-weighted average price (TWAP) integration
- [ ] Permit2 native support (gasless approvals)
- [ ] Advanced slippage calculation algorithms
- [ ] Payment scheduling/recurring payments
- [ ] Referral/affiliate system

## 🤝 Integration with StableFX

WizPay is designed to work with ARC's native StableFX engine. To integrate:

### Option 1: Direct Integration (Recommended for Production)

Replace `MockFXEngine` with actual StableFX contract:

```solidity
// Deploy WizPay with StableFX Escrow
const wizPay = await WizPay.deploy(
  "0x1f91886C7028986aD885ffCee0e40b75C9cd5aC1", // StableFX Escrow
  feeCollector,
  feeBps
);
```

### Option 2: Adapter Pattern

Create an adapter contract that implements `IFXEngine` and wraps StableFX's RFQ flow:

```solidity
contract StableFXAdapter is IFXEngine {
    IStableFX public stableFX;
    
    function swap(...) external override returns (uint256) {
        // Implement RFQ flow with StableFX
        // Handle Permit2 approvals
        // Return actual amount received
    }
}
```

## 📊 Gas Optimization

WizPay is optimized for ARC's ~$0.01 target transaction cost:

| Operation | Gas Usage | Cost @ 160 Gwei | Notes |
|-----------|-----------|-----------------|-------|
| Deploy WizPay | 2,074,444 | One-time | Includes all features |
| routeAndPay | 130k - 158k | ~$0.01 | Depends on token transfers |
| updateFee | 31,014 | <$0.01 | Admin function |
| pause/unpause | ~23k | <$0.01 | Emergency function |

## 🐛 Troubleshooting

### Common Issues

**1. "Insufficient USDC for gas fees"**
```bash
# Solution: Get testnet USDC from faucet
Visit: https://faucet.circle.com
Select: Arc Testnet
Request: USDC (used for gas on ARC)
```

**2. "WizPay: tokenIn not whitelisted"**
```bash
# Solution: Disable whitelist or add token
await wizPay.setWhitelistEnabled(false);
# OR
await wizPay.setTokenWhitelist(tokenAddress, true);
```

**3. "Slippage tolerance exceeded"**
```bash
# Solution: Increase minAmountOut tolerance
const minOut = (estimatedAmount * 95n) / 100n; // 5% slippage
```

**4. "Contract is paused"**
```bash
# Solution: Unpause contract (owner only)
await wizPay.unpause();
```

## 📚 Additional Resources

- **ARC Network Docs**: https://docs.arc.network
- **StableFX Docs**: https://developers.circle.com/stablefx
- **ARC Explorer**: https://testnet.arcscan.app
- **Circle Faucet**: https://faucet.circle.com
- **Permit2 Docs**: https://docs.uniswap.org/contracts/permit2/overview

## 🙏 Acknowledgments

Built on ARC Network by Circle with:
- OpenZeppelin secure contract libraries
- Hardhat development environment
- Uniswap Permit2 standard

## License

MIT

## Contact

Built for the ARC Layer-1 blockchain by Circle.
