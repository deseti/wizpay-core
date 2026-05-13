# StableFXAdapter_V2 Deployment Guide

Deterministic deployment and configuration workflow for `StableFXAdapter_V2`.  
This process is **isolated** from the WizPay deployment flow (`Deploy.s.sol`).

## Architecture

The deployment tooling is split into two isolated scripts:

| Script | Responsibility |
|--------|---------------|
| `DeployStableFXAdapterV2.s.sol` | Deterministic contract deployment only |
| `ConfigureStableFXAdapterV2.s.sol` | Post-deploy operational configuration |

This separation ensures:
- Deployment is minimal and auditable (no parsing, no state mutation beyond creation)
- Configuration is fail-fast with explicit validation
- Reduced deployment attack surface
- Each step can be dry-run and verified independently

---

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) installed (`forge`, `cast`)
- A funded deployer wallet (generate with `cast wallet new`)
- Access to the target RPC endpoint

---

## Environment Configuration

Create a dedicated env file for StableFXAdapter_V2 deployment:

```bash
cp .env.example .env.stablefx
```

> ⚠️ **NEVER commit `.env.stablefx` or expose your private key.** Add it to `.gitignore`.

### Deployment Variables (required)

```env
PRIVATE_KEY=0x...
INITIAL_OWNER=0x...
BASE_ASSET=0x3600000000000000000000000000000000000000
```

| Variable | Description | Example |
|----------|-------------|---------|
| `PRIVATE_KEY` | Deployer private key (0x-prefixed) | `0xac0974...` |
| `INITIAL_OWNER` | Contract owner address | `0xYourMultisig` |
| `BASE_ASSET` | Pool base accounting token (e.g. USDC) | `0x3600...0000` |

### Configuration Variables (optional, used by configure script)

```env
ADAPTER_ADDRESS=0x...  # Output from deploy step

TOKEN_1=0x3600000000000000000000000000000000000000
TOKEN_2=0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
TOKEN_3=
TOKEN_4=

RATE_TOKEN_A=0x3600000000000000000000000000000000000000
RATE_TOKEN_B=0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
RATE_A_TO_B=920000000000000000
RATE_B_TO_A=1087000000000000000
```

| Variable | Description |
|----------|-------------|
| `ADAPTER_ADDRESS` | Deployed adapter address (from deploy output) |
| `TOKEN_1` – `TOKEN_4` | Accepted token addresses to register |
| `RATE_TOKEN_A` | First token in exchange-rate pair |
| `RATE_TOKEN_B` | Second token in exchange-rate pair |
| `RATE_A_TO_B` | Rate A→B (18 decimals, e.g. `920000000000000000` = 0.92) |
| `RATE_B_TO_A` | Rate B→A (18 decimals, e.g. `1087000000000000000` = 1.087) |

---

## Step 1: Deployment

### Dry Run (Simulation Only)

```bash
forge script script/DeployStableFXAdapterV2.s.sol:DeployStableFXAdapterV2 \
  --rpc-url https://rpc.testnet.arc.network \
  --env-file .env.stablefx
```

### Local Deployment (Anvil)

```bash
# Terminal 1: Start Anvil
anvil

# Terminal 2: Deploy
forge script script/DeployStableFXAdapterV2.s.sol:DeployStableFXAdapterV2 \
  --rpc-url http://127.0.0.1:8545 \
  --broadcast \
  --env-file .env.stablefx
```

### Arc Testnet Deployment

```bash
forge script script/DeployStableFXAdapterV2.s.sol:DeployStableFXAdapterV2 \
  --rpc-url https://rpc.testnet.arc.network \
  --chain-id 5042002 \
  --broadcast \
  --verify \
  --env-file .env.stablefx
```

### Deployment Output

The script prints the deployed address:

```
=== StableFXAdapter_V2 Deployed ===
Address: 0x...
Owner: 0x...
Base Asset: 0x...
```

The address is also recorded in:
```
broadcast/DeployStableFXAdapterV2.s.sol/<CHAIN_ID>/run-latest.json
```

---

## Step 2: Post-Deployment Configuration

After deployment, set `ADAPTER_ADDRESS` in your env file, then run the configuration script.

### Dry Run

```bash
forge script script/ConfigureStableFXAdapterV2.s.sol:ConfigureStableFXAdapterV2 \
  --rpc-url https://rpc.testnet.arc.network \
  --env-file .env.stablefx
```

### Local Configuration (Anvil)

```bash
forge script script/ConfigureStableFXAdapterV2.s.sol:ConfigureStableFXAdapterV2 \
  --rpc-url http://127.0.0.1:8545 \
  --broadcast \
  --env-file .env.stablefx
```

### Arc Testnet Configuration

```bash
forge script script/ConfigureStableFXAdapterV2.s.sol:ConfigureStableFXAdapterV2 \
  --rpc-url https://rpc.testnet.arc.network \
  --chain-id 5042002 \
  --broadcast \
  --env-file .env.stablefx
```

### Configuration Behavior

