---
title: "Wallet Modes"
description: "Signing models: custodial W3S and client-controlled passkey."
---

# Wallet Modes

WizPay supports two signing models. The mode determines **who holds the signing key** and **where transaction construction happens**.

## Mode Selection

The wallet mode is read from `task.payload.walletMode` by `ExecutionRouterService`:

```typescript
if (walletMode === 'PASSKEY') → PasskeyEngineService
else → AgentRouterService  // default: W3S
```

When `walletMode` is absent (all tasks created before the field was introduced), the system defaults to `W3S`. Zero breaking changes.

## W3S (Custodial)

Circle Wallet-as-a-Service. The backend has signing authority.

**Signing model:**
- Backend holds a Circle API key and entity secret.
- The entity secret allows the backend to sign transactions on behalf of developer-controlled wallets.
- The user does not approve individual transactions.

**Flow:**
1. User authenticates (Google/Email) → receives Circle `userToken` + `encryptionKey`.
2. Frontend sends `userToken` to backend with each wallet operation.
3. Agent calls `CircleService.transfer()` → Circle signs and submits on-chain.

**Characteristics:**
- Backend signs. No client-side signing.
- `userToken` required for wallet identification.
- `walletId` required per operation.
- Supports EVM (ARC-TESTNET, ETH-SEPOLIA) and Solana (SOLANA-DEVNET).

**Wallet provisioning endpoints:**

| Endpoint | Purpose |
|---|---|
| `POST /wallets/initialize` | Create wallet set + wallets for a user |
| `POST /wallets/sync` | Sync existing wallets from Circle |
| `POST /wallets/ensure` | Get or create wallet for a chain (EVM/SOLANA) |

## PASSKEY (Client-Controlled)

Circle modular Account Abstraction wallet. The **user** holds the signing key.

**Signing model:**
- User authenticates with a WebAuthn passkey (biometric or hardware key).
- The backend has **no signing authority** over the user's wallet.
- For operations requiring the user's signature, the backend returns unsigned intents.

**Per-operation behavior:**

| Operation | Backend Action | Client Action |
|---|---|---|
| **Bridge** | Records CCTP intent, returns parameters | User signs and submits burn tx via AA wallet |
| **Payroll (EVM)** | Submits ERC-20 transfers from backend treasury (`BACKEND_PRIVATE_KEY`) | None — treasury pre-funded by company |
| **Payroll (Solana)** | Builds unsigned SPL transfer intents | User signs and broadcasts each intent |
| **Swap** | Prepares swap payload via `DexService` | User submits via AA wallet |

**Characteristics:**
- No Circle `userToken`, `tokenId`, or W3S session credentials.
- No `walletId` required.
- Passkey AA wallets are **EVM-only** (ARC-TESTNET, ETH-SEPOLIA).
- Solana operations require client-side signing.

## Comparison

| Aspect | W3S | PASSKEY |
|---|---|---|
| Key holder | Backend (Circle entity secret) | User (passkey) |
| Client signing | Never | Bridge, Solana payroll, swap |
| Circle session | Required (`userToken`) | Not used |
| `walletId` | Required | Not required |
| Chains | EVM + Solana | EVM (AA) + Solana (client-sign) |
| Bridge execution | Backend calls Circle Bridge Kit | Frontend executes CCTP directly |
| Payroll execution | `CircleService.transfer()` | Treasury key (EVM) / unsigned intents (Solana) |
| Default | Yes | Must be explicitly set |

## External Signer Bridge

External browser wallets are not a third `walletMode`. They are a bridge execution mode used when the source wallet is a connected EVM wallet or an injected Solana wallet.

- The browser executes the burn, attestation, and mint flow with public Circle bridge tooling.
- The backend still accepts a best-effort `POST /tasks` audit record for traceability.
- These audit tasks require `walletAddress` but do not require `walletId`.
- Solana support is provider-agnostic: any compatible injected Solana wallet can be used, not just Phantom.
- `NEXT_PUBLIC_CIRCLE_API_PROXY_ENABLED=true` enables the same-origin `/api/circle/proxy` fallback when the deployed Next.js runtime serves that route. When the flag is unset, bridge clients use direct Circle API requests only.

## Isolation

The `ExecutionRouterService` is the **only** component aware of wallet modes.

- Agents do not check `walletMode`. They receive tasks through the router and execute.
- The orchestrator does not check `walletMode`. It calls the execution router.
- Workers do not check `walletMode`. They call the orchestrator.

Adding a new wallet mode requires:
1. Extend the `WalletMode` type union in `task.types.ts`.
2. Add a case in `ExecutionRouterService.resolveWalletMode()`.
3. Implement the engine service.

No changes to agents, orchestrator, or workers.
