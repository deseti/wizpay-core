---
title: "App Wallet Treasury-Mediated Swap Phase 2"
description: "Design proposal for same-chain App Wallet swap execution on Arc Testnet."
---

# App Wallet Treasury-Mediated Swap Phase 2

## Purpose

This document specifies the Phase 2 design for Circle App Wallet same-chain treasury-mediated swap on Arc Testnet.

Phase 1 introduced a disabled scaffold for App Wallet swap quote preview and operation creation. Phase 2 should define the execution design before any real transfer, treasury swap, payout, or refund code is enabled.

The design keeps the existing External Wallet SwapKit flow unchanged. Circle App Wallet / User-Controlled Wallet direct SwapKit execution remains unsupported and disabled because the direct SwapKit contract execution path is not documented for this wallet mode.

## Non-Goals

- No bridge changes.
- No direct User-Controlled Wallet SwapKit execution.
- No production enablement of real funds in this phase.
- No execution endpoint implementation that moves funds.
- No changes to the existing External Wallet SwapKit path.
- No reuse or import of bridge internals.
- No payout, refund, or treasury swap submission until refund handling and operational review paths are implemented.

## Required End-to-End Flow

1. User App Wallet deposits USDC to the Arc treasury.
2. Backend confirms the deposit using transaction hash/status and treasury balance delta.
3. Backend revalidates the quote before treasury execution.
4. Treasury executes USDC -> EURC swap on Arc.
5. Treasury pays EURC back to the user's App Wallet.
6. UI shows `settled` only after the payout transaction hash is confirmed.

## Critical Invariants

| Invariant | Enforcement Point |
|---|---|
| Never start treasury swap before user deposit is confirmed. | Operation state machine, backend execution guard, persisted deposit receipt fields. |
| Never treat Circle challenge status alone as on-chain success. | Deposit confirmation and payout confirmation require on-chain tx status plus expected token balance movement. |
| Never show settled without payout transaction hash. | `settled` requires confirmed payout tx hash and persisted payout receipt. |
| Quote must expire and be revalidated before treasury swap. | Treasury execution preflight must fetch a fresh quote and compare minimum output/slippage policy. |
| Refund path must exist before enabling real user funds. | Runtime execution flag remains disabled until refund endpoints, manual review state, and operator runbook exist. |
| Bridge code must remain untouched. | New module boundaries under `app-wallet-swap`; no bridge imports or shared bridge routes. |
| External Wallet SwapKit path must remain unchanged. | `/swap` external wallet branch continues to use existing user-swap prepare and adapter execution. |

## Architecture Boundary

Phase 2 should be implemented as a dedicated App Wallet swap domain:

| Layer | Proposed Boundary |
|---|---|
| Backend module | `apps/backend/src/app-wallet-swap/` |
| Frontend API client | `apps/frontend/lib/app-wallet-swap-service.ts` |
| UI entry point | Existing `/swap` App Wallet branch only |
| Persistence | New persisted App Wallet swap operation model |
| Treasury execution | Dedicated App Wallet swap treasury service, not bridge service |
| Status polling | Dedicated App Wallet swap status endpoints |

The bridge implementation remains independent. Shared low-level utilities such as generic address validation or token metadata may be reused only if they are not bridge-specific and do not couple App Wallet swap state to bridge state.

## State Machine

### Success States

| State | Meaning | Required Evidence |
|---|---|---|
| `quoted` | Backend returned a treasury-mediated quote preview. | Quote payload, expiry, treasury deposit address. |
| `awaiting_user_deposit` | Operation exists and is waiting for user USDC deposit. | Persisted operation id, expected deposit amount, user wallet, treasury deposit address. |
| `deposit_submitted` | User submitted a deposit tx hash for the operation. | User-provided or Circle-returned deposit tx hash. |
| `deposit_confirmed` | Backend confirmed deposit on-chain. | Confirmed tx status, token transfer details, treasury USDC balance delta. |
| `treasury_liquidity_checked` | Backend verified enough treasury EURC or executable route/liquidity. | Liquidity check result, route or balance snapshot. |
| `treasury_swap_submitted` | Treasury submitted USDC -> EURC swap. | Treasury swap tx hash. |
| `treasury_swap_confirmed` | Treasury swap confirmed on-chain. | Confirmed swap tx hash, expected EURC received or treasury EURC balance delta. |
| `payout_submitted` | Treasury submitted EURC payout to user App Wallet. | Payout tx hash. |
| `settled` | User payout is confirmed. | Confirmed payout tx hash and recipient/token/amount match. |

