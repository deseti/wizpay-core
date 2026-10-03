---
title: "Runtime Architecture Boundaries"
description: "Preserved VPS baseline and shared server/serverless HTTP runtime boundaries."
---

# Runtime Architecture Boundaries

## Scope and stable recovery reference

Phase 1 records the existing architecture on `feat/serverless-free-stack`.
It introduces no runtime adapter, deployment change, schema change, or
user-facing behavior change. Later phases require separate implementation and
validation. This document is not approval of a serverless cutover.

The exact stable VPS baseline is
`9900052a04ba807d937a9687f21d9933ffee33dd`. The remote archive branch
`archive/vps-production` points to that commit. The annotated tag
`vps-production-9900052` points to the same commit and has the message
`Stable VPS production architecture before serverless migration`.
The branch and tag were verified on origin during Phase 1. Do not advance,
delete, or rewrite these recovery references or modify `main` for this work.

An operator can check the recovery references without deploying:

```sh
git ls-remote origin refs/heads/archive/vps-production \
  refs/tags/vps-production-9900052 'refs/tags/vps-production-9900052^{}'
git rev-parse 'vps-production-9900052^{commit}'
```

The archive branch and the peeled tag must resolve to the baseline above.
The tag object itself has a different SHA because it is annotated. These
references preserve source, not a database backup, Redis contents, secrets,
images, or evidence of current production health. Recovery requires an
operator-reviewed checkout of the exact baseline, compatible retained data
and configuration, and the existing deployment procedures. Do not reset a
checkout with local work or run deployment/migration commands as part of
Phase 1. The historical fresh-install runbook is not an instruction to replay
its baseline migration against an existing production database.

## Reusable domain and business responsibilities

Paths below are relative to the repository root. “Reusable” identifies rules
that must remain shared across runtime profiles; it does not claim these
NestJS services are already infrastructure-independent. Many currently inject
`PrismaService`, `ConfigService`, RPC clients, or other NestJS providers.
Preserve their existing composition until an adapter is separately designed.

