# StableFXAdapter_V2 — Arc Testnet Deployment Runbook

Generated from repository state. All commands are deterministic and assume:
- Working directory: `packages/contracts/`
- `.env.stablefx` exists with secrets populated
- Foundry toolchain available at `~/.foundry/bin/`
- Arc Testnet RPC: `https://rpc.testnet.arc.network` (chain ID: `5042002`)

---

## Current State

| Item | Value |
|------|-------|
| Old adapter address | `0x400d3935B904cbdB6B5eb2Fd50E6843f1b0AD8d6` |
| Base asset (USDC) | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| USYC | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` |
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |

---

## Phase 0: Environment Preparation

### .env.stablefx (required contents)

```env
# ─── Deployment ───────────────────────────────────────────────
PRIVATE_KEY=0x<YOUR_DEPLOYER_PRIVATE_KEY>
INITIAL_OWNER=<YOUR_OWNER_ADDRESS>
BASE_ASSET=0x3600000000000000000000000000000000000000

# ─── Configuration (fill ADAPTER_ADDRESS after deploy) ────────
ADAPTER_ADDRESS=
TOKEN_1=0x3600000000000000000000000000000000000000
TOKEN_2=0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
TOKEN_3=
TOKEN_4=
RATE_TOKEN_A=0x3600000000000000000000000000000000000000
RATE_TOKEN_B=0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
RATE_A_TO_B=920000000000000000
RATE_B_TO_A=1087000000000000000
```

---

## Phase 1: Pre-Flight Validation

### 1.1 Run contract tests

```bash
cd packages/contracts

forge test -vv
```

**Expected output:**
```
[PASS] testSwap_USDC_to_EURC() ...
[PASS] testSwap_EURC_to_USDC() ...
[PASS] testAddLiquidity() ...
[PASS] testRemoveLiquidity() ...
...
Test result: ok. X passed; 0 failed; ...
```

### 1.2 Verify deployer balance

```bash
cast balance <YOUR_DEPLOYER_ADDRESS> \
  --rpc-url https://rpc.testnet.arc.network
```

**Expected:** Non-zero balance (USDC is gas on Arc).

---

## Phase 2: Dry-Run Deployment (Simulation)

```bash
cd packages/contracts

forge script script/DeployStableFXAdapterV2.s.sol:DeployStableFXAdapterV2 \
  --rpc-url https://rpc.testnet.arc.network \
  --env-file .env.stablefx
```

**Expected output:**
```
== Logs ==
  === StableFXAdapter_V2 Deployed ===
  Address: 0x<SIMULATED_ADDRESS>
  Owner: <INITIAL_OWNER>
  Base Asset: 0x3600000000000000000000000000000000000000

Script ran successfully.

## Setting up 1 EVM.

==========================

Chain 5042002

Estimated gas price: ...
Estimated total gas used for script: ...
Estimated amount required: ...

==========================

SIMULATION COMPLETE. To broadcast these transactions, add --broadcast ...
```

**Validation:** Confirm `Owner` and `Base Asset` match your intended values. No errors.

---

## Phase 3: Broadcast Deployment to Arc Testnet

```bash
cd packages/contracts

forge script script/DeployStableFXAdapterV2.s.sol:DeployStableFXAdapterV2 \
  --rpc-url https://rpc.testnet.arc.network \
  --chain-id 5042002 \
  --broadcast \
  --verify \
  --env-file .env.stablefx
```

**Expected output:**
```
== Logs ==
  === StableFXAdapter_V2 Deployed ===
  Address: 0x<NEW_DEPLOYED_ADDRESS>
  Owner: <INITIAL_OWNER>
  Base Asset: 0x3600000000000000000000000000000000000000

...
✅ [Success] Hash: 0x<DEPLOYMENT_TX_HASH>
Contract Address: 0x<NEW_DEPLOYED_ADDRESS>
Block: ...
```

### Capture deployment artifacts

```bash
# View broadcast log
cat broadcast/DeployStableFXAdapterV2.s.sol/5042002/run-latest.json | jq '.transactions[0].hash, .transactions[0].contractAddress'
```

**Action:** Copy the deployed address and set it in `.env.stablefx`:
```bash
# Edit .env.stablefx and set:
# ADAPTER_ADDRESS=0x<NEW_DEPLOYED_ADDRESS>
```

---

## Phase 4: Configure Deployed Adapter

### 4.1 Dry-run configuration

```bash
cd packages/contracts

