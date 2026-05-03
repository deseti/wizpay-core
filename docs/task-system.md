# Task System

This document describes the data model, state management, logging, and error handling of the WizPay task system.

---

## Data Model

The task system persists four entity types in PostgreSQL via Prisma ORM.

### Task

The root entity representing a single execution request.

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key, auto-generated |
| `type` | string | One of: `payroll`, `swap`, `bridge`, `liquidity`, `fx` |
| `status` | string | Current lifecycle state (see status enum below) |
| `totalUnits` | number | Total number of units in this task |
| `completedUnits` | number | Units that reported `SUCCESS` |
| `failedUnits` | number | Units that reported `FAILED` |
| `metadata` | JSON | Normalized task parameters (used for filtering and display) |
| `payload` | JSON | Raw payload as submitted by the caller |
| `result` | JSON | Execution result (populated on completion) |
| `createdAt` | DateTime | Record creation time |
| `updatedAt` | DateTime | Last modification time |

**Relations:** A task has many `TaskLog`, `TaskUnit`, and `TaskTransaction` records.

### TaskUnit

Represents a discrete unit of work within a task. For payroll, each unit is a batch of recipients. For swap/liquidity, there is typically one unit of type `step`.

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `taskId` | UUID | Parent task reference |
| `type` | string | `batch` (payroll) or `step` (swap, liquidity) |
| `index` | number | Order within the task (0-indexed) |
| `status` | string | `PENDING`, `SUCCESS`, or `FAILED` |
| `txHash` | string? | On-chain transaction hash (populated on success) |
| `error` | string? | Error message (populated on failure) |
| `payload` | JSON | Unit-specific data (recipients, amounts, tokens) |
| `createdAt` | DateTime | Record creation time |
| `updatedAt` | DateTime | Last modification time |

### TaskTransaction

Tracks individual on-chain transactions submitted during task execution. Primarily used for payroll (one record per Circle transfer call).

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `taskId` | UUID | Parent task reference |
| `txId` | string | Circle transaction ID |
| `recipient` | string | Destination address |
| `amount` | string | Transfer amount |
| `currency` | string | Token symbol |
| `status` | string | `pending`, `completed`, or `failed` |
| `txHash` | string? | On-chain tx hash (populated when confirmed) |
| `errorReason` | string? | Failure reason |
| `batchIndex` | number | Which batch this tx belongs to |
| `pollAttempts` | number | How many times the poller checked this tx |
| `createdAt` | DateTime | Record creation time |
| `updatedAt` | DateTime | Last modification time |

### TaskLog

Append-only audit log. Every state transition and significant event is recorded.

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `taskId` | UUID | Parent task reference |
| `level` | string | `INFO` or `ERROR` |
| `step` | string | Machine-readable step identifier (e.g., `task.created`, `bridge.completed`) |
| `status` | string | Task status at the time of logging |
| `message` | string | Human-readable description |
| `context` | JSON? | Structured contextual data |
| `createdAt` | DateTime | Entry timestamp |

---

## Task Status Enum

```typescript
enum TaskStatus {
  CREATED     = 'created',
  ASSIGNED    = 'assigned',
  IN_PROGRESS = 'in_progress',
  REVIEW      = 'review',
  APPROVED    = 'approved',
  EXECUTED    = 'executed',
  PARTIAL     = 'partial',   // Some units succeeded, some failed
  FAILED      = 'failed',
}
```

### Transition Rules

```
CREATED     → ASSIGNED | FAILED
ASSIGNED    → IN_PROGRESS | FAILED
IN_PROGRESS → REVIEW | EXECUTED | PARTIAL | FAILED
REVIEW      → APPROVED | FAILED
APPROVED    → EXECUTED | FAILED
EXECUTED    → (terminal)
PARTIAL     → (terminal)
FAILED      → (terminal)
```

Transitions are enforced in code. The `updateStatus()` method calls `ensureTransition()`, which throws `BadRequestException` on invalid transitions. Idempotent calls (same status) are silently accepted.

---

## Task Type Enum

```typescript
enum TaskType {
  PAYROLL   = 'payroll',
  SWAP      = 'swap',
  BRIDGE    = 'bridge',
  LIQUIDITY = 'liquidity',
  FX        = 'fx',
}
```

---

## Logging

### How Logging Works

Every significant event writes a `TaskLog` entry via `TaskLogService.logStep()`:

