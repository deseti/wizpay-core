# PostgreSQL → Supabase data rehearsal

Phase 7 implements and tests database movement only. Production remains on the
existing VPS; no traffic, DNS, contracts, data, signing or reconciliation is
changed. Production read-only export and hosted Supabase import/verification are
**deferred to the final manual-PC pass**, together with provider authentication.
Isolated results must not be described as a live production export.

[isolated-evidence.json](isolated-evidence.json) records the executed synthetic
rehearsals and comparisons; it contains no backup contents, row values or auth hashes.

## Reproducible isolated evidence

From the repository root, the Linux/Docker development helper is:

```sh
npm run migration:rehearse:isolated -w backend
```

It creates two new loopback-only PostgreSQL containers: **15 for the source**
(the current VPS Compose version), **17 for the target** (Supabase compatibility).
It uses PostgreSQL 17 native clients, the current Prisma migrations, a synthetic
relational dataset, a separate read-only source role, and a marked target.
It executes two actual custom-format dumps/restores, immediate revalidation,
failure regressions and the existing offline application tests. JSON evidence
contains only counts, structural results, archive size/checksum and deferred
steps. Its containers, database roles, fixture databases and temporary archives
are removed automatically. The native-client helper requires a compatible
Linux x86-64 host; the core CLI uses normally installed PostgreSQL 17 clients.

Fixtures populate all 15 application tables, with every ExecutionIntent status,
completed user-signed Send evidence, payroll and user-swap task state, invoices
and payment links/payments, wallet ownership, auth sessions/challenges, activity
projections/cursors, bridge and verified swaps, reconciliation retries, expired
and active leases. They include NULLs, nested JSON, Unicode, large financial
amount strings, enum values and millisecond timestamps. All addresses/hashes/
identities are fake. No chain client or financial execution service is invoked.

## Source/target contract

The compiled CLI is `apps/backend/dist/phase7/migration-rehearsal.js`:

```sh
npm run build -w backend
npm run migration:rehearse -w backend
npm run migration:rehearse -w backend -- --verify-only
```

Configure the names in [environment.template](environment.template) through a
secure local process environment. Never commit URL values or print the environment.
No generic `DATABASE_URL`/`DIRECT_URL` or application runtime URL is used.

- SOURCE is PostgreSQL 15–17, with the exact current application schema. Its
  connection role must have SELECT, no application writes/ownership/schema
  CREATE, and no administrative attributes. The tool also forces read-only
  transactions and native sessions. It cannot prepare, seed, reset or mutate
  a production source. Fixture setup is a separate isolated test operation.
- TARGET is PostgreSQL 17 and must independently match the acknowledged host
  and database. A local target name must match `wizpay_rehearsal_<32 hex>` and
  its database comment must be `wizpay-migration-rehearsal:v1`.
- Hosted TARGET must be the explicitly designated Supabase project, database
  `postgres`, on its direct endpoint or Session pooler 5432. Its project ref
  must match the host/username. Transaction pooler 6543 is rejected.
- `WIZPAY_MIGRATION_REHEARSAL_ACK=ISOLATED_TARGET_ONLY` is always mandatory.
  Lexical endpoint comparison and connected server/database identity reject
  source=target. A target with public tables, views, sequences or enum types
  is refused before migration/import. Arbitrary VPS remote targets are refused.
- External URLs require `sslmode=verify-full`; optional `sslrootcert` must point
  to a trusted readable CA. Native clients retain verify-full. Prisma uses the
  existing Phase 2 strict certificate conversion. Do not disable TLS.

Source catalog drift or a historical/retired migration chain is a failed
preflight/parity check, not permission to alter production. The final manual-PC
pass must establish the actual source schema and reconcile any approved schema
compatibility issue separately; this phase has not inspected production data.

## Export, prepare, restore, compare

The tool executes this sequence without passing credentials as command arguments:

1. Verify identities and source read-only privileges. Open a repeatable-read,
   read-only source transaction; capture catalog, counts and ordered full-row
   SHA-256 digests in memory. Fix timezone to UTC. Export that same PostgreSQL
   snapshot for `pg_dump`, so concurrent production DML cannot skew comparisons.