- **Token registration**: Only tokens with non-zero addresses (`TOKEN_1`–`TOKEN_4`) are registered.
- **Exchange rates**: If any rate variable is set, all four (`RATE_TOKEN_A`, `RATE_TOKEN_B`, `RATE_A_TO_B`, `RATE_B_TO_A`) must be provided. The script reverts immediately if partial configuration is detected.
- **Fail-fast**: No silent skipping. Invalid or incomplete configuration causes a deterministic revert.

---

## Step 3: Post-Deploy Verification

### Verify on Block Explorer

```bash
forge verify-contract <DEPLOYED_ADDRESS> \
  src/StableFXAdapter_V2.sol:StableFXAdapter_V2 \
  --chain-id 5042002 \
  --constructor-args $(cast abi-encode "constructor(address,address)" <INITIAL_OWNER> <BASE_ASSET>) \
  --etherscan-api-key $ARCSCAN_API_KEY \
  --verifier-url https://testnet.arcscan.app/api
```

### Verify Deployment State

```bash
# Check owner
cast call <DEPLOYED_ADDRESS> "owner()(address)" \
  --rpc-url https://rpc.testnet.arc.network

# Check base asset
cast call <DEPLOYED_ADDRESS> "baseAsset()(address)" \
  --rpc-url https://rpc.testnet.arc.network
```

### Verify Configuration State

```bash
# Check accepted token
cast call <DEPLOYED_ADDRESS> "isAcceptedToken(address)(bool)" <TOKEN_ADDRESS> \
  --rpc-url https://rpc.testnet.arc.network

# Check exchange rate
cast call <DEPLOYED_ADDRESS> "getExchangeRate(address,address)(uint256)" <TOKEN_A> <TOKEN_B> \
  --rpc-url https://rpc.testnet.arc.network
```

### Verify LP Token Metadata

```bash
cast call <DEPLOYED_ADDRESS> "name()(string)" --rpc-url https://rpc.testnet.arc.network
# → "StableFX Liquidity Provider"

cast call <DEPLOYED_ADDRESS> "symbol()(string)" --rpc-url https://rpc.testnet.arc.network
# → "SFX-LP"

cast call <DEPLOYED_ADDRESS> "decimals()(uint8)" --rpc-url https://rpc.testnet.arc.network
# → 6
```

---

## Frontend / Backend Address Update Process

### 1. Record the Deployed Address

From the deployment output or broadcast JSON:
```
broadcast/DeployStableFXAdapterV2.s.sol/<CHAIN_ID>/run-latest.json
```

### 2. Update Frontend Configuration

```env
# packages/frontend/.env (or .env.local)
NEXT_PUBLIC_STABLEFX_ADAPTER_V2=<DEPLOYED_ADDRESS>
```

### 3. Update Backend / Indexer Configuration

```env
STABLEFX_ADAPTER_V2_ADDRESS=<DEPLOYED_ADDRESS>
```

### 4. Update ABI Artifacts

```bash
cp packages/contracts/out/StableFXAdapter_V2.sol/StableFXAdapter_V2.json \
   packages/frontend/src/abi/StableFXAdapter_V2.json
```

### 5. Verify Integration

- Confirm the frontend can read `owner()`, `baseAsset()`, and `getTVL()`.
- Confirm swap estimation works via `getEstimatedAmount()`.
- Test a small liquidity deposit on testnet before announcing.

---

## Manual Configuration (Alternative)

If you prefer individual `cast send` calls over the configuration script:

### Add Accepted Tokens

```bash
cast send <DEPLOYED_ADDRESS> "addAcceptedToken(address)" <TOKEN_ADDRESS> \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY
```

### Set Exchange Rates

```bash
# USDC → EURC
cast send <DEPLOYED_ADDRESS> "setExchangeRate(address,address,uint256)" \
  <USDC_ADDRESS> <EURC_ADDRESS> 920000000000000000 \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY

# EURC → USDC (reciprocal)
cast send <DEPLOYED_ADDRESS> "setExchangeRate(address,address,uint256)" \
  <EURC_ADDRESS> <USDC_ADDRESS> 1087000000000000000 \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY
```

> ⚠️ Rates must satisfy the reciprocal invariant: `rate_AB * rate_BA ≈ 1e18` (within 1% tolerance).

---

## Security Checklist

- [ ] Private key is NOT committed to version control
- [ ] `.env.stablefx` is in `.gitignore`
- [ ] `INITIAL_OWNER` is a multisig or secure EOA (not the deployer hot wallet for production)
- [ ] Deployment script contains no operational logic
- [ ] Configuration script validates all inputs before execution
- [ ] Exchange rates are sourced from a trusted oracle or manual review
- [ ] Contract is verified on the block explorer
- [ ] Downstream services updated with new address
- [ ] Testnet deployment validated before mainnet

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `RateNotConfigured` on swap | Run configure script with rate variables set |
| `TokenNotAccepted` | Run configure script with `TOKEN_N` variables set |
| `ReciprocalInvariantViolation` | Ensure `rate_AB * rate_BA` is within 1% of `1e18` |
| `RateDeviationExceeded` | New rate deviates >10% from previous; update incrementally |
| Configure script reverts on partial rate config | All four rate variables must be set together |
| Gas estimation fails | Ensure deployer has sufficient native token for gas |