```typescript
await this.taskService.logStep(
  taskId,
  'bridge.submitting',        // step identifier
  'in_progress',              // status at time of log
  'Submitting bridge 100 USDC from ETH-SEPOLIA to SOLANA-DEVNET.',
  {
    context: {                 // optional structured data
      bridgeExecutionMode: 'app_treasury',
      walletId: '...',
    },
  },
);
```

### Common Step Identifiers

| Step | When |
|------|------|
| `task.created` | Task record inserted |
| `task.assigned` | Task routed to queue |
| `queue.enqueued` | Job added to BullMQ |
| `task.in_progress` | Worker picked up the job |
| `task.executed` | Sync task completed |
| `task.failed` | Task failed |
| `task.submissions_complete` | Async task: all transfers submitted |
| `bridge.submitting` | Bridge agent starting |
| `bridge.completed` | Bridge transfer finished |
| `bridge.external_signer` | External signer intent recorded |
| `fx.trade.submitting` | FX trade being submitted |
| `fx.trade.settled` | FX trade completed |
| `passkey.bridge.intent_recorded` | Passkey bridge intent stored |
| `passkey.payroll.start` | Passkey payroll starting |
| `unit.reported` | A TaskUnit result was reported |

### Duplicate Prevention

`TaskLogService.hasLogStep(taskId, step)` checks if a specific step has already been logged. This is used by processors and pollers to prevent duplicate log entries on retries.

---

## Error Handling

### Task-Level Errors

When an agent throws during `OrchestratorService.executeTask()`:

1. The error is caught
2. `TaskService.updateStatus(taskId, FAILED)` is called with the error message
3. If the status update itself fails, a `TaskLog` entry is written as a fallback
4. The original error is re-thrown to BullMQ so the job is marked failed and the retry policy applies

```typescript
try {
  await this.routeToAgent(task);
} catch (error) {
  // Best-effort status update
  try {
    await this.taskService.updateStatus(taskId, TaskStatus.FAILED, { ... });
  } catch (statusError) {
    await this.taskService.logStep(taskId, 'task.failed.log', ...);
  }
  throw error; // Re-throw for BullMQ retry
}
```

### Unit-Level Errors

When a `TaskUnit` is reported as `FAILED` via `TaskUnitService.reportUnit()`:

1. The unit's status is updated to `FAILED`
2. The task's `failedUnits` counter is incremented
3. The task's overall status is recomputed:
   - If `failedUnits > 0` → status becomes `review`
   - If `completedUnits === totalUnits` → status becomes `executed`
   - Otherwise → stays `in_progress`
4. A `TaskLog` entry is written at `ERROR` level

### Transaction-Level Errors

When a `TaskTransaction` poll fails:

1. `TransactionPollerService` updates the transaction's `status` to `failed` and records the `errorReason`
2. It checks `getTransactionAggregation(taskId)` to see if all transactions are terminal
3. If all terminal: the task is finalized based on the mix of completed/failed transactions

---

## Partial vs Full Success

The `TaskUnitService.recomputeTaskStatus()` function determines the overall task outcome:

```typescript
recomputeTaskStatus(task): TaskStatus {
  if (task.failedUnits > 0) {
    return TaskStatus.REVIEW;    // Has failures — needs review
  }
  if (task.totalUnits > 0 && task.completedUnits === task.totalUnits) {
    return TaskStatus.EXECUTED;  // All units succeeded
  }
  return TaskStatus.IN_PROGRESS; // Still processing
}
```

For async tasks (payroll), the `TransactionPollerService` uses `getTransactionAggregation()`:

| Condition | Final Status |
|-----------|-------------|
| All transactions `completed` | `executed` |
| All transactions `failed` | `failed` |
| Mix of `completed` and `failed` | `partial` |
| Any `pending` remaining | Task stays `in_progress` |

The `partial` status is a terminal state. It indicates that the task partially succeeded and some payments need manual intervention or retry.

---

## Service Decomposition

The task module is split into focused services:

| Service | Responsibility |
|---------|---------------|
| `TaskService` | Facade — CRUD, status transitions, delegates to sub-services |
| `TaskUnitService` | Unit reporting, status recomputation |
| `TaskTransactionService` | Transaction record CRUD, aggregation queries |
| `TaskLogService` | Audit log write + duplicate check |
| `TaskMapperService` | Prisma model → domain object mapping |

All persistence goes through Prisma. Multi-step operations (e.g., `reportUnit`) use Prisma interactive transactions (`$transaction`) for atomicity.
