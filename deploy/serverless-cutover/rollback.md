# Immediate rollback with database authority

VPS stays alive at pinned stable source/recovery reference
`9900052a04ba807d937a9687f21d9933ffee33dd` / `vps-production-9900052`; keep actual
pre-cutover API origin/build/config captured privately. Do not reset Git/tag or
redeploy a different baseline impulsively. No automatic API fallback exists.

## A — before new target writes

**ROLLBACK**, manual only: fence target ingress and scheduler/background activity.
Prove there are no post-snapshot target writes (auth/challenge/activity/intent
metadata count as writes, not just token transfers). A negative guess or lack of
financial transactions is not proof. Verify source still matches final capture.
Restore recorded `NEXT_PUBLIC_API_URL` to VPS in frontend configuration and
rebuild/redeploy deliberately. Verify CSP/browser routing and read-only VPS smoke,
then resume source writes only after target writers and stale-client target
access are fenced. One DB authority. Keep target evidence for diagnosis; no
source data import/delete and no blind target reset.

If failure occurs before export, retain source authority and leave target unused.
If writers were fenced, resume under approved controls only after checking that
no post-capture evidence was lost. `ROLLBACK_READY` means a safe-plan
recommendation, not that routing or writer controls have executed.

## B — after target writes, or write history unknown

**RECONCILIATION_REQUIRED**. Do not point users at the old writable VPS database.
**ROLLBACK**: pause both ingress write paths, old-client routes and every source
and target scheduler/worker. Preserve read-only availability where safe. Capture
both DBs and target logs privately with verified consistent backups. Account for
in-flight user-wallet submissions; preserve real hashes and immutable identities.

Choose the authoritative dataset explicitly. Reconcile target/source changes,
including ExecutionIntent unique identities, hashes/evidence/terminal state,
invoices/payments, Task units/counters, wallet/session ownership, activity
idempotency and reconciliation leases/retries. A full verified replacement on a
fresh recovery DB or reviewed deterministic delta merge may be selected by the
owner; this pass implements neither an automatic merge nor destructive restore.
Do not replay payments, invent evidence, reset financial states or copy counters
blindly. Reject uniqueness/ownership/network conflicts for review.

Use Phase 7 catalog/count/full-column checks plus operation-specific data conflict
review on the reconciled authority **before resuming writes**. Rebind the chosen
backend to that verified dataset and deliberately restore frontend routing.
Resume only one authority after all stale endpoints and competing workers are
fenced. If reconciliation is incomplete, hold writes; maintain the verified
current target for recovery rather than silently losing new evidence.

The reducer blocks immediate rollback for PRESENT writes even if a caller claims
no writes; UNKNOWN also requires independent no-write proof. Unsigned nonce smoke
and authenticated `lastUsedAt` updates can cause divergence. Accepted ledger
results are immutable; a subsequent incident requires a new pinned release and
recovery evidence rather than rewriting prior acceptance.