| Responsibility | Existing implementation | Shared contract to preserve |
| --- | --- | --- |
| Wallet authentication and account ownership | [WalletAuthService](../apps/backend/src/modules/wallet/wallet-auth.service.ts), [WalletService](../apps/backend/src/modules/wallet/wallet.service.ts), [InvoiceAuthService](../apps/backend/src/invoice/invoice-auth.service.ts) | Mainnet signed one-time challenge, atomic challenge consumption, hashed expiring/revocable sessions, canonical owner conflict rejection; invoice/activity/task account scope must continue to use the existing authenticated principal. Authentication signatures do not authorize backend spending. |
| Execution intent identity and recovery | [ExecutionIntentService](../apps/backend/src/execution-intent/execution-intent.service.ts), [controller](../apps/backend/src/execution-intent/execution-intent.controller.ts), [schema](../apps/backend/src/database/schema.prisma) | Immutable logical identity/fingerprint, unique idempotency and transaction-hash bindings, allowed transitions, atomic lease acquisition/expiry, attempt/failure state, terminal-state protection, immutable execution context and verified completion. The generic controller currently uses intent ID plus idempotency-key access; do not describe it as uniformly session-authenticated or weaken any operation-specific ownership check. |
| Payroll preparation and reporting | [PayrollValidationService](../apps/backend/src/agents/payroll/payroll-validation.service.ts), [PayrollBatchService](../apps/backend/src/agents/payroll/payroll-batch.service.ts), [PayrollInitService](../apps/backend/src/orchestrator/payroll-init.service.ts), [TaskService](../apps/backend/src/task/task.service.ts), [TaskUnitService](../apps/backend/src/task/task-unit.service.ts), [TaskController](../apps/backend/src/orchestrator/task.controller.ts) | Recipient/token validation, immutable batch identity, capabilities, owner-scoped tasks, external-wallet submission, receipt-verified unit reports and transactional counters. Do not replace unit-based reporting with legacy worker aggregation. |
| Invoices and payment links | [InvoiceService](../apps/backend/src/invoice/invoice.service.ts), [invoice module](../apps/backend/src/invoice/invoice.module.ts) | Merchant management remains distinct from public checkout; bind payment evidence once, preserve intent recovery, verified settlement and account ownership. |
| Receipt and transaction verification | [direct Send verifier](../apps/backend/src/execution-intent/direct-transfer-receipt-verifier.service.ts), [payroll verifier](../apps/backend/src/task/payroll-receipt-verifier.service.ts), [invoice verifier](../apps/backend/src/invoice/invoice-payment-verifier.service.ts), [Mainnet swap service](../apps/backend/src/user-swap/mainnet-uniswap-v4.service.ts) | Check the selected chain, successful receipt, expected sender/token/recipient/amount or route-specific calldata/events, and required confirmations. Preserve operation-specific verification and unique persisted evidence; a supplied hash or a queue completion event is not payment proof. |
| Bridge lifecycle and recovery | [BridgeLifecycleService](../apps/backend/src/bridge/bridge-lifecycle.service.ts), [BridgeQuoteService](../apps/backend/src/bridge/bridge-quote.service.ts), [bridge registry](../packages/bridge-registry/index.js) | Official CCTP V2 route validation; persist approval/source/destination evidence, match Circle Iris attestations to the stored message/intent, preserve ownership and destination leases, verify destination receipts. The user wallet signs source approval/burn and destination mint. Backend fetching/reattesting is not custodial execution. |
| Activity projection, synchronization and backfill | [ActivityService](../apps/backend/src/activity/activity.service.ts), [ActivityBackfillService](../apps/backend/src/activity/activity-backfill.service.ts), [controller](../apps/backend/src/activity/activity.controller.ts) | Account-scoped cursor reads, immutable projection ownership/idempotency, verified persisted evidence, database sync leases and throttling. The in-process `syncFlights` map coalesces calls locally; it does not replace the durable lease. Current sync projects persisted evidence rather than claiming a full chain scan. Backfill excludes ambiguous/noncanonical owners. |
| Swap routing, readiness and capabilities | [UserSwapModule](../apps/backend/src/user-swap/user-swap.module.ts), [OfficialSwapModule](../apps/backend/src/official-swap/official-swap.module.ts), [CapabilityService](../apps/backend/src/capabilities/capability.service.ts), [ExecutionRouterService](../apps/backend/src/execution/execution-router.service.ts) | Existing route/resource readiness, fail-closed capability decisions, prepared external-wallet execution and verified outcomes. Preserve retired FX/backend-submission rejection rather than treating old code as new signing authority. |
| Network/resource identity | [Arc registry](../packages/arc-network/index.js), [bridge registry](../packages/bridge-registry/index.js), [backend Arc configuration](../apps/backend/src/config/arc-network.config.ts) | Canonical Arc Mainnet identity/resources, unavailable-resource states and capability resolution. Do not fork addresses, registries, financial calculations or network policy between profiles. |

Persistence is part of these contracts. In
[schema.prisma](../apps/backend/src/database/schema.prisma), `ExecutionIntent`
stores immutable request fields, unique identity/hash keys, lease owner/expiry,
attempts, failure code and completion state; retained legacy provider
correlation fields do not enable custodied wallets. `TaskUnit`,
`TaskTransaction`, `InvoicePayment`, `BridgeTransaction`,
`VerifiedSwapTransaction`, `Activity`, `ActivitySyncState`,
`WalletAuthChallenge` and `ActivityAuthSession` store reporting, verification,
recovery and ownership evidence. Keep their uniqueness, transactional and
lease semantics unchanged. No schema or production migration is part of Phase 1.

## VPS runtime and infrastructure responsibilities

