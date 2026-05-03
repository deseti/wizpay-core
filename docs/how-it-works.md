# How WizPay Works

This document describes the end-to-end flow from user action to on-chain settlement.

---

## Step-by-Step Flow

### 1. User Creates Payments (Frontend)

The user composes a payment in the frontend UI. Depending on the operation type:

- **Payroll** — The user adds recipients (address + amount + optional target token), selects a source token, and submits. The frontend calls `POST /tasks/payroll/init` to validate and batch the recipients.
- **Swap** — The user selects tokenIn, tokenOut, amount, and recipient. The frontend calls `POST /tasks/swap/init`.
- **Bridge** — The user selects source chain, destination chain, amount, and destination address. The frontend calls `POST /tasks` with `type: "bridge"`.
- **FX** — The user gets a quote via `POST /tasks/fx/quote`, signs it, then submits via `POST /tasks/fx/execute`.
- **Liquidity** — The user selects add/remove, token, and amount. The frontend calls `POST /tasks/liquidity/init`.

At this stage, no on-chain transaction has occurred.

### 2. Backend Validates and Creates a Task

The backend receives the HTTP request at the `TaskController`. Depending on the route:

- **Init endpoints** (`/payroll/init`, `/swap/init`, `/liquidity/init`) create the task directly via `TaskService` with pre-built `TaskUnit` records and return the task plan to the frontend for confirmation.
- **Generic endpoint** (`POST /tasks`) passes the payload through `OrchestratorService.handleTask()`, which:
  1. Looks up the queue route in `TASK_QUEUE_MAP`
  2. Calls `TaskService.createTask()` — inserts a `Task` row with status `created`
  3. Transitions the task to `assigned`
  4. Enqueues a job to the appropriate BullMQ queue

**Task record created in PostgreSQL:**
```
Task {
  id: uuid,
  type: "payroll" | "swap" | "bridge" | "liquidity" | "fx",
  status: "created",
  totalUnits: N,
  completedUnits: 0,
  failedUnits: 0,
  metadata: { ... },
  payload: { ... }
}
```

### 3. Task is Enqueued (QueueService → BullMQ)

`QueueService.enqueueTask()` adds a job to the correct BullMQ queue:

| Task Type | Queue | Notes |
|-----------|-------|-------|
| `payroll` | `payroll` | Dedicated queue, concurrency=5 |
| `swap` | `swap` | Shared with liquidity and FX |
| `bridge` | `bridge` | Dedicated queue, 5s backoff |
| `liquidity` | `swap` | Shares the swap queue |
| `fx` | `swap` | Shares the swap queue |

Job configuration:
- **Attempts:** 3
- **Backoff:** Exponential (1s base, 5s for bridge)
- **Cleanup:** `removeOnComplete: 100`, `removeOnFail: 500`

A `TaskLog` entry is written: `queue.enqueued`.

### 4. Worker Picks Up the Job

Each queue has a dedicated `Worker` class (e.g., `PayrollWorker`, `SwapWorker`, `BridgeWorker`) that bootstraps a BullMQ `Worker` instance on module init. When a job arrives:

1. The **Worker** calls its associated **Processor** (e.g., `PayrollProcessor`)
2. The **Processor** calls `OrchestratorService.executeTask(taskId)`
3. The **Orchestrator** performs an idempotency check — only `assigned` tasks proceed
4. The task transitions to `in_progress`

```
Worker → Processor → OrchestratorService.executeTask()
```

Workers never call agents directly. This is a hard architectural contract.

### 5. Execution Router Dispatches to Agent or Engine

`OrchestratorService.executeTask()` calls `routeToAgent()`, which delegates to `ExecutionRouterService.execute()`. The router checks the task's `walletMode`:

- **`W3S` (default)** → `AgentRouterService.execute()` → dispatches to the type-specific agent:
  - `PayrollAgent` — iterates batches, calls `CircleService.transfer()` per recipient, enqueues poll jobs
  - `SwapAgent` — delegates to swap execution
  - `BridgeAgent` — calls `CircleBridgeService.initiateBridge()` for CCTP
  - `FxAgent` — calls `CircleService.executeTrade()` and polls until settled
  - `LiquidityAgent` — handles add/remove liquidity

