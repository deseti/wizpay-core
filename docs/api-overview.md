# API Overview

All endpoints are served by the NestJS backend. The nginx reverse proxy routes `/api/*` to the backend.

---

## Task Endpoints (`/tasks`)

### `POST /tasks`

Create and enqueue a new task for execution.

**Request body:**
```json
{
  "type": "payroll" | "swap" | "bridge" | "liquidity" | "fx",
  "payload": { ... }
}
```

**Behavior:**
- Validates via `CreateTaskDto` (class-validator, whitelist mode)
- Calls `OrchestratorService.handleTask(type, payload)`
- Creates task record, transitions to `assigned`, enqueues to BullMQ
- Returns the full task object with current status and logs

**Response:** `{ data: TaskDetails }`

---

### `GET /tasks`

List tasks with optional filters.

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `type` | string | Filter by task type (`payroll`, `swap`, `bridge`, `liquidity`, `fx`) |
| `status` | string | Filter by status (`executed`, `failed`, `in_progress`, etc.) |
| `wallet` | string | Filter by wallet/recipient address (searches metadata and payload JSON) |
| `limit` | number | Max results (default: 50, max: 200) |
| `offset` | number | Pagination offset (default: 0) |

**Response:** `{ data: { items: TaskDetails[], total: number } }`

---

### `GET /tasks/:id`

Get a single task by ID. Used by the frontend to poll task progress.

**Parameters:** `id` — UUID of the task

**Response:** `{ data: TaskDetails }`

Includes:
- Task status and metadata
- All `TaskLog` entries (chronological)
- All `TaskUnit` records with individual statuses
- All `TaskTransaction` records with tx hashes

---

### `POST /tasks/payroll/init`

Validate and batch a payroll run before execution. Frontend calls this to preview the execution plan.

**Request body:**
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

**Behavior:**
- Validates recipients via `PayrollValidationService`
- Splits into batches via `PayrollBatchService`
- Creates task with `TaskUnit` records (one per batch)
- Returns the plan without enqueuing for execution

**Response:**
```json
{
  "data": {
    "taskId": "uuid",
    "approvalAmount": "5000",
    "referenceId": "PAY-001",
    "totalUnits": 2,
    "units": [
      { "id": "uuid", "index": 0, "status": "PENDING", "payload": { ... } }
    ]
  }
}
```

---

### `POST /tasks/swap/init`

Create a swap task.

**Request body:**
```json
{
  "tokenIn": "USDC",
  "tokenOut": "WETH",
  "amountIn": "100",
  "minAmountOut": "0.05",
  "recipient": "0x..."
}
```

**Response:**
```json
{
  "data": {
    "taskId": "uuid",
    "unitId": "uuid",
    "referenceId": "SWAP-1714762800000",
    "tokenIn": "USDC",
    "tokenOut": "WETH",
    "amountIn": "100",
    "minAmountOut": "0.05",
    "recipient": "0x..."
  }
}
```

---

### `POST /tasks/liquidity/init`

Create a liquidity task.

**Request body:**
```json
{
  "operation": "add" | "remove",
  "token": "USDC",
  "amount": "1000"
}
```

**Response:**
```json
{
  "data": {
    "taskId": "uuid",
    "unitId": "uuid",
    "operation": "add",
    "token": "USDC",
    "amount": "1000"
  }
}
```

---

### `POST /tasks/:taskId/units/:unitId/report`

Report the result of a single task unit. Used by the frontend in Passkey mode after client-side execution.

**Request body:**
```json
{
  "status": "SUCCESS" | "FAILED",
  "txHash": "0x...",
  "error": "optional error message"
}
```

**Behavior:**
- Updates the unit's status
- Increments `completedUnits` or `failedUnits` on the task
- Recomputes overall task status
- Returns updated task + unit + next pending unit (if any)

---

### `POST /tasks/fx/quote`

Get an FX quote for a stablecoin conversion.

**Request body:**
```json
{
  "sourceCurrency": "USDC",
  "targetCurrency": "EURC",
  "sourceAmount": "1000",
  "recipientAddress": "0x..."
}
```

**Response:** `{ data: <Circle quote object> }`

---

### `POST /tasks/fx/execute`

Execute an FX trade using a previously obtained quote.

**Request body:**
```json
{
  "quoteId": "...",
  "signature": "...",
  "senderAddress": "0x..."
}
```

**Behavior:** Creates a task of type `fx` and enqueues it. The `FxAgent` submits the trade to Circle and polls until settled.

---

## Wallet Endpoints (`/wallets`)

### `POST /wallets/initialize`

Create a wallet set and provision wallets for a user via Circle W3S.

**Request body:**
```json
{
  "userToken": "circle-user-token",
  "email": "user@example.com",
  "userId": "user-id"
}
```

---

### `POST /wallets/sync`

Sync existing wallet data from Circle for a user session.

**Request body:** Same as `/wallets/initialize`

---

### `POST /wallets/ensure`

Get or create a wallet for a specific chain type.

**Request body:**
```json
{
  "userToken": "circle-user-token",
  "email": "user@example.com",
  "userId": "user-id",
  "chain": "EVM" | "SOLANA"
}
```

---

## Treasury Endpoints (`/treasury`)

### `POST /treasury/init`

Initialize the application treasury wallet via Circle.

**Response:**
```json
{
  "data": {
    "success": true,
    "walletSetId": "...",
    "walletId": "..."
  }
}
```

### `GET /treasury/wallet`

Get the treasury wallet for a specific blockchain.

**Query parameters:** `blockchain` — Chain identifier (e.g., `ETH-SEPOLIA`)

**Response:** `{ data: <wallet object> }`