| Runtime concern | Existing implementation and behavior |
| --- | --- |
| Permanent HTTP process and composition | [main.ts](../apps/backend/src/main.ts) validates network/runtime isolation and CORS before bootstrap, creates NestJS, enables shutdown hooks and calls `app.listen()`. [AppModule](../apps/backend/src/app.module.ts) imports the domain services together with database, adapters and queue providers. This is the current long-running API composition, not a serverless handler. |
| Queue production | [QueueModule](../apps/backend/src/queue/queue.module.ts), [QueueService](../apps/backend/src/queue/queue.service.ts), [queue runtime](../apps/backend/src/queue/queue-runtime.ts) and [job types](../apps/backend/src/queue/queue.types.ts) use BullMQ/Redis, selected-network validation and queue prefixes. Task jobs use deterministic IDs, three attempts and exponential backoff; poll jobs carry an attempt identity, delay and one BullMQ attempt. Queues close on module destroy. |
| Payroll worker lifecycle | [PayrollWorker](../apps/backend/src/queue/workers/payroll.worker.ts) starts on module init with concurrency 5, validates job network, delegates to [PayrollProcessor](../apps/backend/src/queue/processors/payroll.processor.ts), then closes on destroy. The processor calls the existing orchestrator and rethrows failures for BullMQ retry. [PayrollAgent](../apps/backend/src/agents/payroll/payroll.agent.ts) validates but rejects new Mainnet backend submission; the current user flow prepares and reports wallet-signed units. |
| Swap worker lifecycle | [SwapWorker](../apps/backend/src/queue/workers/swap.worker.ts) starts on module init with concurrency 3 and delegates through [SwapProcessor](../apps/backend/src/queue/processors/swap.processor.ts) to the orchestrator. [SwapAgent](../apps/backend/src/agents/swap.agent.ts) rejects backend swap submission. Retaining this worker does not grant a backend signer. |
| Transaction polling lifecycle | [TxPollWorker](../apps/backend/src/queue/workers/tx-poll.worker.ts) starts on module init with concurrency 10. [TxPollProcessor](../apps/backend/src/queue/processors/tx-poll.processor.ts) delegates to [TransactionPollerService](../apps/backend/src/queue/processors/transaction-poller.service.ts), which reads Mainnet receipts, updates transaction records, re-enqueues pending/transient outcomes and aggregates terminal tasks only after the submissions-complete log. The processor catches errors; the service owns poll attempts. The legacy 180-attempt timeout records failure; it must not be interpreted as permission to rebroadcast a user payment. |
| PostgreSQL client lifecycle | [DatabaseModule](../apps/backend/src/database/database.module.ts) supplies [PrismaService](../apps/backend/src/database/prisma.service.ts), which uses `PrismaPg`, connects during module init with bounded retries and disconnects on destroy. Connection lifetime/reuse is a runtime concern; database transactions, constraints and verification state remain shared contracts. |
| Process-local state and ancillary I/O | Activity's local coalescing map, [AnalyticsService](../apps/backend/src/analytics/analytics.service.ts)'s in-memory snapshot and RPC/attestation/integration clients require explicit lifetime and I/O handling in any future profile. [Analytics maintenance](analytics-cron.md) documents an existing protected update endpoint, not an installed scheduler or reconciliation system. |
| Docker/VPS topology | [production Compose](../deploy/arc-mainnet/compose.yml) runs backend/workers, PostgreSQL 15, Redis 7 with persistent volumes and a separate migration profile; readiness/health checks order services and the API binds to loopback on the host. [backend Dockerfile](../apps/backend/Dockerfile), [entrypoint](../apps/backend/docker-entrypoint.sh), [frontend Dockerfile](../apps/frontend/Dockerfile), [contract Dockerfile](../packages/contracts/Dockerfile.dev), [local Compose](../docker-compose.yml) and [development overlay](../docker-compose.dev.yml) all remain available. Production Compose overrides the migration service entrypoint; do not change startup/migration topology here. |
| Deployment and CI | [deployment guide](../deploy/README.md), [environment template](../deploy/arc-mainnet/environment.template), [cutover runbook](../deploy/arc-mainnet/PRODUCTION_CUTOVER_RUNBOOK.md), [CI](../.github/workflows/ci.yml) and [manual production workflow](../.github/workflows/cd-production.yml) are retained. Existing CI covers main pushes/PRs, dependency install, Prisma generation, Foundry, tests and builds; a feature-branch change alone does not establish a CI run. Do not invoke the manual deployment workflow. |

At the Phase 1 baseline, worker providers initialize as part of the Nest
application. Phase 3 now gates only their startup hooks on the selected runtime
mode. Phase 4 excludes legacy queue composition entirely from serverless HTTP
while retaining server workers, transports, processors and retries. Database
hooks remain application-owned in both modes. Source preservation does not by
itself prove live service availability.

