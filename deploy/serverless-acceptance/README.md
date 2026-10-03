# Phase 8 feature acceptance

Baseline: `9900052a04ba807d937a9687f21d9933ffee33dd`
(`vps-production-9900052`). Candidate before acceptance changes:
`602bc3b91616e8a43ba4ad998b92fb2ff0f4771d`.

[phase8-acceptance.json](phase8-acceptance.json) records the feature matrix,
executed commands, evidence types, limitations and deferred live checks.
Its PASS results mean **local implementation acceptance**, with synthetic
external-provider evidence. Hosted and interactive evidence is separate.

The baseline and candidate frontend application source are identical. Phase 8
adds tests and local test tooling; it changes no application route, signing,
contract, authorization or receipt-verification implementation. The supported
Mainnet acceptance profile enables Send, same-token Payroll, Invoice, Payment
Link, Swap, Bridge and cross-token Payroll. Actual production capability flags
were not inspected. Unsupported resources still fail closed.

## Acceptance matrix

These are executed implementation results. Detailed test paths and dependencies
are in the JSON matrix. PG means isolated PostgreSQL; Local includes synthetic
provider/component/browser tests.

| Feature | Result | Evidence |
| --- | --- | --- |
| Wallet connect | PASS | Local |
| Wallet auth challenge | PASS | PG + local |
| Wallet auth verify | PASS | PG + local |
| Wallet auth revoke | PASS | PG + local |
| Send | PASS | PG + local |
| Same-token Payroll | PASS | PG + local |
| Cross-token Payroll | PASS | Local |
| Payroll history | PASS | PG + local |
| Invoice creation | PASS | PG + local |
| Invoice management | PASS | PG + local |
| Payment Link | PASS | PG + local |
| Public checkout | PASS | PG + local |
| Payment verification | PASS | PG + local |
| Activity | PASS | PG + local |
| Activity sync/recovery | PASS | PG + local |
| Swap | PASS | Local |
| Bridge / CCTP V2 | PASS | PG + local |
| ExecutionIntent interruption/recovery | PASS | PG + local |
| Receipt/domain verification | PASS | Local |
| Capability matrix | PASS | Local |
| Wrong network | PASS | Local |
| Rejected wallet signature | PASS | Local |
| Duplicate/retry | PASS | PG + local |
| Desktop | PASS | Local |
| Mobile | PASS | Local |
| Vercel artifact parity | PASS | PG + local |
| Cold-restart persistence | PASS | PG + local |
| Assets / balances | PASS | Local |
| Account / profile | PASS | Local |
| Receive QR / recipient scan | PASS | Local |
| PWA resources | PASS | Local |
| Unsupported resource gates | PASS | Local |

Executed totals: 75 backend suites / 608 passing tests (one pre-existing obsolete
router test skipped); 55 frontend files / 241 passing tests; six Chromium tests
across desktop and mobile. Prisma, both builds/typechecks and scoped lint pass.

## Reproduce

After `npm ci`, run from the repository root:

```sh
WIZPAY_TEST_CHROMIUM_PATH=/usr/bin/chromium \
  bash deploy/serverless-acceptance/run-isolated.sh
```

Docker must be available at the local Unix socket. The Linux helper uses
PostgreSQL 15 as the migration source and PostgreSQL 17 as the target, on random
loopback ports. It creates only its own disposable containers and test databases,
clears external database-test bindings, copies matching native dump/restore
clients, applies the current migrations and cleans up on exit. No production
access or hosted authentication is needed. For other machines, omit the Chromium
path when Playwright's Chromium is installed; use the platform's supported
browser installation procedure. Keep network proxy and certificate trust intact.

The helper generates Prisma, validates schema, builds the Vercel artifact,
runs all backend and frontend suites, builds the production frontend, typechecks
both applications and runs desktop/mobile browser tests. Temporary JSON reports
are checked by `verify-evidence.mjs`; it rejects missing/skipped PostgreSQL
integration evidence and requires every matrix test file to have executed.
Raw reports and synthetic auth state are discarded. Scope lint separately:

```sh
(cd apps/backend && npx eslint src/deployment/phase8-acceptance.postgres.spec.ts)
(cd apps/frontend && npx eslint playwright.config.ts e2e/phase8.spec.ts \
  components/providers/WalletAuthProvider.test.tsx \
  hooks/useTransactionExecutor.test.tsx hooks/useInvoicePayment.test.tsx \
  test/start-acceptance.mjs)
git diff --check
```

## What executes

The packaged API test copies the real Build Output API function **outside the
checkout**, prohibits BullMQ/ioredis imports and drives its actual Nest routes
through HTTP. Two independent Node processes share only isolated PostgreSQL.
Tests cover real message-signature authentication, replay/expiry/network/address
rejection, persisted sessions, ownership, invoices/links/public-field boundaries,
Send identity/report/receipt verification, duplicate verification, payment
settlement, activity sync, Payroll preparation/history and Swap/Bridge request
guards. Financial RPC fixtures enter the existing operation-specific verifiers;
no generic receipt-success shortcut is used. Authentication test keys are
random, ephemeral, unfunded and confined to the test parent process. They sign
messages only. Tokens travel through in-memory IPC and never enter reports.

The existing feature suites exercise exact calldata/events, invalid evidence,
canonical resources, CCTP identity, slippage, cross-token Payroll, retries and
recovery. Real PostgreSQL tests cover concurrent claims, fencing, stale leases,
terminal-state guards, persistence and two native source-to-target rehearsals.
The current executor path is tested; one pre-existing obsolete direct Universal
Router test remains skipped and is not acceptance evidence.

Chromium runs the actual Next standalone production build at 1440×1000 and
390×844. An offline EIP-1193 wallet exposes a fake address and rejects all signing
and broadcast requests. API/session fixtures exercise connected pages, form
controls, checkout and navigation. Service workers are blocked in these tests so
remote API fixtures cannot be bypassed; manifest/worker resource availability is
tested separately. Component/hook tests cover signature refusal, safe retry,
network-switch rejection, scanner payloads and loading/error/success states.
Camera permission, real PWA installation and real WalletConnect sessions are
not claimed by this automated pass.

## Intentional architecture differences

The HTTP application is cached and listener-free. Serverless excludes Redis and
BullMQ; legacy VPS source remains recoverable. Bounded PostgreSQL reconciliation
observes known user-signed evidence using durable leases and idempotent updates;
it never signs, executes, approves or rebroadcasts payments. Database connection
purposes remain explicitly scoped. Product signing and verification behavior is
preserved.

## Deferred final manual-PC evidence

- Hosted Supabase authentication, connectivity and persistence.
- Vercel authentication, deployment and hosted feature smoke tests.
- Actual production read-only export, hosted import and production-data parity.
- Interactive user-wallet signing and Mainnet feature acceptance; live provider
  RPC/quote/readiness, mobile WalletConnect, camera and PWA installation checks.

The managed proxy denied the public Arc read-only RPC preflight (CONNECT 403).
Build-time Reown configuration is unavailable here; local build and offline wallet
acceptance passed. Neither is recorded as a live provider PASS.

No funds moved, production data moved, traffic switched, DNS changed or VPS
shutdown occurred. Phase 9 is not started. Production remains on the existing
backend throughout this acceptance pass.