### Failure and Refund States

| State | Meaning | Required Evidence |
|---|---|---|
| `deposit_failed` | Submitted deposit tx failed on-chain. | Failed tx receipt/status. |
| `deposit_unconfirmed` | Deposit tx was not confirmed before timeout or could not be matched. | Last poll status, attempt count, timeout timestamp. |
| `treasury_liquidity_insufficient` | Treasury cannot safely execute swap or payout. | Liquidity check failure, current treasury balance/route snapshot. |
| `swap_failed_refund_required` | Treasury swap failed after deposit confirmation; user must be refunded. | Failed swap tx hash or terminal provider error. |
| `refund_submitted` | Treasury submitted refund to user. | Refund tx hash. |
| `refunded` | Refund confirmed on-chain. | Confirmed refund tx hash and token/recipient/amount match. |
| `refund_failed_manual_review` | Refund submission or confirmation failed. | Failed refund details and manual review marker. |
| `payout_failed_manual_review` | Payout submission or confirmation failed after swap confirmation. | Failed payout details and manual review marker. |

### Allowed Transitions

| From | To | Trigger | Guard |
|---|---|---|---|
| `quoted` | `awaiting_user_deposit` | Operation creation. | Quote is unexpired and request matches quote. |
| `awaiting_user_deposit` | `deposit_submitted` | User submits deposit tx hash/status reference. | Tx hash format is valid and operation has no prior deposit tx. |
| `deposit_submitted` | `deposit_confirmed` | Deposit poller confirms tx and balance delta. | Tx sender/user, recipient/treasury, token/USDC, amount, chain, and balance delta match operation. |
| `deposit_submitted` | `deposit_failed` | Deposit poller sees failed terminal tx. | Terminal failed status is confirmed. |
| `deposit_submitted` | `deposit_unconfirmed` | Deposit confirmation timeout. | Max polling attempts or expiry reached without confirmed receipt and balance delta. |
| `deposit_confirmed` | `treasury_liquidity_checked` | Treasury preflight completes. | Fresh quote is valid, not expired, and liquidity/payout policy passes. |
| `deposit_confirmed` | `treasury_liquidity_insufficient` | Treasury preflight fails liquidity policy. | No safe route or insufficient treasury funds. |
| `treasury_liquidity_insufficient` | `refund_submitted` | Refund execution is submitted. | Refund path is enabled and refund amount is computed from confirmed deposit. |
| `treasury_liquidity_checked` | `treasury_swap_submitted` | Treasury submits swap tx. | Execution flag enabled, fresh quote accepted, idempotency lock acquired. |
| `treasury_swap_submitted` | `treasury_swap_confirmed` | Swap tx confirms. | Swap receipt and treasury EURC balance delta match expected policy. |
| `treasury_swap_submitted` | `swap_failed_refund_required` | Swap tx fails or times out terminally. | Failure is terminal after confirmed deposit. |
| `swap_failed_refund_required` | `refund_submitted` | Refund execution is submitted. | Refund path is enabled and operation is locked. |
| `refund_submitted` | `refunded` | Refund tx confirms. | Refund receipt matches user wallet, token, amount, and chain. |
| `refund_submitted` | `refund_failed_manual_review` | Refund tx fails or cannot be confirmed. | Terminal failure or manual escalation threshold reached. |
| `treasury_swap_confirmed` | `payout_submitted` | Treasury submits EURC payout. | Payout amount is derived from confirmed swap output and minimum output policy. |
| `payout_submitted` | `settled` | Payout tx confirms. | Payout receipt matches user wallet, EURC, amount, and tx hash. |
| `payout_submitted` | `payout_failed_manual_review` | Payout tx fails or cannot be confirmed. | Terminal failure or manual escalation threshold reached. |

No transition should skip confirmation states. In particular, `deposit_submitted -> treasury_swap_submitted`, `treasury_swap_submitted -> payout_submitted`, and `payout_submitted -> settled` are invalid.

## API Contract Proposal

All endpoints remain under `/app-wallet-swap`. Responses should use the existing backend wrapper shape:

```json
{ "data": { "...": "..." } }
```

### Quote Preview

`POST /app-wallet-swap/quote`

Purpose: return a quote preview and treasury deposit address. This exists in Phase 1 and remains read-only.

Request:

```json
{
  "chain": "ARC-TESTNET",
  "tokenIn": "USDC",
  "tokenOut": "EURC",
  "amountIn": "1000000",
  "fromAddress": "0xUserAppWallet"
}
```