## Future serverless boundary — design only

These responsibilities are candidates for later runtime adapters, not new
interfaces or implementations in this phase:

| Future boundary | Responsibility to isolate | Shared behavior that must not fork |
| --- | --- | --- |
| Stateless HTTP composition/bootstrap | Request lifecycle, application reuse, transport/error translation and a composition that does not inadvertently start permanent workers | Existing validation, authentication/ownership, CORS policy, capabilities, API outcomes and fail-closed behavior |
| PostgreSQL connection/runtime adapter | Connection initialization, pooling/lifetime, failure handling and cleanup under the selected execution limits | Existing schema, unique constraints, transactional writes/isolation, immutable identities, leases and persisted verification |
| Durable queue adapter | Enqueue/delivery acknowledgement, attempt identity, delays, retries, backoff and network scoping | Task identity, capability gates, duplicate-delivery protection and verification; queue delivery never grants spending authority |
| Reconciliation/scheduler boundary | Trigger/resume reads of known submission evidence, bounded retries, lease coordination and observable recovery | Known-hash reconciliation, operation-specific receipt checks and terminal-state rules; unresolved wallet outcomes cannot trigger automatic rebroadcast |
| Runtime-specific worker/recovery adapter | Invocation/bootstrap/shutdown and execution budgets around the existing orchestration/recovery responsibilities | Shared business services and persisted state machines rather than duplicate VPS/serverless financial logic |

Phase 1 introduced no Supabase connectivity, schema compatibility, Supavisor
configuration, Vercel handler, Redis/BullMQ removal, pgmq/Queues, Cron, pg_net,
Vault or production cutover. It added no future runtime environment variables.
Domain services remain in their existing locations.

### Phase 2 database-layer update

Phase 2 adds the explicit `supavisor-transaction` database profile described in
[Supabase PostgreSQL Compatibility](supabase-postgresql-compatibility.md).
`ARC_MAINNET_DATABASE_URL` is its transaction-pool runtime connection;
`ARC_MAINNET_MIGRATION_DATABASE_URL` is its separately supplied direct/session
CLI connection. Runtime defaults to one application-side connection (bounded
override up to three), uses verified TLS and unnamed queries, and retains the
existing PrismaService lifecycle. The default VPS database profile, HTTP
composition, Redis/BullMQ and canonical schema/migration remain intact.
Connection-profile support and isolated PostgreSQL tests do not constitute a
Supabase production cutover or a serverless HTTP handler. Live clean-Supabase
migration, TLS/pooler and persistence evidence still require the authorized
test project's securely supplied endpoints. Phase 2 acceptance is not recorded
in the migration log until independently audited.

### Phase 3 HTTP runtime update