2. Verify the target is clean. Export using PostgreSQL 17:
   `pg_dump --format=custom --data-only --schema=public`
   `--exclude-table=public._prisma_migrations --no-owner --no-privileges`
   `--lock-wait-timeout=5s --snapshot=<held snapshot> --file=<private archive>`.
   Custom format supports archive inspection and atomic native restore. Serial
   export is deliberate; parallel delivery is unnecessary for this rehearsal.
   PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD are supplied only to the child
   environment. Source sessions use `default_transaction_read_only=on` and a
   five-second lock timeout. Normal ACCESS SHARE locks do not block DML; the
   snapshot must stay open until export/comparison finishes. Plan production
   duration and DDL coordination separately during the final pass.
3. Inspect `pg_restore --list` and require every expected application table.
   Apply the existing Prisma migrations with `prisma migrate deploy` using a
   generated non-secret config and the explicit target migration URL. Validate
   migration names/checksums and compare canonical target/source catalogs before
   importing. No schema dump, owner, ACL, login, Vault or provider object is copied.
4. Restore with `pg_restore --data-only --single-transaction --exit-on-error`
   `--no-owner --no-privileges --dbname=<acknowledged database> <archive>`.
   FK checks stay enabled. A failed data restore rolls back all imported rows;
   the newly created target migration schema may remain and must be rejected.
5. Compare every public application table's exact counts and full row content,
   ordered by immutable ID, with a bounded 1,000-row cursor. Compare all columns,
   PK/FK/check definitions and validation flags, indexes including uniqueness/
   validity/predicates, enum labels/order and non-internal triggers. Any mismatch
   fails. ExecutionIntent network must remain Arc Mainnet. The source is
   rechecked in its original consistent snapshot; fresh snapshots additionally
   prove no changes to the quiescent isolated fixture.

Only the 15 canonical public application tables move. `_prisma_migrations` is
recreated by target migrations, with current names/checksums verified and included
in the report rather than copying obsolete engine history. Retain the corresponding
repository version/migration SQL alongside any real backup. Supabase `auth`, `storage`, `vault`,
extensions, platform roles and other provider/internal schemas are excluded
explicitly. Auth sessions and short-lived challenges in WizPay's public tables
are **included exactly**, with no secret/hash/message values in reports.
No application table or auth state is silently excluded.

All durable IDs, network/operation, ownership, hashes, terminal statuses,
completion timestamps, idempotency identities, amounts, leases and retry fields
are preserved byte-for-byte in canonical JSON comparison. Leases are not reset:
expired ones become claimable naturally under existing Phase 5 rules; active
ones remain fenced until expiry. No reconciliation is invoked during import or
verification. Future cutover clock/write coordination belongs to later phases.

## Backup, retry and rollback

Temporary archive directories are mode 0700, archives mode 0600, and cleaned on
success/failure. `*.dump`, `*.backup`, `*.sql.gz` and `.migration-rehearsal/` are
ignored. To retain a successful archive, explicitly set
`WIZPAY_MIGRATION_BACKUP_DIRECTORY` to an absolute secure directory outside the
checkout; the tool creates its own private subdirectory. A SHA-256/size is
reported, not content. Real backups need encrypted storage, controlled access,
retention and independent restore verification during the final manual-PC pass.
Never use CI artifacts/public storage or commit a backup.

Before future cutover: preserve a verified backup, prepare a designated clean
target, import, and require all structural/count/integrity checks to pass.
Import or validation failure leaves SOURCE untouched and production on VPS.
Reject the target, identify the reported failed stage/parity/count checks, fix
the cause and repeat from a clean designated target.

For an explicitly marked **local** rehearsal target only, `--reset-target`
drops/recreates its public schema and performs the full rehearsal again. It
rejects unknown application objects and rechecks the marker/identity. Hosted
reset is never automated: use a fresh designated validation project for a
retry; never reset the VPS or a shared hosted project. `--verify-only` performs
read-only data/catalog revalidation without reimporting.

If a later cutover fails, the existing VPS remains the authoritative fallback
until Phase 9 acceptance. Phase 7 changes no traffic and performs no cutover.

## Evidence deferred to the final manual-PC pass

- Actual authorized production read-only schema/data export and backup verification.
- Actual hosted Supabase target preparation/import.
- Hosted migration-history/catalog, all-table counts and durable integrity checks.
- Previously deferred Supabase connectivity and Vercel deployment smoke evidence.

These are not executed evidence for this implementation pass. Missing provider
authentication does not block the isolated rehearsal acceptance. Phase 8 has
not started.
