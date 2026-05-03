# Execution Flow

This document describes the task lifecycle, synchronous vs asynchronous execution patterns, and queue/worker behavior.

---

## Task Lifecycle

Every task progresses through a state machine with strict transition rules.

### Status Values

| Status | Description |
|--------|-------------|
| `created` | Task record exists in PostgreSQL. No processing has begun. |
| `assigned` | Task has been routed to a queue. Waiting for a worker to pick it up. |
| `in_progress` | Worker has picked up the job. Agent is executing. |
| `review` | At least one unit has failed. Requires manual review or automatic resolution. |
| `approved` | Review completed (if applicable). Ready for finalization. |
| `executed` | All units completed successfully. Terminal state. |
| `partial` | Some units succeeded, some failed. Terminal state. |
| `failed` | Task-level failure. Terminal state. |

### Allowed Transitions

```
created     → assigned, failed
assigned    → in_progress, failed
in_progress → review, executed, partial, failed
review      → approved, failed
approved    → executed, failed
executed    → (terminal)
partial     → (terminal)
failed      → (terminal)
```

These transitions are enforced by `TaskService.ensureTransition()`. Any attempt to perform an invalid transition throws a `BadRequestException`.

### Typical Happy Path

```
created → assigned → in_progress → executed
```

### Payroll with Failures

```
created → assigned → in_progress → review → (manual) → approved → executed
```
Or if failures are unrecoverable:
```
created → assigned → in_progress → partial
```

---

## Sync vs Async Execution

The orchestrator uses two finalization strategies determined by task type.

### Synchronous Tasks (Swap, Bridge, FX, Liquidity)

The agent blocks until the operation completes (or fails). The orchestrator marks the task as `executed` or throws, which triggers `failed`.

```
OrchestratorService.executeTask()
  ├── updateStatus(IN_PROGRESS)
  ├── routeToAgent(task) ← blocks until complete
  ├── updateStatus(EXECUTED)
  └── return result
```

For FX tasks specifically, the `FxAgent` polls `CircleService.getTradeStatus()` in a loop (up to 60 attempts, 3s interval by default) until the trade reaches `settled` or `failed`.

### Asynchronous Tasks (Payroll)

The agent submits all transfers and immediately returns. Transaction results are polled separately.

```
OrchestratorService.executeTask()
  ├── updateStatus(IN_PROGRESS)
  ├── routeToAgent(task) ← submits transfers, enqueues poll jobs, returns
  ├── logStep("task.submissions_complete", IN_PROGRESS)
  └── task stays IN_PROGRESS
```

Finalization happens later via the `tx_poll` queue:

```
TransactionPollerService
  ├── polls Circle API for each submitted tx
  ├── updates TaskTransaction records
  ├── when all tx terminal → checks aggregation
  │   ├── all completed → updateStatus(EXECUTED)
  │   ├── all failed → updateStatus(FAILED)
  │   └── mixed → updateStatus(PARTIAL)
```

---

## Queue and Worker Behavior

### Queue Architecture

WizPay uses BullMQ backed by Redis. Four queues exist:

| Queue | Consumers | Purpose |
|-------|-----------|---------|
| `payroll` | `PayrollWorker` (concurrency=5) | Payroll batch execution |
| `swap` | `SwapWorker` | Swap, FX, and Liquidity execution |
| `bridge` | `BridgeWorker` | CCTP bridge execution |
| `tx_poll` | `TxPollWorker` | Transaction status polling |

### Worker Lifecycle

Each worker is a NestJS `@Injectable()` that implements `OnModuleInit` and `OnModuleDestroy`:

1. **Startup** (`onModuleInit`) — Creates a BullMQ `Worker` instance connected to Redis, registers event handlers for `error`, `failed`, `completed`.
2. **Processing** — Worker calls its associated `Processor` class, which delegates to `OrchestratorService.executeTask()`.
3. **Shutdown** (`onModuleDestroy`) — Calls `worker.close()` for graceful drain.

### Job Configuration

Task execution jobs:
- **Attempts:** 3
- **Backoff:** Exponential, 1s base (5s for bridge)
- **Cleanup:** `removeOnComplete: 100`, `removeOnFail: 500`

Transaction poll jobs:
- **Attempts:** 1 (poller manages its own re-enqueue logic)
- **Delay:** 2s initial, then increasing based on attempt count
- **Cleanup:** `removeOnComplete: 200`, `removeOnFail: 500`

### Idempotency

`OrchestratorService.executeTask()` includes an idempotency guard:

```typescript
if (task.status !== TaskStatus.ASSIGNED) {
  // Skip — already processed or in progress
  return null;
}
```

This makes worker retries safe. If BullMQ retries a job that already executed, the idempotency check short-circuits without re-executing.

### Error Handling in Workers

When an agent throws:
1. Orchestrator catches the error
2. Task is marked `failed` (best-effort — if status update also fails, a log entry is written instead)
3. Error is re-thrown to BullMQ so the job is registered as failed and the retry policy applies

Worker event handlers log permanent failures separately from transient retries.

### Transaction Polling Flow

For async tasks (payroll), each submitted transfer gets a poll job:

```
PayrollAgent
  ├── CircleService.transfer(recipient)
  ├── TaskService.appendTransaction(txId)
  └── QueueService.enqueueTransactionPoll({ taskId, txId, attempt: 0 })
```

The `TransactionPollerService` processes each poll job:

1. Fetch tx status from Circle API
2. If `completed` → update TaskTransaction status, check if all terminal → finalize task
3. If `failed` → update TaskTransaction, log error, check finalization
4. If still `pending` → increment attempt counter, re-enqueue with delay
5. If max attempts exceeded → mark tx as failed, check finalization
