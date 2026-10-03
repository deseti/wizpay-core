# Phase 9 — production cutover preparation

**Preparation only. Live production cutover is deferred to the final manual-PC
pass.** Production remains `https://app.wizpay.xyz` → VPS NestJS → VPS PostgreSQL
with legacy Redis/BullMQ. Target is the same frontend → a separate Vercel API →
Supabase PostgreSQL with bounded database reconciliation. No production change,
deployment, DNS change, production export or fund movement is performed here.
The original live Phase 9 acceptance gate is **not passed by offline evidence**.

## Pinned release and gates

Stable fallback: `9900052a04ba807d937a9687f21d9933ffee33dd`, annotated tag
`vps-production-9900052`. Candidate before preparation:
`25b518217b46a7d45462c6fc610314b73a32a5c5` on `feat/serverless-free-stack`.
At the final session, pin the actual tested release SHA explicitly, verify its
remote feature branch, and rebuild/test it. Do not use mutable `latest` alone.

[release.template.json](release.template.json) is deliberately incomplete and must
be filled with the final tested candidate and independent live identities.
A release record contains candidate/fallback SHAs, SHA-256 of the Phase 8 report,
registry resource digest, exact target project, separate target/fallback API
origins, approved capability flags, deployment ID, migration evidence ID and UTC
start time. Deployment/migration/time are placeholders until executed; offline
fixture IDs are never hosted evidence. The final release must bind the deployed
commit, provider project/environment and database identity to the same record.
The Phase 8 digest pins implementation evidence, **not** deferred hosted parity.

[checklist.md](checklist.md) defines every prerequisite/action/validation/abort and
rollback condition. The pure gate reducer rejects skipping, stale SHA, mixed
OFFLINE/LIVE evidence, duplicate IDs, missing checks and changing accepted
results. This is an evidence ledger; it does not grant trust to an unverified
operator assertion and cannot execute a switch. Provider evidence must be
verified independently and attached securely. A PASS replay is not proof that
its actions occurred. Record targets as public identities only, never URLs with
credentials, tokens, sessions, raw database rows or provider logs.

## Commands and classifications

Build first with `npm run build -w backend`. Set only the pinned non-secret
`WIZPAY_CUTOVER_CANDIDATE_SHA` for read-only preparation commands:

```sh
npm run cutover:prepare -w backend -- --plan
npm run cutover:prepare -w backend -- --preflight
npm run cutover:prepare -w backend -- --simulate
```

These are **SAFE READ-ONLY / OFFLINE**: no provider calls, DB changes or routing
changes. Preflight JSON checks Git/tag/history, Phase 6–8 source artifacts,
accepted matrix/digest, known names, Redis boundary, explicit frontend URL and
Mainnet registry. It is a repository preflight, not hosted credential validation.
`--simulate` is a synthetic gate walk. Actual isolated PostgreSQL + packaged
function behavior is tested by `src/phase9/cutover.postgres.spec.ts`; Phase 7 native
dump/restore and Phase 8 acceptance must also execute in the isolated runner:

```sh
WIZPAY_TEST_CHROMIUM_PATH=/usr/bin/chromium bash deploy/serverless-acceptance/run-isolated.sh
```

**DESTRUCTIVE, ISOLATED ONLY**: this helper creates/removes its own loopback
containers/databases and synthetic data, never uses a production URL. The new
artifact driver denies non-loopback HTTP/TCP, legacy queue imports and payment
execution. Two read invocations preserve all 15 tables / 45 fixture rows exactly.

`--replay <private-ledger.json>` validates chronological release-bound receipts.
`--observation <private-metrics.json>` summarizes bounded approved metric counts.
Both are **SAFE READ-ONLY** and emit whitelisted summaries, not input contents.
Keep operator evidence outside the repository; never commit real backups/logs.