Response:

```json
{
  "operationMode": "treasury-mediated",
  "sourceChain": "ARC-TESTNET",
  "tokenIn": "USDC",
  "tokenOut": "EURC",
  "amountIn": "1000000",
  "treasuryDepositAddress": "0xTreasury",
  "expectedOutput": "990000",
  "minimumOutput": "970200",
  "expiresAt": "2026-05-16T12:00:00.000Z",
  "status": "quoted",
  "quoteId": "provider-quote-id"
}
```

### Operation Creation

`POST /app-wallet-swap/operations`

Purpose: persist an operation in `awaiting_user_deposit`. It must not move funds.

Request:

```json
{
  "chain": "ARC-TESTNET",
  "tokenIn": "USDC",
  "tokenOut": "EURC",
  "amountIn": "1000000",
  "fromAddress": "0xUserAppWallet",
  "quoteId": "provider-quote-id"
}
```

Response:

```json
{
  "operationId": "uuid",
  "operationMode": "treasury-mediated",
  "sourceChain": "ARC-TESTNET",
  "status": "awaiting_user_deposit",
  "userWalletAddress": "0xUserAppWallet",
  "treasuryDepositAddress": "0xTreasury",
  "tokenIn": "USDC",
  "tokenOut": "EURC",
  "amountIn": "1000000",
  "expectedOutput": "990000",
  "minimumOutput": "970200",
  "expiresAt": "2026-05-16T12:00:00.000Z",
  "executionEnabled": false
}
```

### Deposit Submission

`POST /app-wallet-swap/operations/:id/deposit`

Purpose: attach the user deposit tx hash/reference to an operation and transition to `deposit_submitted`. The endpoint does not confirm settlement by itself.

Request:

```json
{
  "depositTxHash": "0x...",
  "circleTransactionId": "optional-circle-transaction-id",
  "circleReferenceId": "optional-circle-reference-id"
}
```

Response:

```json
{
  "operationId": "uuid",
  "status": "deposit_submitted",
  "depositTxHash": "0x...",
  "nextAction": "poll_deposit_confirmation"
}
```

Validation:

- Operation must be `awaiting_user_deposit`.
- Tx hash must be valid for Arc Testnet.
- Circle references may be stored for diagnostics, but cannot be treated as confirmation.

### Operation Status Polling

`GET /app-wallet-swap/operations/:id`

Purpose: return the canonical persisted operation status.

Response:

```json
{
  "operationId": "uuid",
  "status": "deposit_confirmed",
  "sourceChain": "ARC-TESTNET",
  "operationMode": "treasury-mediated",
  "userWalletAddress": "0xUserAppWallet",
  "treasuryDepositAddress": "0xTreasury",
  "tokenIn": "USDC",
  "tokenOut": "EURC",
  "amountIn": "1000000",
  "minimumOutput": "970200",
  "deposit": {
    "txHash": "0x...",
    "confirmedAt": "2026-05-16T12:01:00.000Z",
    "treasuryBalanceBefore": "10000000",
    "treasuryBalanceAfter": "11000000"
  },
  "treasurySwap": null,
  "payout": null,
  "refund": null,
  "manualReviewReason": null
}
```

The UI may display progress for intermediate states, but it must show settled only when `status === "settled"` and `payout.txHash` is present and confirmed.

### Deposit Confirmation Trigger

`POST /app-wallet-swap/operations/:id/confirm-deposit`

Purpose: request backend confirmation of the submitted deposit. This can be synchronous for Phase 2 testing or enqueue a dedicated poller in a later implementation.

Response success:

```json
{
  "operationId": "uuid",
  "status": "deposit_confirmed",
  "depositTxHash": "0x...",
  "confirmedAmount": "1000000"
}
```

Response unconfirmed:

```json
{
  "operationId": "uuid",
  "status": "deposit_unconfirmed",
  "reason": "Deposit transaction did not reach confirmed on-chain status before timeout."
}
```

### Future Treasury Execution

`POST /app-wallet-swap/operations/:id/execute-treasury-swap`

Purpose: future endpoint only. It must remain disabled unless `APP_WALLET_TREASURY_SWAP_EXECUTION_ENABLED=true`.

Required preconditions:

- Operation status is `deposit_confirmed`.
- Deposit tx hash is confirmed.
- Treasury balance delta has been recorded.
- Quote has been revalidated.
- Treasury liquidity check has passed.
- Refund path is implemented and enabled.
- Idempotency lock is acquired.

