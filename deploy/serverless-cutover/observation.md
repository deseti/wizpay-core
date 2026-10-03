# Observation and platform-native monitoring

No fixed permanent duration is imposed. Owner approves window start/end and
limits before switching. Record UTC start/end, candidate SHA, Vercel deployment
ID, migration report/checksum, acceptance digest, source/target fencing evidence,
smoke reports, metric samples, critical-flow status and accept/rollback decision.
Use Vercel function/request logs and metrics, Supabase DB/log metrics and existing
application logs. Keep raw logs private and redact URLs/auth values; committed
summaries contain counts and fixed metric keys only. No paid monitoring required.

Review `http5xx`, `coldStarts`, `database`, `prisma`, `arcRpc`, `verification`,
`reconciliationRetries`, `stuckLeases`, `idempotencyConflicts`, `auth`,
`invoicePayment`, `swapPayrollBridge`. Compare approved thresholds and request
volume/baseline; expected user auth rejection is distinguished from rate growth.
Observe logs in fixed bounded windows, not an infinite local watcher. Evidence
must include request totals and error counts when interpreting rates. Financial
verification bypass/duplicate successful execution triggers immediate hold.
Ordinary provider timing errors require practical investigation and bounded retry.

`--observation <private-metrics.json>` requires windowApproved/windowComplete and
all 12 `{count, approvedLimit}` samples. Invalid/missing/over-limit samples return
HOLD_OR_ROLLBACK. The metric summary does not independently grant ACCEPT; all
live gates, data authority and owner decision must still hold. Track actual window
and denominators privately; do not conceal failed probes in an aggregate.

## SAFE READ-ONLY PostgreSQL checks

Run only on the explicitly acknowledged target using secure connection handling,
read-only transaction, short statement timeout and bounded output. No row data,
wallets, hashes or session values in reports. The prepared query file
[observation.sql](observation.sql) emits aggregate work/lease/retry counts.
Use repeated timestamped aggregates to spot retry growth and expired/stuck leases.
Check application logs for unique identity conflicts and invoice/Payroll/Swap/
Bridge verification errors. Existing reconciliation is bounded/idempotent but is
not invoked during migration parity checking or by this observation script.

If critical flows fail or divergent writes are found, fence ingress/background,
record the hold and follow rollback A/B. Acceptance only after approved window,
healthy critical flows, explicit owner decision and verified hosted evidence.
VPS stays alive throughout; Phase 10 decommissioning is not started.
