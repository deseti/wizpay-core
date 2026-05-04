---
title: "Execution Flow"
description: "Step-by-step request lifecycle from payload ingestion to on-chain settlement."
---

# Execution Flow

Every request follows the same pipeline: **Payload → Validation → Queue → Execution → Settlement**.

## Step-by-Step

### 1. Payload Ingestion

The frontend submits a structured payload to one of the task endpoints:

| Endpoint | Task Type | Purpose |
|---|---|---|
| `POST /tasks` | Any | Generic task creation (bridge, generic) |
| `POST /tasks/payroll/init` | Payroll | Validate + batch before execution |
| `POST /tasks/swap/init` | Swap | Create swap task |
| `POST /tasks/liquidity/init` | Liquidity | Create liquidity task |
| `POST /tasks/fx/execute` | FX | Execute FX trade |

### 2. Validation

`TaskController` validates the request body using `class-validator` (whitelist mode, strict). Type-specific validation:

- **Payroll** — `PayrollValidationService` checks recipient addresses, amounts, token compatibility. Invalid entries reject the entire payload.
- **Bridge** — `OrchestratorService.normalizeBridgePayload()` validates chains, addresses, amounts. Rejects same-chain bridges, non-USDC tokens, and invalid execution modes.
- **Swap** — Requires `tokenIn`, `tokenOut`, `amountIn`, `recipient`.

### 3. Task Creation

`TaskService` inserts a `Task` row with status `created`:

```
Task {
  id:             uuid (auto)
  type:           "payroll" | "swap" | "bridge" | "liquidity" | "fx"
  status:         "created"
  totalUnits:     N
  completedUnits: 0
  failedUnits:    0
  metadata:       { normalized parameters }
  payload:        { raw input }
}
```

For payroll, `TaskUnit` records are created atomically in a Prisma `$transaction`.

### 4. Queue Dispatch

`OrchestratorService.handleTask()` transitions the task to `assigned` and enqueues a job:

```
QueueService.enqueueTask(route, {
  taskId, taskType, agentKey, payload
})
```

Queue routing is deterministic:

| Task Type | Queue | Backoff |
|---|---|---|
| `payroll` | `payroll` | 1s exponential |
| `swap` | `swap` | 1s exponential |
| `bridge` | `bridge` | 5s exponential |
| `liquidity` | `swap` | 1s exponential |
| `fx` | `swap` | 1s exponential |

All jobs: 3 attempts, `removeOnComplete: 100`, `removeOnFail: 500`.

### 5. Worker Pickup

A BullMQ `Worker` picks the job and calls its `Processor`:

```
Worker.process(job) → Processor.process(job) → OrchestratorService.executeTask(taskId)
```

### 6. Idempotency Guard

`executeTask()` checks current status:

```typescript
if (task.status !== TaskStatus.ASSIGNED) {
  return null; // skip — already processed
}
```

This makes BullMQ retries safe. Re-processing an already-completed task is a no-op.

### 7. Agent Execution

The orchestrator routes through two layers:

1. `ExecutionRouterService` — checks `walletMode`:
   - `W3S` (default) → `AgentRouterService`
   - `PASSKEY` → `PasskeyEngineService`

2. `AgentRouterService` — dispatches to the type-specific agent.

The agent executes the domain operation and returns an `AgentExecutionResult`.

### 8. Settlement

**Sync path** (swap, bridge, FX, liquidity):

```
Agent returns → OrchestratorService marks task EXECUTED
```

**Async path** (payroll):

```
Agent submits transfers → enqueues tx_poll jobs → returns
Task stays IN_PROGRESS
TransactionPollerService polls each tx → finalizes when all terminal
```

Finalization logic:

| Condition | Final Status |
|---|---|
| All `completed` | `executed` |
| All `failed` | `failed` |
| Mixed | `partial` |

---

## End-to-End Example: Payroll