`--target-smoke <private-public-metadata.json>` and
`--production-smoke <private-public-metadata.json>` default to no HTTP execution; live non-financial probes require explicit `WIZPAY_CUTOVER_LIVE_SMOKE_ACK` equal to
`NON_FINANCIAL_PINNED_TARGET` to contact the release-pinned Vercel origin. No
redirects, VPS fallback or user financial execution are permitted. Public checkout
GET may expire an invoice, and authenticated reads may update session lastUsedAt;
classify those probes as **TARGET WRITE** and record possible divergence even
without the optional nonce. Only health/capabilities/runtime/provider read probes
are **SAFE READ-ONLY**. Metadata
must attest actual Vercel serverless mode, Supabase project/role suffix,
transaction port 6543/database postgres, Mainnet/resource digest, strict CORS,
no Redis and no VPS proxy. Public health alone cannot establish project/role or
runtime mode. Supply a designated public checkout ID; optional authenticated
Activity session enters process memory through `WIZPAY_CUTOVER_SMOKE_SESSION`,
never files/arguments/reports. Logs are check/status/result only. No session in
JSON is accepted. Individual calls time out at 15 seconds; <=12 requests.

**TARGET WRITE**: optional unsigned auth nonce persistence additionally requires
`WIZPAY_CUTOVER_NONCE_ACK=NON_FINANCIAL_TARGET_WRITE`. It is not a payment, but
still creates DB divergence: record target writes as PRESENT. Omitted nonce,
checkout or session evidence is INCOMPLETE and cannot satisfy the complete smoke
gate. Readiness checks execute authoritative Arc/Uniswap read verification;
enabled Swap/cross-token Payroll quote and Bridge Iris quote must succeed.
`available=false` never counts as provider success. No sensitive payload is
reported. Enable only the operator-approved stable capability profile.

Send/Payroll prepare, browser route wiring and internal reconciliation readiness
also require the controlled checklist evidence below; the HTTP smoke subset
alone does not pass the full PRODUCTION_SMOKE stage. There is no public
reconciliation trigger, payment endpoint, cron activation or production switch
command in this tool. New automation must require a separate explicit
`WIZPAY_PRODUCTION_CUTOVER_ACK` before any **PRODUCTION SWITCH**, never default
that acknowledgement. None is set or invoked in this pass.

## Configuration boundary

[configuration.json](configuration.json) and [environment.template](environment.template)
list names only with REQUIRED/OPTIONAL/DERIVED/FORBIDDEN and placement.
The template is a checklist, **not a dotenv file to source**.

- Backend: production Node 24 Vercel Build Output API function
  `apps/backend/api/index.cjs` → shared `src/serverless.ts`. Set production,
  serverless, Mainnet, Supavisor transaction profile explicitly. Scoped
  `ARC_MAINNET_DATABASE_URL` requires `sslmode=verify-full` and pinned Supabase
  CA via `sslrootcert`; pool max 1–3, normally 1. No per-request disconnect.
- Supabase/migration variables belong only in the secure operator process,
  never the frontend or deployed API. Reuse Phase 7 direct/Session 5432 identity,
  explicit target ACK, read-only source and a fresh designated target. Its ACK
  does not authorize modifying the VPS. Hosted target reset is not automated.
- Frontend switch changes **only `NEXT_PUBLIC_API_URL`**, explicitly, and
  requires a frontend rebuild/redeployment since Next inlines it. Preserve
  Mainnet/Reown/resources. Production aliases are forbidden, no automatic
  fallback. Existing dev localhost behavior is unchanged. Confirm actual old
  API origin before cutover; the fixture origin is not a production setting.
- Arc RPC, chain 5042, canonical token addresses, Payroll and Swap contracts come
  from the pinned registry. DERIVED compatibility aliases should remain unset;
  if present they must exactly match. Capture approved capability flags for all
  seven stable configurable features, verify matching hosted `/capabilities`.
  Liquidity/cross-token Invoice/Nano API remain disabled, never enabled.
- CCTP is wallet-direct, Iris read/attestation base and destination RPC names
  only where enabled routes need them. No Circle custodial secret/API key is
  needed. Uniswap uses pinned public resources, no backend signing secret.
