---
title: "API & Integration Layer"
description: "HTTP endpoints, external system interfaces, and operational constraints."
---

# API & Integration Layer

All endpoints are served by the NestJS backend behind an Nginx reverse proxy (`/api` → backend).

## Task Endpoints

### `POST /tasks`

Create and enqueue a task for execution.

```json
{
  "type": "payroll" | "swap" | "bridge" | "liquidity" | "fx",
  "payload": { ... }
}
```

- Validated via `CreateTaskDto` (class-validator, whitelist, forbidNonWhitelisted).
- Calls `OrchestratorService.handleTask()`.
- Returns full `TaskDetails` with status and logs.

### `GET /tasks`

List tasks with filters.

| Param | Type | Default | Max |
|---|---|---|---|
| `type` | string | — | — |
| `status` | string | — | — |
| `wallet` | string | — | — |
| `limit` | number | 50 | 200 |
| `offset` | number | 0 | — |

The `wallet` filter searches across `metadata.walletAddress`, `metadata.recipient`, `metadata.destinationAddress`, `metadata.sourceAddress`, and their `payload` equivalents.

Returns `{ data: { items: TaskDetails[], total: number } }`.

### `GET /tasks/:id`

Poll a single task. Returns `TaskDetails` including:
- Status and metadata
- All `TaskLog` entries (chronological)
- All `TaskUnit` records with individual statuses
- All `TaskTransaction` records with tx hashes and poll attempts

### `POST /tasks/payroll/init`

Validate and batch a payroll run. Does **not** enqueue for execution.

```json
{
  "recipients": [{ "address": "0x...", "amount": "100", "targetToken": "USDC" }],
  "sourceToken": "USDC",
  "walletAddress": "0x...",
  "referenceId": "PAY-001"
}
```

Returns:
```json
{
  "taskId": "uuid",
  "approvalAmount": "5000",
  "referenceId": "PAY-001",
  "totalUnits": 2,
  "units": [{ "id": "uuid", "index": 0, "status": "PENDING", "payload": {} }]
}
```

### `POST /tasks/swap/init`

Create a swap task.

Required fields: `tokenIn`, `tokenOut`, `amountIn`, `recipient`.

### `POST /tasks/liquidity/init`

Create a liquidity task.

Required fields: `operation` (`add` | `remove`), `token`, `amount`.

### `POST /tasks/:taskId/units/:unitId/report`

Report the result of a single task unit. Used by the frontend after client-side execution (PASSKEY mode).

```json
{
  "status": "SUCCESS" | "FAILED",
  "txHash": "0x...",
  "error": "optional error message"
}
```

Atomically updates the unit, increments counters, recomputes task status, and returns the next pending unit (if any).

### `POST /tasks/fx/quote`

Get an FX quote. Required: `sourceCurrency`, `targetCurrency`, `sourceAmount`.

### `POST /tasks/fx/execute`

Execute an FX trade. Required: `quoteId`, `signature`, `senderAddress`.

## Wallet Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/wallets/initialize` | POST | Create wallet set + wallets via Circle W3S |
| `/wallets/sync` | POST | Sync existing wallets from Circle |
| `/wallets/ensure` | POST | Get or create wallet for chain (EVM/SOLANA) |

All require `userToken` in the request body.

## Treasury Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/treasury/init` | POST | Initialize app treasury wallet via Circle |
| `/treasury/wallet` | GET | Get treasury wallet for a blockchain |

## External System Interfaces

The backend communicates with these external systems:

| System | Adapter | Protocol | Operations |
|---|---|---|---|
| Circle W3S | `CircleService` | REST | Wallet provisioning, transfers, FX trades, tx status |
| Circle Bridge Kit | `CircleBridgeService` | SDK | CCTP burn+attest+mint |
| EVM RPCs | `BlockchainService` | JSON-RPC (viem) | ERC-20 transfers, contract calls |
| Solana RPC | `SolanaService` | JSON-RPC (@solana/web3.js) | SPL transfers, intent building |
| DEX protocols | `DexService` | Varies | Swap preparation |
| Telegram | `TelegramService` | REST | Task status notifications |

## Constraints

- **No direct frontend-to-chain calls in W3S mode.** All on-chain operations route through the backend.
- **No concurrent task execution for the same wallet.** BullMQ processes jobs sequentially per queue (except payroll at concurrency 5). No explicit wallet-level locking exists.
- **Circle rate limits apply.** The backend does not implement its own rate limiting against Circle APIs. High-throughput payroll runs may encounter Circle-side throttling.
- **USDC-only for bridge.** The CCTP bridge path only supports USDC. Non-USDC bridge requests are rejected at validation.
- **Passkey AA is EVM-only.** Solana operations in PASSKEY mode return unsigned intents. The backend cannot sign Solana transactions for passkey wallets.
- **No webhook ingestion.** Settlement confirmation relies on polling (tx_poll queue), not on-chain event subscriptions or Circle webhooks.