A company pays 50 employees in USDC on ARC-TESTNET.

**1. Init** — Frontend calls `POST /tasks/payroll/init` with 50 recipients.

**2. Validation** — Backend validates all addresses and amounts. Splits into 2 batches of 25.

**3. Task Created** — Task with `totalUnits: 2`, two `TaskUnit` records (index 0, 1).

**4. Confirm** — Frontend calls `POST /tasks` with the full payload. Task transitions: `created → assigned → enqueued`.

**5. Worker** — `PayrollWorker` picks the job. Orchestrator marks `in_progress`.

**6. Agent** — `PayrollAgent` iterates batch 0 (25 recipients):
  - For each: `CircleService.transfer()` → `TaskService.appendTransaction()` → `QueueService.enqueueTransactionPoll()`
  - Then batch 1 (25 recipients): same flow.
  - Agent returns. Task stays `in_progress`.

**7. Polling** — `TxPollWorker` processes 50 poll jobs over the next 30–120 seconds:
  - Each job calls Circle API for tx status.
  - `completed` → update `TaskTransaction`, check if all terminal.
  - Still pending → re-enqueue with delay.

**8. Finalization** — When all 50 transactions reach terminal state:
  - 50/50 completed → task status: `executed`
  - 48 completed, 2 failed → task status: `partial`

**9. Frontend** — Polls `GET /tasks/:id`. Renders final status with per-recipient tx hashes.

---

## Failure Scenario: Bridge Timeout

A user bridges 100 USDC from ETH-SEPOLIA to SOLANA-DEVNET.

**1.** `POST /tasks` with `type: "bridge"`. Task created, assigned, enqueued to `bridge` queue.

**2.** `BridgeWorker` picks the job. `BridgeAgent` calls `CircleBridgeService.initiateBridge()`.

**3.** The CCTP burn transaction is submitted to Sepolia. Sepolia requires 65-block confirmation (~13 minutes).

**4.** The Bridge Kit's internal timeout (configured at 600s) expires before confirmation completes.

**5.** `CircleBridgeService` throws. The error propagates:
```
BridgeAgent.execute() throws
  → OrchestratorService catches
    → TaskService.updateStatus(taskId, FAILED)
    → Re-throws to BullMQ
```

**6.** BullMQ applies retry policy: attempt 2 with 5s backoff, then attempt 3 with 25s backoff.

**7.** If all 3 attempts fail, the job is permanently failed. Task remains `failed`.

**8.** The idempotency guard prevents double-execution: if attempt 2 somehow reaches a task already marked `in_progress`, it is skipped.

---

## Design Tradeoffs

### Why async settlement for payroll but not for bridge?

**Payroll** involves N independent transfers. Each transfer is a separate on-chain transaction with its own confirmation timeline. Blocking the worker for all N confirmations would hold the queue slot for minutes. Instead, the agent submits all transfers rapidly and delegates confirmation to the `tx_poll` queue. This keeps worker concurrency high.

**Bridge** is a single multi-step operation (burn → attest → mint). The Bridge Kit manages the step progression internally. There is no benefit to splitting it into separate poll jobs — the entire operation either succeeds or fails as a unit. Sync execution simplifies the result contract.

### Why an idempotency guard instead of BullMQ's built-in deduplication?

BullMQ's `jobId`-based deduplication prevents duplicate *enqueue*, but does not prevent duplicate *execution* after a crash-restart. If a worker crashes after marking a task `in_progress` but before completing execution, BullMQ retries the job. The idempotency guard (check `status === ASSIGNED`) ensures the task is not re-executed if it has already progressed past the assignment phase.

### Why route through OrchestratorService instead of calling agents directly from workers?

Centralized execution ensures:
- Every task passes through the same idempotency guard
- Every status transition is logged
- Error handling is uniform (best-effort status update + re-throw)
- Adding new wallet modes requires changes in `ExecutionRouterService` only — not in every worker
