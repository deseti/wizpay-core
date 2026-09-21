---
title: "Execution Flow"
description: "Step-by-step request lifecycle from payload ingestion to on-chain settlement."
---

# Execution Flow

Every request follows the same pipeline: **Payload → Validation → Queue → Execution → Settlement**. The active configuration is strict Arc Mainnet-only and external-wallet-only.

## Step-by-Step

### 1. Payload Ingestion

The frontend submits a structured payload to one of the task endpoints:

| Endpoint                     | Task Type | Purpose                                 |
| ---------------------------- | --------- | --------------------------------------- |
| `POST /tasks`                | Any       | Generic task creation                   |
| `POST /tasks/payroll/init`   | Payroll   | Validate + batch before execution       |
| `POST /tasks/swap/init`      | Swap      | Disabled by default                     |
| `POST /tasks/liquidity/init` | Liquidity | Disabled by default                     |
| `POST /tasks/fx/execute`     | FX        | Disabled by default                     |

### 2. Validation

`TaskController` validates the request body using `class-validator` (whitelist mode, strict). Type-specific validation:

- **Payroll** — `PayrollValidationService` checks recipient addresses, amounts, token compatibility. Invalid entries reject the entire payload.
- **Bridge** — Bridge routes remain disabled for the initial Mainnet scope and fail closed before execution.
- **Swap** — Swap routes remain disabled by default and fail closed unless an authorized Mainnet route is configured.

Swap, liquidity, FX, and bridge endpoints fail closed by default. They must not fall back to synthetic pricing or internal reserves.

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

| Task Type   | Queue     | Backoff        |
| ----------- | --------- | -------------- |
| `payroll`   | `payroll` | 1s exponential |
| `swap`      | `swap`    | 1s exponential |
| `bridge`    | `bridge`  | 5s exponential |
| `liquidity` | `swap`    | 1s exponential |
| `fx`        | `swap`    | 1s exponential |

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

1. `ExecutionRouterService` — resolves the external-wallet execution path for Arc Mainnet.
2. `AgentRouterService` — dispatches to the type-specific agent.

The agent executes the domain operation and returns an `AgentExecutionResult`. The backend never holds signing keys; on-chain writes are signed and submitted by the connected external wallet.

### 8. Settlement

**Sync path** (swap, bridge, FX, liquidity — disabled by default):

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

| Condition       | Final Status |
| --------------- | ------------ |
| All `completed` | `executed`   |
| All `failed`    | `failed`     |
| Mixed           | `partial`    |

---

## End-to-End Example: Payroll

A company pays 50 employees in USDC on Arc Mainnet.

**1. Init** — Frontend calls `POST /tasks/payroll/init` with 50 recipients.

**2. Validation** — Backend validates all addresses and amounts. Splits into 2 batches of 25.

**3. Task Created** — Task with `totalUnits: 2`, two `TaskUnit` records (index 0, 1).

**4. Confirm** — Frontend calls `POST /tasks` with the full payload. Task transitions: `created → assigned → enqueued`.

**5. Worker** — `PayrollWorker` picks the job. Orchestrator marks `in_progress`.

**6. Agent** — `PayrollAgent` iterates batch 0 (25 recipients):

- For each: submit transfer through the external-wallet execution path → `TaskService.appendTransaction()` → `QueueService.enqueueTransactionPoll()`
- Then batch 1 (25 recipients): same flow.
- Agent returns. Task stays `in_progress`.

**7. Polling** — `TxPollWorker` processes 50 poll jobs over the next 30–120 seconds:

- Each job checks on-chain status.
- `completed` → update `TaskTransaction`, check if all terminal.
- Still pending → re-enqueue with delay.

**8. Finalization** — When all 50 transactions reach terminal state:

- 50/50 completed → task status: `executed`
- 48 completed, 2 failed → task status: `partial`

**9. Frontend** — Polls `GET /tasks/:id`. Renders final status with per-recipient tx hashes.

---

## Design Tradeoffs

### Why async settlement for payroll?

**Payroll** involves N independent transfers. Each transfer is a separate on-chain transaction with its own confirmation timeline. Blocking the worker for all N confirmations would hold the queue slot for minutes. Instead, the agent submits all transfers rapidly and delegates confirmation to the `tx_poll` queue. This keeps worker concurrency high.

### Why an idempotency guard instead of BullMQ's built-in deduplication?

BullMQ's `jobId`-based deduplication prevents duplicate _enqueue_, but does not prevent duplicate _execution_ after a crash-restart. If a worker crashes after marking a task `in_progress` but before completing execution, BullMQ retries the job. The idempotency guard (check `status === ASSIGNED`) ensures the task is not re-executed if it has already progressed past the assignment phase.

### Why route through OrchestratorService instead of calling agents directly from workers?

Centralized execution ensures:

- Every task passes through the same idempotency guard
- Every status transition is logged
- Error handling is uniform (best-effort status update + re-throw)
- Adding new execution paths requires changes in `ExecutionRouterService` only — not in every worker