forge script script/ConfigureStableFXAdapterV2.s.sol:ConfigureStableFXAdapterV2 \
  --rpc-url https://rpc.testnet.arc.network \
  --env-file .env.stablefx
```

**Expected output:**
```
== Logs ==
  Accepted token added: 0x3600000000000000000000000000000000000000
  Accepted token added: 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
  Rate set: A -> B: 920000000000000000
  Rate set: B -> A: 1087000000000000000
  === Configuration Complete ===

SIMULATION COMPLETE. To broadcast these transactions, add --broadcast ...
```

### 4.2 Broadcast configuration

```bash
cd packages/contracts

forge script script/ConfigureStableFXAdapterV2.s.sol:ConfigureStableFXAdapterV2 \
  --rpc-url https://rpc.testnet.arc.network \
  --chain-id 5042002 \
  --broadcast \
  --env-file .env.stablefx
```

**Expected output:**
```
== Logs ==
  Accepted token added: 0x3600000000000000000000000000000000000000
  Accepted token added: 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
  Rate set: A -> B: 920000000000000000
  Rate set: B -> A: 1087000000000000000
  === Configuration Complete ===

...
✅ [Success] Hash: 0x<CONFIG_TX_1_HASH>
✅ [Success] Hash: 0x<CONFIG_TX_2_HASH>
✅ [Success] Hash: 0x<CONFIG_TX_3_HASH>
✅ [Success] Hash: 0x<CONFIG_TX_4_HASH>
```

### Capture configuration tx hashes

```bash
cat broadcast/ConfigureStableFXAdapterV2.s.sol/5042002/run-latest.json | jq '.transactions[].hash'
```

---

## Phase 5: Verify Deployment State

### 5.1 Verify owner

```bash
cast call <NEW_DEPLOYED_ADDRESS> "owner()(address)" \
  --rpc-url https://rpc.testnet.arc.network
```

**Expected:** `<INITIAL_OWNER>`

### 5.2 Verify base asset

```bash
cast call <NEW_DEPLOYED_ADDRESS> "baseAsset()(address)" \
  --rpc-url https://rpc.testnet.arc.network
```

**Expected:** `0x3600000000000000000000000000000000000000`

### 5.3 Verify accepted tokens

```bash
cast call <NEW_DEPLOYED_ADDRESS> "isAcceptedToken(address)(bool)" \
  0x3600000000000000000000000000000000000000 \
  --rpc-url https://rpc.testnet.arc.network
```

**Expected:** `true`

```bash
cast call <NEW_DEPLOYED_ADDRESS> "isAcceptedToken(address)(bool)" \
  0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a \
  --rpc-url https://rpc.testnet.arc.network
```

**Expected:** `true`

### 5.4 Verify exchange rates

```bash
# USDC → EURC
cast call <NEW_DEPLOYED_ADDRESS> "getExchangeRate(address,address)(uint256)" \
  0x3600000000000000000000000000000000000000 \
  0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a \
  --rpc-url https://rpc.testnet.arc.network
```

**Expected:** `920000000000000000` (0.92e18)

```bash
# EURC → USDC
cast call <NEW_DEPLOYED_ADDRESS> "getExchangeRate(address,address)(uint256)" \
  0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a \
  0x3600000000000000000000000000000000000000 \
  --rpc-url https://rpc.testnet.arc.network
```

**Expected:** `1087000000000000000` (1.087e18)

### 5.5 Verify LP token metadata

```bash
cast call <NEW_DEPLOYED_ADDRESS> "name()(string)" --rpc-url https://rpc.testnet.arc.network
# Expected: "StableFX Liquidity Provider"

cast call <NEW_DEPLOYED_ADDRESS> "symbol()(string)" --rpc-url https://rpc.testnet.arc.network
# Expected: "SFX-LP"

