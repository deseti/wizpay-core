---
title: "Serverless Migration Log"
description: "Accepted phase records for the WizPay serverless migration."
---

# Serverless Migration Log

## Phase 1 — Preserve VPS baseline + serverless architecture boundary

Status: ACCEPTED
Branch: feat/serverless-free-stack
Commit: 5bd227f87e4cb3fd583ac43971d8f1aa6debb5c7
Date: 2026-10-02 UTC

### Delivered
- Preserved the stable VPS baseline and explicit recovery references.
- Documented reusable domain/business responsibilities.
- Documented VPS-only runtime/infrastructure responsibilities.
- Documented the future serverless runtime boundary without implementing it.
- Documented configuration boundaries and shared VPS/serverless test strategy.

### Verification
- backend test suite — PASS
- backend build — PASS
- Prisma generation — PASS
- Arc network tests — PASS
- bridge registry tests — PASS
- git diff --check — PASS
- Docker Compose static configuration parsing — PASS

### Known non-blocking limitations
- PostgreSQL integration suites requiring dedicated local test URLs were not run.
- Live PostgreSQL/Redis/BullMQ readiness was not revalidated because Phase 1
  made documentation-only changes.

### Next phase
Phase 2 — Supabase PostgreSQL compatibility

The following implementation records summarize the owner's roadmap status and
existing committed evidence. They do not certify deferred hosted/live operations.

## Phase 2 — Supabase PostgreSQL compatibility

Status: COMPLETED — implementation / owner roadmap
Branch: feat/serverless-free-stack
Commit: d810380085b5a14f5400b0bb96ab1bf8d1d6f45d
Date: 2026-10-03 UTC (recorded)

### Delivered

- Explicit scoped Supavisor profiles, strict TLS and secretless OIDC validation infrastructure.
- Vault-backed Phase-2-only CI credential lifecycle and bounded pooler retries.

### Verification

- Implementation evidence: [Supabase compatibility](supabase-postgresql-compatibility.md).
- Hosted authentication/connectivity and final CI-role cleanup remain deferred.

## Phase 3 — Stateless NestJS API runtime

Status: COMPLETED — implementation / owner roadmap
Branch: feat/serverless-free-stack
Commit: 80e0d8154164c5e9a56da7726f6161e53661a83d
Date: 2026-10-03 UTC (recorded)

### Delivered

- Shared application factory; server listener and lazy/cached serverless handler.
- Concurrent cold-start and failed-initialization retry boundaries.

### Verification

- Runtime/build evidence: [runtime boundaries](runtime-boundaries.md).

## Phase 4 — Remove Redis/BullMQ dependency from production API

Status: COMPLETED — implementation / owner roadmap
Branch: feat/serverless-free-stack
Commit: ce5585994a53c2ab9f7d94d20e74fc0f899f8129
Date: 2026-10-03 UTC (recorded)

### Delivered

- Redis-free serverless module graph; legacy VPS queue implementation retained.

### Verification

- [Background inventory](serverless-background-responsibilities.md); isolated startup/artifact tests.

## Phase 5 — Supabase queue + reconciliation

Status: COMPLETED — implementation / owner roadmap
Branch: feat/serverless-free-stack
Commit: cc2df1b6c0926cd84a1833389143b0d4e46ebeec
Date: 2026-10-03 UTC (recorded)

### Delivered

- Durable PostgreSQL delivery metadata, bounded leases and idempotent known-hash verification.
- No legacy Payroll/Swap execution port, backend signing or activated public scheduler.

### Verification

- [Background recovery evidence](serverless-background-responsibilities.md); isolated concurrency/recovery tests.

## Phase 6 — Vercel API deployment preparation

Status: DEPLOYMENT PREPARATION COMPLETE — live deployment DEFERRED
Branch: feat/serverless-free-stack
Commit: 31b40b162eb0063eae88fe39cb21b05e229da922
Date: 2026-10-03 UTC (recorded)

### Delivered

- Dedicated Vercel function artifact/build/environment contract and safe smoke tooling.

### Verification

- [Deployment preparation](../deploy/vercel-api/README.md); packaged artifact tests.
- Vercel authentication, actual hosted deployment and live smoke remain deferred.

## Phase 7 — Production-data migration rehearsal

Status: IMPLEMENTATION / ISOLATED REHEARSAL COMPLETE — hosted evidence DEFERRED
Branch: feat/serverless-free-stack
Commit: 602bc3b91616e8a43ba4ad998b92fb2ff0f4771d
Date: 2026-10-03 UTC (recorded)

### Delivered

- Read-only source export, guarded target restore, exact catalog/count/content verification and retry/recovery runbook.

### Verification

- [Isolated evidence](../deploy/serverless-data-migration/isolated-evidence.json); native PostgreSQL dump/restore and repeat rehearsal.
- Real production export, hosted Supabase import and parity remain deferred.

## Phase 8 — Full feature implementation acceptance

Status: IMPLEMENTATION ACCEPTANCE COMPLETE — hosted / interactive evidence DEFERRED
Branch: feat/serverless-free-stack
Commit: 25b518217b46a7d45462c6fc610314b73a32a5c5
Date: 2026-10-03 UTC (recorded)

### Delivered

- Stable-feature matrix, isolated persistence/artifact coverage and desktop/mobile acceptance.

### Verification

- [Acceptance matrix](../deploy/serverless-acceptance/phase8-acceptance.json).
- Hosted Supabase/Vercel, interactive wallets/providers and production-data parity remain deferred.

## Phase 9 — Parallel production cutover preparation

Status: PREPARATION COMPLETE
Live production acceptance: DEFERRED — not executed or claimed
Branch: feat/serverless-free-stack
Commit: 3cd08a58da38bc401736e027df2068045a851785
Date: 2026-10-03 UTC (recorded)

### Delivered

- Ordered gates, explicit frontend target, single write authority, before/after-write rollback safeguards and observation procedures.

### Verification

- [Preparation evidence](../deploy/serverless-cutover/preparation-evidence.json); offline gates, native rehearsal and packaged artifact checks.
- Actual cutover, approved observation and live owner accept/rollback decision remain deferred.


## Phase 10 — VPS decommission preparation

Status: PREPARATION COMPLETE
Actual decommission: DEFERRED — no VPS service stopped or subscription cancelled
Branch: feat/serverless-free-stack
Commit: preparation commit containing this record
Starting HEAD: 3cd08a58da38bc401736e027df2068045a851785
Date: 2026-10-03 UTC (recorded)

### Delivered
- Repository dependency/secret-name inventory, fail-closed evidence gate and host-sharing protection.
- Backup, scoped shutdown, post-shutdown verification and disaster-recovery procedures.
- Read-only DNS/reconciliation checks and offline failure simulation.

### Verification
- [Preparation evidence](../deploy/serverless-decommission/preparation-evidence.json) records executed offline checks.
- Live Phase 9 acceptance, current hosted backups/authority/routing/health and owner shutdown approval remain deferred.
- Actual decommission and subscription cancellation are not claimed.
