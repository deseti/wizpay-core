---
title: "Task System"
description: "State machine, data model, retry semantics, and failure handling."
---

# Task System

The task system is the persistence and state management layer for all payment operations. Every operation — payroll, swap, bridge, FX, liquidity — is represented as a `Task` with associated units, transactions, and logs.

## State Machine

### Statuses

| Status        | Terminal | Description                                       |
| ------------- | -------- | ------------------------------------------------- |
| `created`     | No       | Task record exists. No processing has begun.      |
| `assigned`    | No       | Routed to a queue. Awaiting worker pickup.        |
| `in_progress` | No       | Worker has picked up the job. Agent is executing. |
| `review`      | No       | At least one unit failed. Requires resolution.    |
| `approved`    | No       | Review completed. Ready for finalization.         |
| `executed`    | **Yes**  | All units completed.                              |
| `partial`     | **Yes**  | Some units succeeded, some failed.                |
| `failed`      | **Yes**  | Task-level failure.                               |

### Transition Rules

```
created     → assigned | failed
assigned    → in_progress | failed
in_progress → review | executed | partial | failed
review      → approved | failed
approved    → executed | failed
executed    → (terminal)
partial     → (terminal)
failed      → (terminal)
```

Invalid transitions throw `BadRequestException`. Same-status transitions are idempotent no-ops.

### Status Recomputation

After each `TaskUnit` report, `TaskUnitService.recomputeTaskStatus()` derives the next status:

```typescript
if (failedUnits > 0) return REVIEW;
if (completedUnits === totalUnits) return EXECUTED;
return IN_PROGRESS;
```

## Data Model

### Task

Root entity. One per execution request.

| Field            | Type   | Notes                                          |
| ---------------- | ------ | ---------------------------------------------- |
| `id`             | UUID   | Auto-generated                                 |
| `type`           | string | `payroll`, `swap`, `bridge`, `liquidity`, `fx` |
| `status`         | string | Current state machine position                 |
| `totalUnits`     | number | Total units in this task                       |
| `completedUnits` | number | Units that reported `SUCCESS`                  |
| `failedUnits`    | number | Units that reported `FAILED`                   |
| `metadata`       | JSON   | Normalized parameters (used for filtering)     |
| `payload`        | JSON   | Raw input as submitted                         |
| `result`         | JSON   | Execution result (populated on completion)     |

### TaskUnit

A discrete unit of work. For payroll: one batch of recipients. Legacy swap and
liquidity tasks are single-step records, but both paths are disabled by default
during the official StableFX cutover.

| Field     | Type    | Notes                          |
| --------- | ------- | ------------------------------ |
| `id`      | UUID    |                                |
| `taskId`  | UUID    | Parent reference               |
| `type`    | string  | `batch` or `step`              |
| `index`   | number  | Order within task (0-indexed)  |
| `status`  | string  | `PENDING`, `SUCCESS`, `FAILED` |
| `txHash`  | string? | Populated on success           |
| `error`   | string? | Populated on failure           |
| `payload` | JSON    | Unit-specific data             |

### TaskTransaction

Tracks individual on-chain transactions. One record per Circle `transfer()` call.

| Field          | Type    | Notes                            |
| -------------- | ------- | -------------------------------- |
| `id`           | UUID    |                                  |
| `taskId`       | UUID    | Parent reference                 |
| `txId`         | string  | Circle transaction ID            |
| `recipient`    | string  | Destination address              |
| `amount`       | string  | Transfer amount                  |
| `currency`     | string  | Token symbol                     |
| `status`       | string  | `pending`, `completed`, `failed` |
| `txHash`       | string? | On-chain hash (when confirmed)   |
| `errorReason`  | string? | Failure reason                   |
| `batchIndex`   | number  | Batch membership                 |
| `pollAttempts` | number  | Poll count                       |

### TaskLog

Append-only audit log. Every state transition and significant event produces a log entry.

| Field     | Type   | Notes                                                                  |
| --------- | ------ | ---------------------------------------------------------------------- |
| `id`      | UUID   |                                                                        |
| `taskId`  | UUID   | Parent reference                                                       |
| `level`   | string | `INFO` or `ERROR`                                                      |
| `step`    | string | Machine-readable identifier (e.g., `task.created`, `bridge.completed`) |
| `status`  | string | Task status at time of logging                                         |
| `message` | string | Human-readable description                                             |
| `context` | JSON?  | Structured contextual data                                             |

## Retry Semantics

### BullMQ Level

Task execution jobs:

- **3 attempts** with exponential backoff (1s base, 5s for bridge)
- On permanent failure: job marked failed, task status set to `failed`

Transaction poll jobs:

- **1 BullMQ attempt** — the poller manages its own re-enqueue logic
- Each poll checks Circle API, then either finalizes or re-enqueues with delay
- Maximum poll attempts enforced by `TransactionPollerService`

### Idempotency

`OrchestratorService.executeTask()` contains an idempotency guard:

```typescript
if (task.status !== TaskStatus.ASSIGNED) {
  return null; // already processed or in-progress
}
```

This means:

- If BullMQ retries a job that already executed, it is silently skipped.
- If the worker crashes after marking `in_progress`, the retry will also skip (status is no longer `assigned`). Manual intervention is required.

`TaskLogService.hasLogStep()` provides deduplication at the log level — processors check before writing duplicate log entries.

## Error Handling

### Task-Level Failure

When an agent throws during execution:

1. Orchestrator catches the error.
2. `TaskService.updateStatus(taskId, FAILED)` is called (best-effort).
3. If the status update itself fails, a `TaskLog` entry is written as fallback.
4. The original error is re-thrown to BullMQ for retry accounting.

### Unit-Level Failure

When a `TaskUnit` is reported as `FAILED`:

1. Unit status updated, `failedUnits` counter incremented.
2. Task status recomputed — typically transitions to `review`.
3. A `TaskLog` entry is written at `ERROR` level.

### Transaction-Level Failure

When a `TaskTransaction` poll returns `failed`:

1. Transaction record updated with `errorReason`.
2. `getTransactionAggregation()` checks if all transactions are terminal.
3. If all terminal: task finalized based on completed/failed ratio.

## Partial Success

The `partial` status is a **terminal state**. It indicates:

- At least one transfer succeeded (has a `txHash`).
- At least one transfer failed (has an `errorReason`).
- The task cannot be retried as a whole — individual failed transfers require manual intervention or a new task.

Aggregation logic:

| All completed | All failed | Mixed     | Any pending   |
| ------------- | ---------- | --------- | ------------- |
| `executed`    | `failed`   | `partial` | `in_progress` |
