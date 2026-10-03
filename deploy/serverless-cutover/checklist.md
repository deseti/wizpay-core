# Ordered cutover gates

All evidence is bound to candidate SHA, release ID and OFFLINE or LIVE scope.
Every row requires **all** its checks in `src/phase9/cutover.ts::CHECKS`. All
failures stop progression; there is no bypass flag. A gate receipt records ID,
UTC time in the secure evidence record, operator, action/validation results and
linked reports. No secrets or raw auth/financial rows in committed evidence.

| Stage            | Prerequisites                                                                                 | Action/classification                                                          | Required validation/evidence                                                                                                        | Abort / rollback condition                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| PRECHECK         | Pinned tested candidate, fallback, approved change window                                     | SAFE READ-ONLY preflight, validate hosted credentials separately               | Git/tag, Phase 6 artifact, Phase 7 tooling, Phase 8 passing evidence, config/resource contract, rollback access                     | Missing/failing evidence: remain VPS                                                          |
| DATABASE_EXPORT  | PRECHECK; all source ingress/background writers fenced, pending wallet evidence accounted for | SAFE READ-ONLY final snapshot/native export                                    | Source fence evidence, no source writes, consistent snapshot, private backup checksum/readability                                   | Source drift/export failure: reject capture, controlled VPS resume only if target unused      |
| DATABASE_IMPORT  | Final export; source still fenced; target writers off                                         | TARGET WRITE schema then atomic data restore                                   | Explicit target identity, clean target, migration/checksum parity, successful restore                                               | Failed restore: keep source authoritative/fenced, discard target only under target safeguards |
| DATABASE_VERIFY  | Successful import, both writer paths controlled                                               | SAFE READ-ONLY Phase 7 verify-only                                             | All counts/columns, constraints/indexes/enums/history, wallet ownership, financial IDs/hash/status, reconciliation leases unchanged | Any mismatch blocks deploy/switch; reject target                                              |
| VERCEL_VERIFY    | Verified data + pinned deployment                                                             | SAFE READ-ONLY provider deployment/config attestation                          | Deployed SHA/project/ID, intended Supabase role/project/port/profile, serverless, no Redis/proxy, Mainnet/resources, CORS           | Wrong identity/config/unavailable health: no switch                                           |
| TARGET_SMOKE     | VERCEL_VERIFY, fixture public checkout, in-memory session                                     | Non-financial probes; classify checkout/session/nonce metadata as TARGET WRITE | Health/caps, DB request, Arc read, enabled quotes, authorization, no funds moved; record any target writes                          | Failed/incomplete probe blocks switch; record nonce divergence for rollback                   |
| FRONTEND_SWITCH  | All prior gates PASS, source/background still fenced, rollback access verified                | PRODUCTION SWITCH manual single NEXT_PUBLIC_API_URL rebuild/deploy             | Exact target, updated CSP/browser requests, stale-source clients fenced, one write authority                                        | Misroute/split brain: fence both; choose rollback A/B                                         |
| PRODUCTION_SMOKE | Verified deliberate switch; only target writable                                              | SAFE READ-ONLY defaults; prepare/auth fixture writes recorded explicitly       | Actual frontend wiring + target HTTP subset + controlled checklist below; no financial execution                                    | Error/false verification: fence writes, rollback A/B                                          |
| OBSERVATION      | Production smoke PASS; VPS alive but source writers fenced                                    | SAFE READ-ONLY approved window/metrics collection                              | Start/end, deployment/SHA, data evidence, approved thresholds, all critical flows healthy, no divergence, rollback ready            | Any critical gate fail: hold/fence, rollback A/B; no automatic routing fallback               |
| ACCEPT           | Approved observation complete, live evidence complete                                         | Owner acceptance record; no VPS shutdown                                       | Explicit decision, same release, all receipts/hosted parity, VPS still available                                                    | Missing evidence: remain observing; accepted ledger immutable                                 |
| ROLLBACK         | Any failure or owner decision while ledger OPEN                                               | ROLLBACK manual procedure                                                      | Before-write proof OR reconciled data under dual fence; one resumed authority                                                       | After-write/unknown divergence: RECONCILIATION_REQUIRED, block stale VPS resume               |

## Controlled post-switch safe flow checklist

HTTP smoke tooling checks CORS (allowed + denied), health/runtime database,
capabilities, no-session Activity rejection, public checkout, wallet nonce,
authenticated Activity, Arc/Uniswap readiness, Swap quote and Circle quote.
Session acquisition remains the existing user wallet auth flow; never add keys.
Session values are process memory only. No token output or persistent test artifact.

Additional receipt checks are operator-controlled, bounded and non-fund-moving:

- Browser frontend at `app.wizpay.xyz`: confirm bundled API/CSP origin and request
  destination equal the pinned API; no proxy/fallback to VPS. Desktop/mobile
  load/wallet/network/navigation states from Phase 8 plus hosted checks.
- Send prepare: use the existing frontend validation + intent/prepare-wallet
  flow with the owner's controlled empty test wallet/session. Do not sign/report
  an invented hash. Verify Mainnet canonical token/recipient/amount, persistence,
  idempotent repeat, expected cancellation if unused. This is app DB metadata
  write and must be tracked for rollback. No submit/verify without genuine evidence.
- Same-token Payroll prepare: `/tasks/payroll/init` with designated synthetic
  draft/current controller DTO, inspect contract/reference/recipient plan only;
  cross-token `/user-swap/mainnet/payroll-quote` when enabled. Do not call execute,
  confirm, report, approve or wallet send. Track persisted Task/intent metadata.
- Swap: existing read quote/prepare constraints, browser signing remains external;
  no execute/confirm, no financial hash injected. Enabled provider read must PASS.
- Bridge: `/bridge/quote` plus authenticated status of a designated known fixture
  if present; do not create a burn/mint/approval or mutate production transfer.
- Activity: existing authenticated GET ownership isolation and recent verified
  projections. Do not run unbounded sync as a smoke shortcut.
- Reconciliation: provider-side module/build readiness + read-only work/lease
  queries. No public trigger and no live reconciliation during parity comparison.
  Scheduler activation is separately controlled after single authority exists.

Capture stage/status/shape/count only. A missing session, public fixture, required
provider response or required prepare check is INCOMPLETE, not PASS. Hosted
interactive/live fund checks remain optional manual evidence, never automated.