This endpoint must not exist or must return `APP_WALLET_TREASURY_SWAP_EXECUTION_DISABLED` until all preconditions and refund paths are implemented.

### Refund and Manual Review Paths

`POST /app-wallet-swap/operations/:id/refund`

Purpose: submit refund only from states where user funds were received but swap or payout cannot safely complete.

Allowed source states:

- `treasury_liquidity_insufficient`
- `swap_failed_refund_required`

Response:

```json
{
  "operationId": "uuid",
  "status": "refund_submitted",
  "refundTxHash": "0x..."
}
```

`POST /app-wallet-swap/operations/:id/manual-review`

Purpose: allow an operator to mark an operation for manual review without moving funds.

Request:

```json
{
  "reason": "Payout transaction failed after treasury swap confirmation.",
  "targetStatus": "payout_failed_manual_review"
}
```

Allowed target statuses:

- `refund_failed_manual_review`
- `payout_failed_manual_review`

## Data Model Proposal

Persist App Wallet swap operations separately from bridge operations. A Prisma model name such as `AppWalletSwapOperation` keeps the domain boundary explicit.

```prisma
model AppWalletSwapOperation {
  id                          String   @id @default(uuid())
  operationMode               String
  sourceChain                 String
  status                      String

  userWalletAddress           String
  treasuryDepositAddress      String

  tokenIn                     String
  tokenOut                    String
  amountIn                    String
  expectedOutput              String?
  minimumOutput               String?
  quoteId                     String?
  quoteExpiresAt              DateTime
  quoteRaw                    Json?

  depositTxHash               String?
  depositCircleTransactionId  String?
  depositCircleReferenceId    String?
  depositSubmittedAt          DateTime?
  depositConfirmedAt          DateTime?
  depositTreasuryBalanceBefore String?
  depositTreasuryBalanceAfter  String?
  depositConfirmedAmount      String?
  depositFailureReason        String?

  liquidityCheckedAt          DateTime?
  liquidityCheckRaw           Json?
  liquidityFailureReason      String?

  treasurySwapTxHash          String?
  treasurySwapSubmittedAt     DateTime?
  treasurySwapConfirmedAt     DateTime?
  treasurySwapFailureReason   String?
  treasurySwapRaw             Json?

  payoutTxHash                String?
  payoutSubmittedAt           DateTime?
  payoutConfirmedAt           DateTime?
  payoutAmount                String?
  payoutFailureReason         String?

  refundTxHash                String?
  refundSubmittedAt           DateTime?
  refundConfirmedAt           DateTime?
  refundAmount                String?
  refundFailureReason         String?

  manualReviewReason          String?
  idempotencyKey              String?

  createdAt                   DateTime @default(now())
  updatedAt                   DateTime @updatedAt

  @@index([status])
  @@index([userWalletAddress])
  @@index([depositTxHash])
  @@index([payoutTxHash])
  @@index([refundTxHash])
}
```

### Optional Audit Tables

If operation history needs finer-grained auditability, add append-only tables:

- `AppWalletSwapOperationEvent`: state transitions, actor, timestamp, metadata.
- `AppWalletSwapTransaction`: deposit, treasury swap, payout, and refund tx records.

These should be new App Wallet swap tables, not bridge tables.

## Confirmation Rules

### Deposit Confirmation

A deposit is confirmed only when all of the following are true:

- The deposit tx hash has a successful confirmed on-chain receipt/status.
- The transaction is on Arc Testnet.
- The user App Wallet is the sender or otherwise matches the expected transfer source.
- The treasury deposit address is the recipient.
- The token is USDC.
- The transfer amount is at least the expected `amountIn`.
- The treasury USDC balance delta matches the confirmed deposit amount or a stricter reconciliation rule.

Circle challenge state, Circle transaction reference, or frontend success callbacks are diagnostic only.

### Treasury Swap Confirmation

A treasury swap is confirmed only when:

- The treasury swap tx hash has a successful confirmed on-chain receipt/status.
- The treasury received enough EURC to satisfy the revalidated minimum output policy.
- The operation record stores the confirmed tx hash and observed balance delta or decoded swap output.

### Payout Settlement

An operation is settled only when:

- The payout tx hash has a successful confirmed on-chain receipt/status.
- The payout recipient is the user's App Wallet.
- The payout token is EURC.
- The payout amount matches the operation's settlement amount.
- `payout.txHash` is present in the API response.

## Quote Revalidation

Before treasury execution, the backend must fetch a fresh quote or route validation and compare it with the persisted operation:

- Token pair must remain USDC -> EURC.
- Input amount must match the confirmed deposit amount.
- Quote must not be expired.
- Minimum output must satisfy current product slippage policy.
- Execution must fail closed if provider quote, route, liquidity, or entitlement is unavailable.

If quote revalidation fails after a confirmed deposit, the operation must move to a refund-required path, not execute using stale pricing.

## Treasury Liquidity Check

Treasury liquidity checks belong in the App Wallet swap backend module or a dedicated treasury-domain service called by that module. They should not live in frontend code and should not be copied from bridge routes.

The check must verify:

- Treasury USDC deposit was received and is spendable.
- Treasury has enough gas/native balance for swap, payout, and refund contingency.
- Treasury can execute USDC -> EURC through the selected Arc Testnet route.
- Treasury can pay at least `minimumOutput` EURC to the user after swap.
- Refund capability is available before any real user funds are accepted.

## Frontend Flow Proposal

1. User selects Circle App Wallet mode on `/swap`.
2. UI shows: "Treasury-mediated App Wallet swap is experimental."
3. Preview quote calls `POST /app-wallet-swap/quote`.
4. Execution remains disabled until Phase 2 runtime is explicitly enabled in a later implementation.
5. Future enabled flow:
   - Create operation with `POST /app-wallet-swap/operations`.
   - Ask user to submit USDC deposit to the returned treasury deposit address.
   - Submit deposit hash with `POST /operations/:id/deposit`.
   - Poll `GET /operations/:id`.
   - Show progress using canonical operation state.
   - Show `settled` only when API status is `settled` and payout tx hash exists.
   - Show manual review or refund states explicitly when terminal failures occur.

## Test Plan Proposal

| Scenario | Setup | Expected Result |
|---|---|---|
| Success path | Valid quote, confirmed user USDC deposit, fresh quote, sufficient liquidity, successful treasury swap, successful payout. | Operation transitions through all success states to `settled`; UI shows final payout tx hash. |
| Quote expiry | Operation quote expires before treasury execution. | Backend revalidates quote; if no fresh valid quote exists, execution fails closed and moves to refund-required path after deposit confirmation. |
| Deposit unconfirmed | User submits tx hash that remains pending, missing, wrong chain, wrong token, wrong recipient, or no matching balance delta. | Operation moves to `deposit_unconfirmed`; no treasury swap starts. |
| Deposit failed | User submits failed deposit tx hash. | Operation moves to `deposit_failed`; no treasury swap or refund is submitted because funds were not received. |
| Insufficient treasury liquidity | Deposit confirmed, but treasury cannot satisfy liquidity, gas, route, or payout requirements. | Operation moves to `treasury_liquidity_insufficient`; refund path becomes required. |
| Swap failure requiring refund | Deposit confirmed and treasury swap submitted, but swap fails. | Operation moves to `swap_failed_refund_required`; refund may be submitted only through explicit refund path. |
| Refund success | Refund is submitted after liquidity or swap failure and confirms. | Operation moves `refund_submitted -> refunded`; refund tx hash is shown. |
| Refund failure | Refund submission fails or cannot be confirmed. | Operation moves to `refund_failed_manual_review`; operator review reason is recorded. |
| Payout failure | Treasury swap confirmed but payout fails or cannot be confirmed. | Operation moves to `payout_failed_manual_review`; UI does not show settled. |
| Challenge/reference only | Circle returns challenge or transaction reference without tx hash. | UI and backend do not treat it as confirmed; polling or manual review continues. |
| Idempotent duplicate calls | Deposit submission, confirmation, execution, payout, or refund endpoint is retried. | Operation remains in the correct state; no duplicate treasury swap, payout, or refund tx is submitted. |

## Enablement Checklist for Future Runtime Work

Runtime execution must stay disabled until all items are complete:

- Persisted operation model and migration are implemented.
- Deposit confirmation validates tx hash, token movement, and treasury balance delta.
- Quote revalidation is implemented.
- Treasury liquidity check is implemented.
- Treasury swap execution is implemented behind `APP_WALLET_TREASURY_SWAP_EXECUTION_ENABLED`.
- Payout execution and confirmation are implemented.
- Refund execution and confirmation are implemented.
- Manual review states and operator runbook are implemented.
- Idempotency locks prevent duplicate treasury swap, payout, and refund transactions.
- UI displays settled only with confirmed payout tx hash.
- External Wallet SwapKit regression tests remain green.
- Bridge files remain untouched.