The shared [application factory](../apps/backend/src/application.ts) configures
HTTP without listening or owning signals. [main.ts](../apps/backend/src/main.ts)
retains VPS/local listener and shutdown ownership;
[serverless.ts](../apps/backend/src/serverless.ts) lazily initializes one cached
Express/Nest application, shares concurrent cold starts, and retries after a
failed initialization. See [HTTP runtime composition](architecture.md#http-runtime-composition-phases-34)
for the strict runtime selector and resource lifecycle. The focused factory,
handler, root-composition and worker tests cover both runtime paths. The
future HTTP test plan below is now implemented for initialization and transport;
queue/scheduler replacements and deployment remain later-phase work.

### Phase 4 Redis-free HTTP runtime

Serverless composition excludes BullMQ/ioredis, queue producers, consumers and
legacy orchestration. `TaskHttpModule` retains the same task controllers and
payroll initialization service independently of worker composition. Unused
agent-module imports no longer pull the legacy queues into request services.
Serverless validation derives no Redis configuration or Redis health target;
server validation continues requiring the existing scoped URL and queue prefix.

Focused tests construct the real serverless module with BullMQ/ioredis imports
forbidden, all TCP unavailable during initialization, and Prisma persistence
stubbed. They exercise health, wallet challenge persistence, request validation,
authorization and warm Prisma reuse. Live database/worker readiness is separate.
The legacy source and VPS deployment remain available. Phase 5 recovery
is implemented by bounded PostgreSQL delivery and existing verifiers; see the
[background responsibilities](serverless-background-responsibilities.md). No
Cron/pg_net schedule or deployment is configured.

## Configuration boundaries

| Configuration class | Current source and boundary |
| --- | --- |
| Domain/network | Arc and bridge registries above; [configuration.ts](../apps/backend/src/config/configuration.ts), [Arc configuration](../apps/backend/src/config/arc-network.config.ts), `WIZPAY_ARC_NETWORK`, matching API/worker identity selectors and existing `WIZPAY_ARC_MAINNET_CAPABILITY_*` flags. Resource unavailability, Mainnet-only checks and capabilities remain shared. No address or flag value changes. |
| Database | `ARC_MAINNET_DATABASE_URL`, [Prisma CLI configuration](../apps/backend/prisma.config.ts), existing schema/migrations and explicit matching `WIZPAY_MIGRATION_NETWORK`. [runtime isolation](../apps/backend/src/config/runtime-isolation.config.ts) rejects user-supplied unscoped `DATABASE_URL`; [environment validation](../apps/backend/src/config/env.validation.ts) derives the internal `DATABASE_URL` consumed by PrismaService only after validation. Do not bypass this boundary. |
| Redis/BullMQ | Server mode requires `ARC_MAINNET_REDIS_URL` and `ARC_MAINNET_QUEUE_PREFIX` before deriving internal Redis options and `BULLMQ_PREFIX`. Serverless mode neither requires nor consumes these optional scoped values and derives no Redis settings. Unscoped Redis/queue configuration remains rejected. Server TLS/auth options and job/retry policies are unchanged. |
| VPS deployment | The production template/Compose and manual workflow supply PostgreSQL/Redis targets, volumes, ports, health checks, CORS and process environment. [AppConfigModule](../apps/backend/src/config/app-config.module.ts) reads the root local `.env` or injected container environment, and ignores developer env files in tests. [host normalization](../apps/backend/src/config/runtime-env.ts) distinguishes Compose hostnames from loopback host ports. Credentials stay outside tracked source. |
| External services and frontend | Existing Circle Iris and destination RPC configuration is route-specific verification I/O, not custody. `NEXT_PUBLIC_API_URL` selects the frontend backend origin; existing Mainnet/Reown/public-app settings remain unchanged. [frontend root-env loader](../apps/frontend/scripts/with-root-env.sh) and production build/runtime configuration are retained. |
| Serverless HTTP (Phase 3) | `WIZPAY_RUNTIME_MODE=server\|serverless` selects process lifecycle explicitly and must match the entrypoint; absence preserves server startup through `main.ts` and selects serverless through the handler. Database profiles, network/capability registries and production bindings remain unchanged. Bounded PostgreSQL reconciliation shares the serverless application; external scheduler deployment remains future work. |

## Frontend cooperation with durable backend state

[execution-intent.ts](../apps/frontend/lib/execution-intent.ts) calls existing
acquire/prepare/hash/recover/cancel/verify endpoints.
[useInvoicePayment](../apps/frontend/hooks/useInvoicePayment.ts) persists
wallet recovery context, binds known hashes and retries verification without
automatically requesting another payment after an unresolved signature.
[useBatchPayroll](../apps/frontend/hooks/wizpay/useBatchPayroll.ts) and
[useTransactionExecutor](../apps/frontend/hooks/useTransactionExecutor.ts)
retain external-wallet signing and preparation leases.
[bridge-service.ts](../apps/frontend/lib/bridge-service.ts) cooperates with
backend bridge evidence, attestation and destination recovery.
[useUnifiedActivity](../apps/frontend/hooks/useUnifiedActivity.ts) synchronizes
authenticated account-scoped history and invalidates cached queries.
[useAdaptivePolling](../apps/frontend/hooks/useAdaptivePolling.ts) and the
retained [useTaskPolling](../apps/frontend/hooks/useTaskPolling.ts) manage
refresh/status display, not settlement authority. Some retained hook comments
describe historical backend execution; the current code and fail-closed
agents define the actual signing boundary. No frontend file or production
backend selection changes in Phase 1.

## Test strategy for both runtime profiles

Shared business behavior must not fork between VPS and serverless. Reuse the
same fixtures and assertions for authentication, ownership, intent identity,
leases, capabilities, reporting, receipts and recovery. Adapter contract tests
must establish equivalent outcomes over that shared behavior; they must not
replace financial/verification assertions with transport-only success checks.

| Layer | Current VPS profile | Future serverless profile (not implemented) |
| --- | --- | --- |
| Shared domain rules | Existing backend specs under wallet, execution-intent, task, invoice, bridge, activity, user-swap and capabilities; registry tests in both packages; shared external-wallet/recovery frontend tests | Run the same business tests/fixtures. Add shared parity cases for repeated requests, wrong owner/network, duplicate/conflicting hash, expired/contended lease, unknown wallet outcome, delayed receipt/attestation and terminal-state protection. |
| HTTP/runtime isolation | [main.spec.ts](../apps/backend/src/main.spec.ts), runtime/deployment config specs, controller security specs and the current [e2e harness](../apps/backend/test/app.e2e-spec.ts), with the required local services/configuration | Isolated future HTTP bootstrap tests for concurrent/cold/warm invocation, lifecycle reuse and no unintended permanent worker startup; keep controller/domain assertions shared. No handler is created now. |
| PostgreSQL/persistence | Generated Prisma client plus dedicated local PostgreSQL integration suites: [execution-intent.postgres.spec.ts](../apps/backend/src/execution-intent/execution-intent.postgres.spec.ts) and [offline rehearsal](../apps/backend/src/phase7/phase7-offline-rehearsal.postgres.spec.ts). Inspect their test database guards before execution; never target production. Unset test URLs skip these tests and do not validate persistence. | Later isolated connectivity/connection-lifetime tests and the same concurrency/constraints/lease/verification integration cases against an explicitly authorized test database. No compatibility or schema migration work now. |
| Queue/worker/recovery | [queue-runtime.spec.ts](../apps/backend/src/queue/queue-runtime.spec.ts), [queue.service.spec.ts](../apps/backend/src/queue/queue.service.spec.ts), [transaction-poller.service.spec.ts](../apps/backend/src/queue/processors/transaction-poller.service.spec.ts), and existing agent/orchestrator tests. Full readiness also needs local Redis/BullMQ enqueue-consume/retry/delay/shutdown evidence; mocked specs alone do not prove a live worker. | Isolated future durable-queue/reconciliation adapter tests for acknowledgement, redelivery, delay, attempts and interrupted/restarted work, backed by shared idempotency and known-hash recovery assertions. No scheduler or queue replacement now. |
| Deployment and health | Preserve Dockerfiles/Compose; parse production and local Compose without launching production. Full VPS profile validation needs an isolated stack build/start, `/health` and `/health/runtime-isolation`, a representative functional request and controlled shutdown; a PID/port alone is insufficient. | Later isolated runtime packaging/bootstrap/connectivity checks plus the same representative functional and feature-parity cases; no production configuration/cutover in this phase. |
| Frontend feature parity | Existing frontend tests for wallet policy, invoices, payroll, bridge and account-scoped activity; build with explicit nonproduction validation settings when needed | Keep user-controlled signing, endpoint/response behavior, polling and recoverable states shared; do not fork financial execution into a serverless-only frontend flow. |

Repository commands include `npm run test -w backend -- --runInBand`,
`npm run test -w frontend`, registry workspace tests, and `npm run build`.
Backend build requires Prisma generation; contract checks require Foundry and
the pinned Solidity compiler/libraries. Preserve lockfiles, checksums and TLS
verification. The backend `lint` script uses `--fix`; use a read-only ESLint
invocation for review rather than allowing validation to rewrite source.

For a documentation-only Phase 1 change, verify `git diff --check`, relative
document links, source/deployment preservation against the baseline, and
reasonably available registry/runtime-isolation checks. If backend/frontend
code is touched, run its relevant tests and build/typecheck too. Report the
exact command and reason for blocked checks, distinguish environment failures
from application failures, and retain failed/skipped/unrun outcomes separately.
Prisma engine or Docker registry access failures are not permission to weaken
verification, alter application code or claim live Redis/BullMQ readiness.
