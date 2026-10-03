---
title: "Serverless Background Responsibilities"
description: "Phase 4 inventory for Phase 5 recovery and reconciliation work."
---

# Background responsibilities deferred to Phase 5

Phase 4 isolates the legacy Redis/BullMQ runtime; it implements no replacement.
The stable HTTP flows prepare external-wallet transactions, persist intents and
reported evidence, and verify receipts synchronously. None currently calls
`enqueueTask()` or initially calls `enqueueTransactionPoll()`. The only task
producer is legacy `OrchestratorService.handleTask()` (not an HTTP controller
entrypoint); the poller re-enqueues existing poll jobs. The shared task HTTP
controllers do not depend on that orchestrator.

Classification: **A** is necessary dispatch within the legacy service call;
**B** is background recovery; **C** is legacy acceleration/execution infrastructure
outside stable request correctness. No required dispatch is silently discarded:
queue providers are absent from serverless mode, and remain unchanged in server
mode. All database records and request-driven recovery endpoints are retained.

| Current worker/job and class | Trigger and durable state | Retry and duplicate handling | Why retained / Phase 5 category |
| --- | --- | --- | --- |
| `PayrollWorker` / `payroll` — C for stable HTTP; A for legacy `handleTask()` | Legacy dispatch persists `Task`, payload, status and logs before enqueue. Current payroll HTTP uses `TaskUnit` and `ExecutionIntent` plans/reports instead. | BullMQ: 3 attempts, exponential backoff, deterministic task job ID. Orchestrator skips non-`assigned` tasks; this is not an atomic cross-worker claim. | Preserve VPS recovery. `PayrollAgent` refuses backend submission on Mainnet; do not port signing or revive submission. Any needed known-hash recovery belongs to idempotent reconciliation using existing intents and database leases. |
| `SwapWorker` / `swap` (also legacy liquidity/retired FX routing) — C / legacy A | Legacy dispatch persists `Task`, payload, status and logs. Stable swap HTTP prepares/verifies wallet transactions directly. | Same 3-attempt policy and status guard; no general atomic execution lease. Mainnet swap agent rejects backend execution; FX task type is retired. | Preserve VPS source without activating retired flows. Phase 5 should reconcile persisted wallet evidence, potentially via pgmq delivery and database leases, never backend signing. |
| `TxPollWorker` / `tx_poll` — B | Existing jobs contain network, task ID, known transaction ID and attempt; poller re-enqueues pending/transient results. `TaskTransaction` stores status, hash, attempts and errors; task logs include submissions completion. No active stable HTTP initial enqueue was found. | 2-second delay; service bound of 180 polls; one BullMQ attempt per delivery. Updates target existing records; task state guards help, but duplicate deliveries/terminal protection need explicit Phase 5 leases and idempotency rather than assumed exactly-once execution. | Finish known-hash observations when the client stops polling. Inventory category: Supabase Queues/pgmq plus idempotent reconciliation and database leases; Cron/pg_net may trigger bounded scans. Keep operation-specific verifiers authoritative and never rebroadcast unresolved payments. |
| Request-driven intent, payroll, swap and bridge recovery — B follow-up opportunity, no current BullMQ job | HTTP report/recover/verify paths retain `ExecutionIntent`, `TaskUnit`, verified swap and bridge intent/evidence records, including existing intent/destination lease state. | Existing immutable identities, uniqueness, leases and receipt checks remain unchanged. Any later unattended delivery must reuse those rules. | Recovery after interrupted clients remains needed. Phase 5 category: existing ExecutionIntent state, database leases and idempotent reconciliation; scheduled scans/delivery are not implemented here. |
| Request-driven activity synchronization — no current BullMQ job | Authenticated `/activities/sync`; activity projections and `ActivitySyncState` retain ownership, idempotency keys, cursors and lease state. | Request coalescing plus durable 120-second sync lease and throttling; projections use persisted idempotency keys. | Preserve history refresh without Redis. Phase 5 may add bounded Cron/pg_net-triggered reconciliation around the existing lease, not replace account authorization. |

Phase 5 must choose delivery/scheduling adapters and close retry/lease gaps
explicitly. Phase 4 adds no pgmq, Supabase Cron, pg_net, schema migration,
automatic recovery loop, or new financial execution authority.
