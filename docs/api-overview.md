---
title: "API & Integration Layer"
description: "HTTP endpoints, external system interfaces, and operational constraints."
---

# API & Integration Layer

All endpoints are served by the NestJS backend behind an Nginx reverse proxy (`/api` → backend). The active configuration is strict Arc Mainnet-only and external-wallet-only.

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

| Param    | Type   | Default | Max |
| -------- | ------ | ------- | --- |
| `type`   | string | —       | —   |
| `status` | string | —       | —   |
| `wallet` | string | —       | —   |
| `limit`  | number | 50      | 200 |
| `offset` | number | 0       | —   |

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
  "recipients": [
    { "address": "0x...", "amount": "100", "targetToken": "USDC" }
  ],
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

Swap tasks are disabled by default. Execution fails closed unless an authorized Mainnet route is configured and enabled.

### `POST /tasks/liquidity/init`

Liquidity tasks are disabled by default. Execution fails closed unless an authorized Mainnet route is configured and enabled.

### `POST /tasks/:taskId/units/:unitId/report`

Report the result of a single task unit. Used by the frontend after client-side execution.

```json
{
  "status": "SUCCESS" | "FAILED",
  "txHash": "0x...",
  "error": "optional error message"
}
```

Atomically updates the unit, increments counters, recomputes task status, and returns the next pending unit (if any).

### `POST /tasks/fx/quote`

FX quote requests fail closed unless an authorized Mainnet quote source is configured and enabled.

### `POST /tasks/fx/execute`

FX execution fails closed unless an authorized Mainnet execution route is configured and enabled.

## Wallet Endpoints

Wallet provisioning is external-wallet-only on Arc Mainnet. The backend does not hold signing keys, does not sign on behalf of users, and does not custody user funds.

## Bridge Endpoints

Bridge routes remain disabled for the initial Mainnet scope. Any bridge request fails closed unless an authorized Mainnet route is configured and enabled.

## External System Interfaces

The backend communicates with these external systems:

| System         | Adapter                | Protocol             | Operations                                |
| -------------- | ---------------------- | -------------------- | ----------------------------------------- |
| EVM RPCs       | `BlockchainService`    | JSON-RPC (viem)      | ERC-20 transfers, contract calls          |
| DEX protocols  | `DexService`           | Varies               | Swap preparation (disabled by default)    |
| Telegram       | `TelegramService`      | REST                 | Task status notifications                 |

## Constraints

- **External-wallet-only.** All on-chain writes are signed and submitted by the connected external wallet. The backend never holds signing keys and never custodies funds.
- **Arc Mainnet-only.** Only the authorized Arc Mainnet network is accepted. Any other network selector is rejected before execution.
- **No concurrent task execution for the same wallet.** BullMQ processes jobs sequentially per queue (except payroll at concurrency 5). No explicit wallet-level locking exists.
- **USDC-only initial scope.** Only authorized same-token USDC routes are eligible. Cross-token, liquidity, swap, and bridge requests fail closed unless an authorized Mainnet route is configured and enabled.
- **No webhook ingestion.** Settlement confirmation relies on polling (tx_poll queue), not on-chain event subscriptions or provider webhooks.
