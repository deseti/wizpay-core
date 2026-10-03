# Backup and disaster recovery

## Immutable identities

Stable source: `9900052a04ba807d937a9687f21d9933ffee33dd`.
Archive branch: `archive/vps-production`.
Tag: `vps-production-9900052`; annotated object
`426befe96592a662e4656299b5aa83350d8c8044`, peeled stable SHA above.
Migration candidate before Phase 10: `3cd08a58da38bc401736e027df2068045a851785` on
`feat/serverless-free-stack`. Final serverless release/deployment/migration report
IDs/timestamps are placeholders until the final manual-PC session pins them.
Read-only Git verification must match branch/peeled SHA/tag object; never move
references or recreate the tag. These preserve source, not production data/secrets.

## Required final backup package (private, encrypted, outside Git)

- Frozen final VPS **Mainnet** PostgreSQL consistent snapshot and backup checksum,
  bytes, UTC time, source identity/read-only role and final source capture ID.
- **Current authoritative Supabase** consistent snapshot, current serverless
  release/migration identity, checksum and verified production financial/recovery
  state. Source and target can legitimately differ after cutover; do not equate a
  stale VPS backup with the latest production state.
- Schema/migration checksum/catalog/PK/unique/FK/check/index/enum evidence,
  all application counts and full-column integrity checks. Keep actual row/auth
  data private; reports expose only equality/counts. Preserve ExecutionIntent
  immutable identities/hash/network/wallet/terminal state, invoice ownership,
  task relationships/counters, swap/bridge evidence and reconciliation leases/retries.
- Independently validated restore into a new isolated database, with deterministic
  commands from Phase 7. Backup existence/checksum alone is not a restore test.
  Include Supabase provider schema/role/extension prerequisites separately;
  application-data-only Phase 7 export does not back up all provider infrastructure.
- Immutable source/tag plus exact reviewed deployment config, Compose/Dockerfile/
  entrypoint, dependency lockfile/images/digests, backend build/runtime version,
  network/port/proxy/TLS/service ownership and environment-name inventory.
- Encrypted recovery secret bundle in owner-controlled vault with independent
  access/recovery verification, encryption/key-recovery procedure, access owners,
  retention and deletion approval. No plaintext `.env`, auth rows, credentials or
  TLS private material in Git/CI artifacts/public logs. Do not save user-wallet
  keys or invent backend payment signing material.

Use standard PostgreSQL consistent custom-format export/atomic restore from
[Phase 7](../serverless-data-migration/README.md); keep source read-only. Protect
archives with restrictive permissions and encryption, transfer securely, verify
checksum after transfer, then restore and compare. Do not reset source or an
occupied hosted DB. Live backups/restores are deferred, not executed in this pass.
Historical Testnet backup in the old cutover runbook is retained history only,
not proof of current Mainnet data or adequate shutdown recovery.

## Rebuild assumptions and secure env recovery

Use the verified stable tag/archive checkout on **new isolated recovery
infrastructure**, not a mutated production checkout. Inspect its own lockfile,
Dockerfiles and Compose rather than assuming current migration HEAD is identical.
Historical Compose specifies PostgreSQL 15, Redis 7 and backend Node image from
that revision; record actual image digests/host runtime versions at archival time.
The current stateless artifact uses Node 24 and Supabase PostgreSQL 17 compatibility.
Keep migrations and schema aligned to the selected backup; never restore modern
financial state into an incompatible old schema blindly.

Historical backend listens on container 4000 / host loopback default 4100, with
scoped Docker bridge/network/volumes and Caddy public TLS proxy. Frontend is
Vercel, not a VPS production frontend container. Inspect actual project ownership,
proxy includes, renewal jobs, firewall/systemd/users and shared services. Recovery
must not consume another project's volumes, expose PostgreSQL publicly, enable
legacy financial executors or restore retired Testnet/custodial config.

[environment-recovery.json](environment-recovery.json) lists names, management
location, historical consumer and target requirement. Values are retrieved only
from the secure owner/provider store at recovery time. Historical scoped DB/Redis
and SSH values are VPS-only; serverless API uses its explicit Supabase transaction
profile, verify-full TLS, Mainnet config, CORS and approved capabilities. Retired
DATABASE_URL/DIRECT_URL fallbacks and custody/signing names stay forbidden. Public
Mainnet contracts and user-wallet authority stay unchanged.

## Disaster recovery after actual decommission

Declare an incident and fence affected writer/scheduler paths. Determine the
latest authoritative production dataset (normally current Supabase backup plus
verified subsequent evidence), not the old VPS snapshot. Account for in-flight
user-wallet submissions, preserving real hashes and ownership/idempotency.
Restore to a new isolated recovery target; run full catalog/count/content and
operation-specific conflict verification. Recover/reconcile newer evidence before
choosing a single production authority. Preserve terminal states/leases and do
not execute/rebroadcast payments or reset intents. Validate read/prepare/auth
flows and release/network identity, then obtain explicit owner routing approval.

Old source is a historical rebuild reference, **not an active automatic fallback**.
A legacy source build does not authorize launching its obsolete Payroll/Swap
financial workers. Normal production cannot silently return to a stale database.
Any new recovery deployment/traffic move is a separately authorized incident action.
Retain verified backups/source/config until approved retention expires; recovery
access and encryption-key availability must survive VPS subscription cancellation.
