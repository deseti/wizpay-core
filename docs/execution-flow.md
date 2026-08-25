---
title: "Execution Flow"
description: "Step-by-step request lifecycle from payload ingestion to on-chain settlement."
---

# Execution Flow

Every request follows the same pipeline: **Payload → Validation → Queue → Execution → Settlement**.

## Step-by-Step

### 1. Payload Ingestion

The frontend submits a structured payload to one of the task endpoints:

| Endpoint                     | Task Type | Purpose                                 |
| ---------------------------- | --------- | --------------------------------------- |
| `POST /tasks`                | Any       | Generic task creation (bridge, generic) |
| `POST /tasks/payroll/init`   | Payroll   | Validate + batch before execution       |
| `POST /tasks/swap/init`      | Swap      | Legacy swap task, disabled by default   |
| `POST /tasks/liquidity/init` | Liquidity | Legacy LP task, disabled by default     |
| `POST /tasks/fx/execute`     | FX        | Execute FX trade                        |

### 2. Validation

`TaskController` validates the request body using `class-validator` (whitelist mode, strict). Type-specific validation:

- **Payroll** — `PayrollValidationService` checks recipient addresses, amounts, token compatibility. Invalid entries reject the entire payload.
- **Bridge** — `OrchestratorService.normalizeBridgePayload()` validates chains, addresses, amounts. Rejects same-chain bridges, non-USDC tokens, and invalid execution modes. For `bridgeExecutionMode: "external_signer"`, `walletAddress` is required while `walletId` is optional.
- **Swap** — Requires `tokenIn`, `tokenOut`, `amountIn`, `recipient`.

Legacy swap and liquidity endpoints are disabled by default during the official
StableFX cutover. `WIZPAY_ENABLE_LEGACY_FX=true` or
`WIZPAY_ENABLE_LEGACY_LIQUIDITY=true` must only be used for isolated
non-production testing. Official StableFX RFQ failures are terminal for the
request; the backend must not fall back to synthetic pricing or internal
reserves.

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

1. `ExecutionRouterService` — checks `walletMode`:
   - `W3S` (default) → `AgentRouterService`
   - `PASSKEY` → `PasskeyEngineService`

2. `AgentRouterService` — dispatches to the type-specific agent.

The agent executes the domain operation and returns an `AgentExecutionResult`.

External-wallet bridge tasks are a narrow exception: the browser can execute the bridge first, then submit `POST /tasks` with `bridgeExecutionMode: "external_signer"` so the backend stores validation output and audit metadata without requiring a Circle `walletId`.

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

| Condition       | Final Status |
| --------------- | ------------ |
| All `completed` | `executed`   |
| All `failed`    | `failed`     |
| Mixed           | `partial`    |

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

## External Wallet CCTP V2 Bridge

**1.** The Swap page validates an Arc Testnet hub-and-spoke route and creates a durable `/bridge/intents` record.

**2.** The connected browser wallet switches to the source testnet, approves the registered TokenMessenger V2 only when needed, and submits `depositForBurn`.

**3.** The backend verifies the source receipt and exact `DepositForBurn` event, then polls Circle's sandbox attestation API and validates the returned CCTP message against the persisted intent.

**4.** The same connected browser wallet switches to the destination testnet and submits `receiveMessage` to the registered MessageTransmitter V2.

**5.** The backend verifies the successful destination receipt, exact `receiveMessage(message, attestation)` calldata, the V2 `MessageReceived` event from the configured `MessageTransmitterV2`, the consumed nonce, and the matching configured-USDC mint transfer before marking the lifecycle complete.

Transaction hashes are stored immediately in browser recovery storage and then bound to the backend intent. Reload restoration continues attestation polling or verifies an already-submitted destination transaction. When a new destination wallet authorization is still required, the UI offers the precise `Complete mint on <network>` action only after the backend proves the nonce is unused. A confirmed source burn is never submitted again.

---

## Design Tradeoffs

### Why async settlement for payroll but not for bridge?

**Payroll** involves N independent transfers. Each transfer is a separate on-chain transaction with its own confirmation timeline. Blocking the worker for all N confirmations would hold the queue slot for minutes. Instead, the agent submits all transfers rapidly and delegates confirmation to the `tx_poll` queue. This keeps worker concurrency high.

**Bridge** is not a worker task. It is a browser-signed, persisted state machine (approval → burn → attestation → mint) with backend receipt validation at each transition.

### Why an idempotency guard instead of BullMQ's built-in deduplication?

BullMQ's `jobId`-based deduplication prevents duplicate _enqueue_, but does not prevent duplicate _execution_ after a crash-restart. If a worker crashes after marking a task `in_progress` but before completing execution, BullMQ retries the job. The idempotency guard (check `status === ASSIGNED`) ensures the task is not re-executed if it has already progressed past the assignment phase.

### Why route through OrchestratorService instead of calling agents directly from workers?

Centralized execution ensures:

- Every task passes through the same idempotency guard
- Every status transition is logged
- Error handling is uniform (best-effort status update + re-throw)
- Adding new wallet modes requires changes in `ExecutionRouterService` only — not in every worker
