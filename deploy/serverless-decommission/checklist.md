# Final operator checklist — deferred, not executed

Every step is release/evidence-bound. Missing evidence means BLOCKED, with no
force/skip option. Codes below classify actions. Read-only HTTP application probes
can still update invoice expiry/auth session timestamps; account for those writes
in authority/backup evidence. Default smoke never moves funds.

| Step | Classification                                            | Required action and evidence                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | SAFE READ-ONLY                                            | Verify LIVE Phase 9 ACCEPTED receipts, approved observation completion and explicit owner decision; offline fixtures do not qualify.                                                                                                         |
| 2    | SAFE READ-ONLY                                            | Pin serverless Git SHA/deployment ID/project/DB/acceptance digests; approve current evidence expiry and final operator plan.                                                                                                                 |
| 3    | SAFE READ-ONLY / controlled metadata writes               | Reuse Phase 9 hosted smoke and frontend routing checks, preserve production error/critical-flow evidence. No execute/broadcast/approve.                                                                                                      |
| 4    | SAFE READ-ONLY                                            | Verify Supabase sole write authority, current intents/evidence and VPS writer fence; source divergence blocks retirement.                                                                                                                    |
| 5    | SAFE READ-ONLY                                            | Verify recent successful/verified-empty trusted reconciliation, retry growth/leases/failures/conflicts and no legacy worker dependence.                                                                                                      |
| 6    | SAFE READ-ONLY export; isolated TARGET WRITE restore test | Preserve CURRENT authoritative Supabase backup, checksum/catalog/count/full-column evidence and independently verified restore.                                                                                                              |
| 7    | SAFE READ-ONLY export; isolated TARGET WRITE restore test | Preserve final frozen VPS Mainnet PostgreSQL backup/config, checksum and restore evidence. Historical Testnet backup does not substitute.                                                                                                    |
| 8    | SAFE READ-ONLY                                            | Resolve archive branch and stable tag/peeled commit; verify exact object identity, preserve immutable source and migration/release records.                                                                                                  |
| 9    | SAFE READ-ONLY                                            | Validate all active DNS chains, deployed frontend URL/CSP/stale clients and no production requests reaching VPS.                                                                                                                             |
| 10   | SAFE READ-ONLY / separate approved configuration changes  | Inventory webhooks, callbacks, root/user cron/systemd, CI deployments and monitoring; retire/repoint active VPS destinations before shutdown approval.                                                                                       |
| 11   | SAFE READ-ONLY                                            | Confirm enabled serverless features and recovery have no Redis/BullMQ/legacy worker requirement. Keep rollback source.                                                                                                                       |
| 12   | SAFE READ-ONLY                                            | Inspect actual host-sharing/ownership. UNKNOWN blocks; YES permits WizPay-only isolated resources; NO is required for subscription cancellation. Evaluate gate and obtain owner approval.                                                    |
| 13   | VPS WORKLOAD STOP — NOT NOW                               | Stop/disable only independently inventoried WizPay worker/scheduler processes. Current Compose integrates BullMQ workers inside backend; do not invent a separate worker service. If inseparable, step 14 stops them together.               |
| 14   | VPS WORKLOAD STOP — NOT NOW                               | Gracefully stop only the scoped WizPay backend after production writers are fenced. Preserve logs/config/volumes and avoid any shared daemon/proxy.                                                                                          |
| 15   | SAFE READ-ONLY / controlled metadata writes               | Observe target health, DB path, auth/Activity/read/prepare flows, reconciliation and provider/monitoring errors with backend unavailable. Failure: hold retirement, investigate chosen authoritative data, never route blindly to stale VPS. |
| 16   | VPS WORKLOAD STOP — NOT NOW                               | Stop only WizPay-specific Redis/PostgreSQL after verified backups, authority and post-backend-stop health. Shared instances block this step. No volume deletion.                                                                             |
| 17   | CREDENTIAL CHANGE — NOT NOW                               | Preserve encrypted recovery records; revoke scoped SSH/DB/analytics credentials only after consumer inventory, rotation dependency checks and recovery access verification. Retain active Vercel/Supabase credentials.                       |
| 18   | DESTRUCTIVE — NOT NOW                                     | Remove scoped deployment only under separate approved ownership/retention procedure after recovery evidence is preserved. Never docker prune/down -v or global proxy deletion.                                                               |
| 19   | BILLING CANCELLATION — NOT NOW                            | Only HOST_HAS_OTHER_WORKLOADS=NO, all gates passed and explicit owner approval; verify provider account/subscription identity. YES/UNKNOWN never cancel the host. No automated billing command.                                              |
| 20   | RECORD — deferred                                         | Record actual service retirement times, post-shutdown evidence, owner decision, retained recovery location/retention and conditional billing outcome. Mark actual completion only after execution.                                           |

## Scoped service stop reference — manual only after steps 1–12

The reviewed legacy project is `wizpay-arc-mainnet` with services `backend`,
`postgres`, `redis` and on-demand `migrate`. Actual host paths/ownership must be
verified; keep credentials in the protected environment file. Under final
operator authorization only, the reviewed per-service operation is conceptually:

```text
VPS WORKLOAD STOP:
docker compose --project-name wizpay-arc-mainnet --env-file <verified-private-env-path> -f <verified-compose-path> stop backend
# Observe serverless production after backend/embedded workers stop.
docker compose --project-name wizpay-arc-mainnet --env-file <verified-private-env-path> -f <verified-compose-path> stop redis postgres
```

These are documentation, not runnable preparation scripts. Do not SSH, run them
locally against production selectors, stop Caddy/Nginx/system Docker, or remove
volumes. If the host shares services, stop only independently verified owned
resources or defer the affected operation. Destructive data removal has a separate
retention approval; cancellation must preserve accessible encrypted backups.

## Post-shutdown acceptance

Re-run pinned hosted smoke plus frontend desktop/mobile route/request checks:
frontend loads; Vercel health/capabilities/CORS; actual Supabase DB/auth path;
public checkout and authenticated safe reads/Activity; prepare-only Send/same-
and cross-token Payroll/Swap/Bridge; trusted reconciliation continues. No signing,
payment broadcast or token approval. Check no attempted VPS connections/DNS
failures, webhook/scheduler/monitoring errors or lingering CI restarts. Record
errors and current data evidence, using the approved observation procedure rather
than inventing a permanent fixed duration. Shared other-project health must remain
unaffected. Any failed required check blocks destructive removal/cancellation.

After accepted decommission, historical VPS reference is disaster recovery only;
normal production must never silently fall back to its stale PostgreSQL state.