cast call <NEW_DEPLOYED_ADDRESS> "decimals()(uint8)" --rpc-url https://rpc.testnet.arc.network
# Expected: 6
```

### 5.6 Verify reciprocal invariant

```bash
# 920000000000000000 * 1087000000000000000 / 1e18 = 999,040,000,000,000,000
# Must be within [990000000000000000, 1010000000000000000] (1% tolerance)
# 0.99904e18 ✓ — within tolerance
```

### 5.7 Verify on block explorer

```bash
forge verify-contract <NEW_DEPLOYED_ADDRESS> \
  src/StableFXAdapter_V2.sol:StableFXAdapter_V2 \
  --chain-id 5042002 \
  --constructor-args $(cast abi-encode "constructor(address,address)" <INITIAL_OWNER> 0x3600000000000000000000000000000000000000) \
  --verifier-url https://testnet.arcscan.app/api \
  --etherscan-api-key ${ARCSCAN_API_KEY}
```

---

## Phase 6: Update Frontend/Backend References

### 6.1 Files to update

The **only** hardcoded reference to the old adapter address is:

| File | Variable | Old Value |
|------|----------|-----------|
| `apps/frontend/constants/addresses.ts` | `STABLE_FX_ADAPTER_V2_ADDRESS` | `0x400d3935B904cbdB6B5eb2Fd50E6843f1b0AD8d6` |

**No backend code references the on-chain adapter address directly.** The backend uses Circle's hosted StableFX REST API (`/v1/exchange/stablefx/`), which is independent of this deployment.

### 6.2 Update frontend constants

Edit `apps/frontend/constants/addresses.ts`:

```diff
 // ── V2 FX (custom StableFXAdapter_V2 vault) ──
 export const STABLE_FX_ADAPTER_V2_ADDRESS =
-  "0x400d3935B904cbdB6B5eb2Fd50E6843f1b0AD8d6" as Address;
+  "<NEW_DEPLOYED_ADDRESS>" as Address;
```

### 6.3 Optional: Add env-driven override

If you want the address configurable via environment (for future migrations), add to root `.env`:

```env
NEXT_PUBLIC_STABLEFX_ADAPTER_V2_ADDRESS=<NEW_DEPLOYED_ADDRESS>
```

And update `addresses.ts` to read from env:

```typescript
export const STABLE_FX_ADAPTER_V2_ADDRESS =
  (process.env.NEXT_PUBLIC_STABLEFX_ADAPTER_V2_ADDRESS?.trim() ||
    "<NEW_DEPLOYED_ADDRESS>") as Address;
```

### 6.4 Copy ABI artifact (if frontend consumes JSON ABI)

```bash
cp packages/contracts/out/StableFXAdapter_V2.sol/StableFXAdapter_V2.json \
   apps/frontend/constants/abi/StableFXAdapter_V2.json
```

### 6.5 Rebuild Docker stack

```bash
# From monorepo root
docker compose down
docker compose up --build -d
```

**Expected:** All services start healthy (frontend :3000, backend :4000, postgres, redis).

### 6.6 Verify Docker health

```bash
docker compose ps
```

**Expected:**
```
NAME              STATUS
wizpay-frontend   Up (healthy)
wizpay-backend    Up (healthy)
wizpay-postgres   Up (healthy)
wizpay-redis      Up
```

---

## Phase 7: Integration Validation

### 7.1 Contract-level tests

```bash
cd packages/contracts
forge test -vv
```

**Expected:** All tests pass. No modifications to test files required.

### 7.2 Frontend build validation

```bash
cd apps/frontend
npm run build
```

**Expected:** Build succeeds with no TypeScript errors related to addresses.

### 7.3 Backend startup validation

```bash
cd apps/backend
npm run build
```

**Expected:** NestJS compiles successfully. No references to the old adapter address exist in backend code.

### 7.4 On-chain flow validation (manual via cast)

**Deposit USDC → Redeem USDC (should work):**
```bash
# 1. Approve adapter to spend USDC
cast send 0x3600000000000000000000000000000000000000 \
  "approve(address,uint256)" <NEW_DEPLOYED_ADDRESS> 1000000 \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY

# 2. Add liquidity (USDC)
cast send <NEW_DEPLOYED_ADDRESS> \
  "addLiquidity(address,uint256)" 0x3600000000000000000000000000000000000000 1000000 \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY

# 3. Check LP balance
cast call <NEW_DEPLOYED_ADDRESS> "balanceOf(address)(uint256)" <YOUR_ADDRESS> \
  --rpc-url https://rpc.testnet.arc.network

# 4. Remove liquidity (same token = USDC)
cast send <NEW_DEPLOYED_ADDRESS> \
  "removeLiquidity(address,uint256)" 0x3600000000000000000000000000000000000000 <LP_SHARES> \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY
```

**Expected:** Deposit mints LP shares, redeem returns USDC proportionally.

**Deposit EURC → Redeem EURC (should work):**
```bash
# Same flow as above but with EURC address:
# 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
```

**Deposit USDC → Redeem EURC (should FAIL):**
```bash
# After depositing USDC, attempt to withdraw EURC
cast send <NEW_DEPLOYED_ADDRESS> \
  "removeLiquidity(address,uint256)" 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a <LP_SHARES> \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY
```

**Expected:** Reverts with `WrongRedemptionToken(0x3600...0000, 0x89B5...D72a)`

### 7.5 WizPay payroll flow (unchanged)

The WizPay router (`0x87ACE45582f45cC81AC1E627E875AE84cbd75946`) references its FX engine via `FX_ENGINE_ADDRESS` set at deploy time. **This deployment does NOT change the WizPay router's FX engine pointer.** Payroll execution continues to route through whatever engine was configured on the WizPay contract.

To verify payroll still works:
```bash
cast call 0x87ACE45582f45cC81AC1E627E875AE84cbd75946 "fxEngine()(address)" \
  --rpc-url https://rpc.testnet.arc.network
```

**Expected:** Returns the FX engine address currently configured on WizPay (may or may not be the new adapter — depends on whether you call `updateFXEngine` on WizPay separately).

---

## Phase 8: WizPay Router Migration (Optional)

If you want WizPay to route swaps through the **new** adapter:

```bash
cast send 0x87ACE45582f45cC81AC1E627E875AE84cbd75946 \
  "updateFXEngine(address)" <NEW_DEPLOYED_ADDRESS> \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $WIZPAY_OWNER_PRIVATE_KEY
```

> ⚠️ Only do this after all Phase 7 validations pass. This changes the live payroll routing path.

---

## Summary Checklist

| Step | Command | Status |
|------|---------|--------|
| Pre-flight tests | `forge test -vv` | ☐ |
| Dry-run deploy | `forge script ... (no --broadcast)` | ☐ |
| Broadcast deploy | `forge script ... --broadcast --verify` | ☐ |
| Record address | From broadcast JSON | ☐ |
| Dry-run configure | `forge script ConfigureStableFXAdapterV2 (no --broadcast)` | ☐ |
| Broadcast configure | `forge script ConfigureStableFXAdapterV2 --broadcast` | ☐ |
| Verify owner | `cast call ... "owner()"` | ☐ |
| Verify base asset | `cast call ... "baseAsset()"` | ☐ |
| Verify tokens | `cast call ... "isAcceptedToken()"` | ☐ |
| Verify rates | `cast call ... "getExchangeRate()"` | ☐ |
| Verify on explorer | `forge verify-contract ...` | ☐ |
| Update `addresses.ts` | Manual edit | ☐ |
| Rebuild Docker | `docker compose up --build` | ☐ |
| Frontend build | `npm run build` in frontend | ☐ |
| Backend build | `npm run build` in backend | ☐ |
| USDC deposit/redeem | `cast send ...` | ☐ |
| EURC deposit/redeem | `cast send ...` | ☐ |
| Cross-token redeem fails | `cast send ...` (expect revert) | ☐ |
| WizPay payroll unaffected | `cast call ... "fxEngine()"` | ☐ |

---

## Security Notes

- Private keys are read from `.env.stablefx` by Forge at runtime — never logged or printed
- No secrets appear in broadcast JSON (only addresses and tx hashes)
- The `NEXT_PUBLIC_USE_REAL_STABLEFX` flag is currently `false` — the frontend uses mock mode by default
- Backend payroll flow uses Circle's hosted REST API, not the on-chain adapter directly
- WizPay router's FX engine pointer is **not** changed by this deployment (requires separate `updateFXEngine` call)
