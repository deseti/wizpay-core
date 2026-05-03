# Wallet Modes

WizPay supports two wallet execution modes. The mode determines how transactions are signed and submitted on-chain.

---

## Mode Selection

The wallet mode is specified in the task payload as `walletMode`. The `ExecutionRouterService` reads this field and dispatches execution accordingly:

```typescript
// ExecutionRouterService.resolveWalletMode()
if (raw === 'PASSKEY') return 'PASSKEY';
return 'W3S';  // default for absent, null, or "W3S"
```

When `walletMode` is absent (which is the case for all tasks created before the field was introduced), the system defaults to `W3S`. This ensures full backward compatibility.

---

## W3S Mode (Circle Developer-Controlled Wallets)

### How It Works

W3S wallets are managed entirely by Circle's Wallet-as-a-Service API. The backend holds an API key and an entity secret that allows it to sign and submit transactions without user interaction at execution time.

**Authentication flow:**
1. User logs in (Google/Email) and receives a Circle `userToken` + `encryptionKey`
2. Frontend sends `userToken` to the backend with wallet operations
3. Backend uses `CircleService` to provision wallet sets, create wallets, and execute transfers

**Execution flow (e.g., Payroll):**
1. `ExecutionRouterService` dispatches to `AgentRouterService`
2. `AgentRouterService` dispatches to `PayrollAgent`
3. `PayrollAgent` calls `CircleService.transfer()` for each recipient
4. Circle API signs the transaction using the developer-controlled wallet
5. Transaction is submitted to the blockchain by Circle's infrastructure

### Key Characteristics

- **Backend signs** — The backend has authority to sign transactions via Circle's entity secret
- **No client-side signing** — The user does not need to approve each transaction individually
- **Session required** — A valid `userToken` from Circle is needed for wallet identification
- **Wallet provisioning** — Wallets are created via `WalletService.initializeWallets()` and `getOrCreateWallet()`
- **Supported chains** — EVM (ARC-TESTNET, ETH-SEPOLIA) and Solana (SOLANA-DEVNET)

### Wallet Endpoints (W3S)

| Endpoint | Purpose |
|----------|---------|
| `POST /wallets/initialize` | Create wallet set and wallets for a user |
| `POST /wallets/sync` | Sync existing wallets from Circle |
| `POST /wallets/ensure` | Get or create a wallet for a specific chain (EVM/SOLANA) |

### When Used

- Default mode for all tasks
- Used when the organization controls the wallets (e.g., corporate payroll from a company treasury)
- Used when the user authenticates via Google/Email through Circle's W3S flow

---

## Passkey Mode (Account Abstraction / Client Execution)

### How It Works

Passkey wallets use Circle's modular Account Abstraction (AA) infrastructure. The user authenticates with a WebAuthn passkey (biometric or hardware key). The wallet is controlled by the user's passkey — the backend has no signing authority.

**Execution flow:**
1. `ExecutionRouterService` dispatches to `PasskeyEngineService`
2. `PasskeyEngineService` handles execution differently per task type:

#### Bridge (Passkey)
- Backend records a CCTP bridge **intent** (does not execute the bridge)
- Returns all parameters needed for CCTP burn+mint to the frontend
- Frontend submits the CCTP transactions using the user's passkey-controlled AA wallet
- Result shape matches the W3S bridge flow, so frontend polling logic works unchanged

#### Payroll — EVM (Passkey)
- Backend submits ERC-20 transfers **from the backend treasury wallet** (using `BACKEND_PRIVATE_KEY`)
- Assumption: the company pre-funds the backend treasury, which distributes to recipients
- Individual transfer results (txHash, success/failure) are tracked and returned

#### Payroll — Solana (Passkey)
- Passkey AA wallets are **EVM-only** — they cannot sign Solana transactions
- Backend builds unsigned SPL transfer intents
- Returns the intents to the frontend for client-side signing via the user's Solana wallet
- Frontend must call `broadcastSolanaTransaction()` for each intent

#### Swap (Passkey)
- Backend prepares swap execution payload via `DexService.prepareSwapExecution()`
- Returns the payload to the frontend for client-side submission

### Key Characteristics

- **No Circle userToken/tokenId** — Passkey wallets do not use W3S session credentials
- **Client-side signing** — For bridge and Solana operations, the user must sign transactions
- **Backend treasury signing** — For EVM payroll, the backend signs using its private key
- **EVM-only AA** — Passkey AA wallets support ARC-TESTNET and ETH-SEPOLIA only
- **No `walletId` required** — Passkey wallets are not Circle developer-controlled, so no Circle walletId is needed

### When Used

- Used when the user authenticates with a passkey (biometric/hardware key)
- Used when the user wants direct control over their wallet
- Used for external wallet bridge operations (`bridgeExecutionMode: "external_signer"`)

---

## Comparison

| Aspect | W3S | Passkey |
|--------|-----|---------|
| Signing authority | Backend (via Circle entity secret) | User (via passkey) or backend treasury key |
| User interaction at execution | None | Depends on operation |
| Circle session | Required (`userToken`) | Not used |
| walletId | Required | Not required |
| Supported chains | EVM + Solana | EVM (AA) + Solana (client-sign) |
| Bridge execution | Backend calls Circle Bridge Kit | Frontend executes CCTP directly |
| Payroll execution | Circle `transfer()` API | Backend treasury (EVM) or unsigned intents (Solana) |
| Default | Yes | No (must be explicitly set) |

---

## Architectural Notes

- The `ExecutionRouterService` is the **only** place where wallet mode routing occurs. Agents and the orchestrator are unaware of wallet modes.
- Adding a new wallet mode requires: (1) extending the `WalletMode` type union in `task.types.ts`, (2) adding a case in `ExecutionRouterService`.
- The W3S agent pipeline (`AgentRouterService` → Agents) is completely untouched when a PASSKEY task is processed, and vice versa.
