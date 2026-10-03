# Phase 10 — VPS decommission preparation

**Preparation complete; actual shutdown and subscription cancellation deferred.**
Production `https://app.wizpay.xyz`, VPS services, DNS and data are untouched.
Actual decommission requires live Phase 9 acceptance after the approved observation
window. Offline eligibility is never live authorization. No force/skip flag,
remote shutdown/deletion/billing command or backend signing authority is provided.

[dependency-inventory.json](dependency-inventory.json) contains repository-sourced
VPS dependencies. REMOVED/REPLACED describes the serverless code graph, not live
production retirement. Legacy source/Compose/workflow remain intact. Host services,
provider callbacks, crontabs, TLS/proxy configuration and billing cannot be fully
inferred from this repository. Current host sharing is **UNKNOWN**. A historical
runbook mentions Cooket/Zonk; it is not evidence they are gone or still running.

## Read-only tooling and fail-closed gate

Build with `npm run build -w backend`, then:

```sh
npm run decommission:check -w backend
npm run decommission:check -w backend -- --simulate
npm run decommission:check -w backend -- --repository-preflight
```

Default `--check` without live evidence reports **BLOCKED**, exit 1, actions 0.
`--simulate` uses synthetic identities/DNS/receipts/backup metadata, with 13
positive/failure/host-sharing cases and zero production contacts. It reports only
ELIGIBLE_IN_SIMULATION, never live eligibility. Repository preflight is **SAFE
READ-ONLY**; set the pinned non-secret `WIZPAY_DECOMMISSION_CANDIDATE_SHA` explicitly.
It reuses Phase 9 artifact/config/evidence checks, checks recovery docs/inventory
and resolves remote archive/tag identities using fixed read-only Git operations.
No credential values or full process environment are read/reported.

For the later operator session, `--check <private-evidence.json>` requires the
exact `WIZPAY_DECOMMISSION_RELEASE_SHA` separately from the tooling candidate SHA.
The evidence shape is `src/phase10/decommission.ts::DecommissionEvidence`:
LIVE scope; release-bound complete Phase 9 receipts; approved completed observation;
current observedAt/validUntil; all REQUIRED_CHECKS; pinned deployment/project/resource
identity; source writes stopped / target authoritative; both verified backups;
complete active DNS/frontend routing; reconciliation metrics and recent healthy
batch; complete integrations inventory; inspected host-sharing/resource ownership.
Release digests and archive references must also match repository preflight.

Evidence files are verified operator receipts, not cryptographic proof of provider
state. Attach actual reports privately and verify their origin/release/currency.
Do not stamp fixtures LIVE or count a repository PASS as hosted acceptance. Missing,
expired, incomplete, conflicting or failed evidence means DECOMMISSION=BLOCKED.
An eligible result is **ELIGIBLE_FOR_OPERATOR_REVIEW**, not an executed shutdown or
permission to skip the final owner approval. There is no executable stop/cancel path.

Use `--dns-check <private-evidence.json>` only in the final session with explicit
`WIZPAY_DECOMMISSION_READONLY_ACK=PINNED_READONLY_DNS`. This **SAFE READ-ONLY**
collector follows A/AAAA/CNAME chains (16 names maximum, bounded queries), rejects
unresolved/cyclic chains and checks known VPS IPs/aliases. Output is counts/result,
not credentials, environment, DNS answers or database rows. No DNS mutation. Raw
operator evidence stays encrypted/private outside Git; `.cutover-evidence/` is
ignored as a last-resort local safeguard. No real backups are produced now.

Run the isolated acceptance runner for real PostgreSQL/catalog/backup rehearsal,
packaged serverless behavior, Phase 8 parity, Phase 9 gates and Phase 10 checks:

```sh
WIZPAY_TEST_CHROMIUM_PATH=/usr/bin/chromium bash deploy/serverless-decommission/run-isolated.sh
```

**DESTRUCTIVE ISOLATED ONLY**: owns/removes only newly created loopback containers
and synthetic fixture databases. Injected external DB URLs are cleared. No chain
execution, provider credential requirement or production access is involved.

## Live checks to record later

- Frontend: exact deployed `NEXT_PUBLIC_API_URL` must match pinned Vercel origin;
  verify bundled URL, CSP, production browser requests, service worker/stale build
  behavior and no automatic VPS fallback. Historical rollback URLs are docs only.
- DNS: inspect app/API aliases and complete active CNAME/A/AAAA chains against
  independently obtained VPS IPv4/IPv6/aliases. Empty/unknown VPS identity is not
  proof. Include active integration/monitoring destinations. Historical inactive
  names may remain only with verified no production traffic/stale clients.
- Supabase: actual deployed API reads/writes this project, current financial
  evidence and reconciliation state validated; source PostgreSQL is fenced and
  no longer receives production writes. Ambiguous or dual authority blocks.
- Reconciliation: authenticated trusted invocation, recent successful or verified
  empty bounded batch, approved pending/retry/expired-lease/failure/conflict limits.
  No eligible jobs alone does not prove a scheduler is running. The prepared
  [reconciliation.sql](reconciliation.sql) emits read-only aggregates; retry growth
  and recent empty batches require timestamped samples / platform logs.
- Redis/BullMQ: packaged artifact excludes transports; existing Phase 3–5/8 tests
  cover request-critical paths. Hosted enabled flows and reconciliation must prove
  no legacy worker reliance. Never delete source to pretend the check passed.
- Integrations: inspect provider dashboards, analytics update scheduler, trusted
  reconciliation scheduler, host cron/systemd, monitoring probes and SSH deployment.
  No backend financial webhook was found in source; that is not proof of absence.
- Host sharing: inspect all projects/users/containers/volumes/networks/proxies/
  schedules/backups, and subscription ownership. UNKNOWN blocks all shutdown
  eligibility; YES allows isolated WizPay workloads only, never cancellation;
  NO permits cancellation review only after every other gate. Do not stop shared
  Caddy/Nginx, Docker daemon, database/Redis instance or other project's service.

## CI/CD retirement — plan only

`.github/workflows/cd-production.yml` is manual SSH deployment to a `main` checkout,
using WIZPAY_VM_HOST/USER/SSH_KEY; it can migrate/build/restart Compose. Preserve it
until live Phase 9 acceptance and final retirement approval. At that time prevent
new dispatches, verify no running deployment, disable/retire the VPS workflow and
bindings deliberately, then revoke the scoped SSH key after encrypted recovery
access is verified. Keep source in historical references. Do not touch Phase 2
secretless validation or Vercel/frontend projects blindly. No CI/CD was disabled
or deleted during this preparation pass.

[checklist.md](checklist.md) gives shutdown/post-shutdown sequencing.
[recovery.md](recovery.md) gives backup and disaster-recovery procedures.
[environment-recovery.json](environment-recovery.json) classifies variable names
ACTIVE_SERVERLESS/HISTORICAL_VPS/RETIRED/MANUAL_VERIFY and secure management location.
The names-only template is not deployable. No wallet private key/custody material
may be introduced, even for historical recovery.

## Deferred final manual-PC work

Complete hosted Supabase verification, Vercel deployment/smoke, final read-only
source export, hosted import/parity and interactive feature evidence. Perform the
Phase 9 deliberate single-authority switch, approved observation and live owner
acceptance while keeping VPS alive. Then gather the live Phase 10 evidence above,
verified backups/recovery, DNS/integration/host-sharing inspection and final owner
approval. Only then execute scoped service retirement, post-shutdown validation,
credential retirement and conditional subscription cancellation. Preserve final
private evidence and record actual completion separately. No live Phase 9 or
actual Phase 10 acceptance is recorded here.
