---
title: "Core Concepts"
description: "Batch, execution, settlement, and orchestration primitives."
---

# Core Concepts

WizPay operates on four primitives: **batch**, **execution**, **settlement**, and **orchestration**. Every payment flow in the system reduces to these concepts.

## Batch

A batch is a set of payment instructions grouped into a single processing unit.

- The frontend composes a list of recipients (address, amount, token).
- The backend validates the list and splits it into `TaskUnit` records — one per batch.
- Each unit is processed independently. A task with 3 batches produces 3 units.

Batching is not optional. Even a single-recipient payment creates one unit. The system always operates in batch mode.

**Data shape:**

```
TaskUnit {
  type: "batch" | "step"
  index: 0
  status: "PENDING" | "SUCCESS" | "FAILED"
  payload: { recipients, sourceToken, totalAmount }
}
```

## Execution

Execution is the process of converting a `TaskUnit` into one or more on-chain transactions.

- The orchestrator picks up a queued task and routes it to an **agent** (Payroll, Swap, Bridge, FX, Liquidity).
- The agent calls the appropriate **adapter** (Circle API, viem, Solana) to submit the transaction.
- For async operations (payroll), each submitted transfer is tracked as a `TaskTransaction` record and polled separately.

Execution is **not synchronous by default**. Payroll tasks submit transfers and return immediately. Settlement is confirmed asynchronously via the `tx_poll` queue.

## Settlement

Settlement is the on-chain confirmation that a transaction has been included in a block and reached a terminal state.

Two settlement models exist:

| Model | Used By | Behavior |
|---|---|---|
| **Sync** | Swap, Bridge, FX, Liquidity | Agent blocks until the operation completes. Task is marked `executed` or `failed` immediately. |
| **Async** | Payroll | Agent submits all transfers, enqueues poll jobs, and returns. `TransactionPollerService` confirms each tx individually. Task finalizes when all transactions reach a terminal state. |

Terminal states for a `TaskTransaction`:

- `completed` — On-chain confirmation received, `txHash` populated.
- `failed` — Transfer rejected or timed out, `errorReason` populated.

## Orchestration

The orchestration layer is the coordination logic between HTTP ingestion, queue dispatch, agent execution, and state persistence.

**Key components:**

- `OrchestratorService` — The single entry point. Exposes `handleTask()` (called by HTTP) and `executeTask()` (called by workers). No other component creates or executes tasks.
- `ExecutionRouterService` — Checks `walletMode` (W3S vs PASSKEY) and dispatches to the correct execution engine.
- `AgentRouterService` — Dispatches to the type-specific agent (`PayrollAgent`, `BridgeAgent`, etc.).
- `QueueService` — Enqueue-only. Never processes jobs.

**Architectural invariant:** Workers never call agents directly. The call chain is always:

```
Worker → Processor → OrchestratorService.executeTask() → ExecutionRouter → Agent
```

This ensures all execution passes through the orchestrator's idempotency guard, logging, and error handling.