- Auth uses existing wallet signature challenges + durable sessions, no new
  auth secret. Production CORS stays exactly `https://app.wizpay.xyz`.
- Reconciliation uses existing database work/leases and bounded arguments;
  trusted scheduler integration is separate. Do not start it before data
  authority is established or invoke it during database comparison. Redis
  variables/workers remain legacy-server only and forbidden in target config.
- Observability uses Vercel metrics/logs and read-only PG queries; no paid token.
  Tests/metadata attest the runtime; do not expose full env diagnostics publicly.

## One authoritative writer

A frontend switch alone cannot fence old tabs, direct API callers, legacy
workers, activity sync, or reconcilers. Before final export, the operator must
pause incoming financial submissions/prepare-report-verify/auth/API writes and
all source background writes using the approved ingress/maintenance control.
Retain the VPS process and recovery access. Verify no write clients or workers
remain; already submitted user-wallet hashes must be captured durably before
snapshot or explicitly recorded for post-import authoritative verification.
Do not fabricate hashes, reset intents or replay payments.

Final capture → restore → catalog/count/all-column verification runs while the
source stays fenced. Target production ingress and reconciliation stay disabled
until verification and target tests are complete. Auth nonce smoke after final
import is a target write; account for it in rollback. Switch explicit frontend
configuration only after DB, deployment and smoke gates. Keep source ingress
fenced even for stale clients, enable only target writers, and confirm browser
traffic reaches the pinned target (network tab + bundled/CSP origin). Never
allow automatic fallback or dual DB writes. Keep VPS alive throughout observation.
Read-only comparison does not itself fence concurrent source writers.

## Final data procedure (deferred)

Reuse [Phase 7 runbook](../serverless-data-migration/README.md). **SAFE READ-ONLY**
source role and consistent snapshot custom data-only `pg_dump`, public app tables,
no owner/ACL/internal migration rows; private retained backup + size/SHA-256.
**TARGET WRITE** prepare fresh designated Supabase target using current Prisma
migration checksums; `pg_restore --data-only --single-transaction --exit-on-error`
with FKs enabled. Phase 7 rejects same endpoints/ambiguous targets and enforces
explicit isolated/designated target acknowledgement. **DESTRUCTIVE** reset is
local marked rehearsal only; never reset the VPS or an occupied hosted DB.

Run `migration:rehearse -- --verify-only` while both sides are controlled:
all 15 application tables exact counts, full row digests (auth material included
but never output), PK/unique/FK/check/index/enum/non-internal-trigger parity and
migration history. Verify IDs/network/wallets/hash/evidence/terminal states,
invoice ownership, Task relationships and ReconciliationWork retry/leases
unchanged. Preserve leases exactly; expired leases become reclaimable later,
without resetting intents or invoking live chain reconciliation now. Save
machine report ID/hash to release. Reject any mismatch; no traffic switch.

[rollback.md](rollback.md) separates before-write and after-write rollback.
[observation.md](observation.md) provides critical-flow checks and approved window.

## Deferred final manual-PC steps

1. Authenticate to Supabase.
2. Verify hosted Supabase target.
3. Authenticate to Vercel.
4. Deploy/link backend project.
5. Configure Vercel production env vars.
6. Run hosted target smoke.
7. Perform final production read-only DB export.
8. Import to hosted Supabase.
9. Run hosted data integrity verification.
10. Set frontend production backend target to Vercel.
11. Deploy/update frontend configuration.
12. Run production smoke.
13. Begin observation window.
14. Monitor critical flows.
15. Accept or rollback.
16. Keep VPS alive throughout observation.

Initial target smoke precedes final capture; rerun target smoke against the final
verified import before switching. Final source capture requires verified writer
fencing; reconcile live user evidence before resuming a single authority.
Interactive wallet/provider tests and hosted production-data parity remain live
evidence. Optional live fund-moving checks require separate manual approval;
automated preparation/smoke never signs, broadcasts or approves tokens.
