---
title: "Serverless Background Responsibilities"
description: "Durable serverless recovery and retained legacy runtime responsibilities."
---

# Serverless background responsibilities

Phase 4 isolates the legacy Redis/BullMQ runtime. Phase 5 adds bounded PostgreSQL
reconciliation for persisted user-wallet evidence.
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

## Phase 5 durable implementation

`ReconciliationWork` is a PostgreSQL-native delivery queue. pgmq is intentionally
not used: these bounded scans and atomic row claims need no extra extension or
second delivery store. The additive migration creates only delivery metadata;
financial state remains in the existing domain tables. No Cron/pg_net schedule
is installed or activated.

| Responsibility | Durable serverless path |
| --- | --- |
| Useful `tx_poll` observation/recovery | Discover known hashes on nonterminal Arc Mainnet `ExecutionIntent` records; invoke existing direct-transfer, payroll or invoice receipt verifiers. Reuse canonical intent transitions. Unknown hashes and token-approval records without an authoritative verifier are not scheduled. Legacy `TaskTransaction`/Circle-ID polling remains VPS-only; generic status is never substituted for operation verification. |
| Interrupted payroll verification | Verify the persisted batch identity/recipients, complete the existing intent and report its `TaskUnit` in the acknowledgment transaction. Also recover completed intents with pending units. HTTP and background reports lock the same parent task to prevent duplicate counters. No payroll execution is ported. |
| Interrupted invoice/link verification | Verify the existing invoice token/amount/merchant and intent payer; atomically persist the verified payment, terminal invoice and intent. Completed intents can finish an interrupted invoice update. Terminal invoices are never reopened. |
| Swap evidence | Authenticated `/user-swap/mainnet/confirm` queues the validated reported hash and wallet before observation. Recovery calls the existing authoritative swap confirmation service and idempotently persists verified evidence; it does not prepare or execute a swap. |
| Bridge evidence | Read-only Circle attestation observation, existing exact CCTP identity checks, and destination receipt verification for a persisted destination hash. Missing destination RPC stays retryable; a reader and verified receipt are mandatory for background completion. Updates compare the observed durable row version. An absent destination hash still requires the user's wallet. |
| Activity | Only existing external-wallet `ActivitySyncState` with its registered Arc wallet is eligible. Reuse its lease, throttle, owner checks and idempotency keys; project at most 20 records from one invoice/send/bridge/swap source page. Persist a `recovery-v1` cursor. Aggregate payroll activity remains in authenticated request-driven synchronization, avoiding partial background aggregate totals. Foreign adapter cursors are not overwritten. |

Delivery identity is unique `(kind, recordId, evidenceKey)`. Claiming uses
`FOR UPDATE SKIP LOCKED`, a random owner token, database time and a 120-second
lease. Expired leases can be reclaimed. Domain updates and delivery acknowledgment
share one transaction, which locks and checks the current unexpired token.
Stale observers cannot acknowledge or apply permanent verification failures.
Already-terminal records and stale activity-page deliveries are harmless.

Transient failures retry after 30 seconds with exponential backoff capped at
one hour. Twelve claims exhaust a delivery into a retained failed record;
authoritative permanent failures are retained immediately. Receipt mismatches
may mark an eligible intent `FAILED_FINAL` under the same fence. Only safe
failure codes are stored; driver diagnostics and credentials are not logged.
The existing authenticated verification endpoints remain available for recovery.

`apps/backend/src/reconciliation.ts` exports `runReconciliationBatch()` for a
future **trusted** scheduler adapter. It exposes no public HTTP route. The adapter
must authenticate any externally triggered invocation; no scheduler/deployment
is configured here. HTTP and batch entrypoints share the same lazy application
and application-scoped Prisma instance, with no listener, Redis or BullMQ imports.

Default processing is five deliveries with a 20-second work budget; callers may
choose at most ten deliveries and a 25-second budget. Discovery selects at most
one batch per domain category. Observer work is capped at ten seconds and a late
result cannot apply changes. Database discovery/claims have short statement and
transaction timeouts; durable commit reserves five seconds. Retry/lease cleanup
has its own bounded timeouts, so finalization may outlast the work budget briefly.
There is no recurring timer or in-process worker loop.

`PayrollWorker`, `SwapWorker`, `TxPollWorker`, queue producers and the VPS
orchestrator remain intact for rollback. Obsolete FX execution is not revived.
Reconciliation only observes **known user-signed transactions**. It never creates
a wallet, signs, approves, broadcasts, rebroadcasts, or executes a payment.

Validation uses a dedicated local `PHASE5_TEST_DATABASE_URL` database named
`wizpay_phase5_test_admin`; the integration harness creates and drops an isolated
test database and applies every migration. It exercises real PostgreSQL claims,
fencing, transaction rollback, concurrency and existing domain transitions.
Hosted connectivity is separate from this evidence.