- **`PASSKEY`** → `PasskeyEngineService.execute()`:
  - **Bridge** — records a CCTP intent; client signs and submits
  - **Payroll (EVM)** — submits ERC-20 transfers via backend treasury key
  - **Payroll (Solana)** — builds unsigned SPL transfer intents for client signing
  - **Swap** — prepares swap payload via `DexService`

### 6. On-Chain Settlement

What happens on-chain depends on the agent:

#### Payroll (W3S — Async)
1. Agent iterates over `TaskUnit` batches
2. For each recipient, calls `CircleService.transfer()` — this submits a Circle developer-controlled wallet transaction
3. After each submission, `QueueService.enqueueTransactionPoll()` adds a job to the `tx_poll` queue
4. `TransactionPollerService` polls Circle for each transaction's status
5. When all transactions reach a terminal state (`completed` or `failed`), the task is finalized

#### Bridge (W3S — Sync)
1. `BridgeAgent` calls `CircleBridgeService.initiateBridge()`
2. The Bridge Kit executes a CCTP burn on the source chain
3. Circle attestation service attests the burn
4. Mint occurs on the destination chain
5. Agent returns the full transfer result; orchestrator marks task `executed`

#### Bridge (External Signer)
1. `BridgeAgent` records the intent without calling Circle Bridge Kit
2. Returns parameters (source chain, destination chain, amount, addresses) to the frontend
3. Frontend executes CCTP burn+mint client-side via the user's wallet

#### Swap / FX / Liquidity (Sync)
1. Agent completes execution (or polls until terminal for FX)
2. Returns result to orchestrator
3. Orchestrator marks task `executed` immediately

### 7. Task Finalization

After agent execution returns:

- **Sync tasks** (swap, bridge, FX, liquidity): Orchestrator calls `TaskService.updateStatus(taskId, EXECUTED)` immediately.
- **Async tasks** (payroll): Task stays `in_progress`. The `TransactionPollerService` finalizes when `getTransactionAggregation()` reports `allTerminal: true`. Final status is computed as:
  - All completed → `executed`
  - All failed → `failed`
  - Mixed → `partial`

### 8. Frontend Polls for Completion

The frontend polls `GET /tasks/:id` to track progress. The response includes:
- Current task status
- All `TaskLog` entries (ordered by creation time)
- All `TaskUnit` records with their individual statuses
- All `TaskTransaction` records with tx hashes and poll attempts

The frontend renders progress based on this data.

---

## Sequence Diagram (Payroll Example)

```
Frontend                TaskController       OrchestratorService       QueueService        PayrollWorker       PayrollAgent        TransactionPoller
   |                         |                       |                      |                    |                   |                     |
   |-- POST /payroll/init -->|                       |                      |                    |                   |                     |
   |<-- task plan -----------|                       |                      |                    |                   |                     |
   |                         |                       |                      |                    |                   |                     |
   |-- POST /tasks --------->|-- handleTask() ------>|                      |                    |                   |                     |
   |                         |                       |-- createTask() ----->|                    |                   |                     |
   |                         |                       |-- enqueueTask() ---->|                    |                   |                     |
   |<-- { taskId, status } --|                       |                      |                    |                   |                     |
   |                         |                       |                      |-- job arrives ---->|                   |                     |
   |                         |                       |                      |                    |-- executeTask() ->|                     |
   |                         |                       |                      |                    |                   |-- transfer() ------->|
   |                         |                       |                      |                    |                   |-- enqueuePoll() ---->|
   |                         |                       |                      |                    |                   |                     |-- pollTx()
   |                         |                       |                      |                    |                   |                     |-- finalize()
   |-- GET /tasks/:id ------>|                       |                      |                    |                   |                     |
   |<-- { status: executed } |                       |                      |                    |                   |                     |
```
