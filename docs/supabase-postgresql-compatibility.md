---
title: "Supabase PostgreSQL Compatibility"
description: "Phase 2 database connection profiles and clean nonproduction validation."
---

# Supabase PostgreSQL Compatibility

## Scope

Phase 2 keeps [schema.prisma](../apps/backend/src/database/schema.prisma) and
the [existing migration chain](../apps/backend/src/database/migrations)
canonical and unchanged. The single fresh baseline uses standard PostgreSQL
tables, enums, JSONB, UUID, timestamp defaults, indexes and foreign keys. It
does not create roles/databases/extensions, change ownership, read server
files, require superuser operations or reference Supabase Auth schemas.
UUID and `updatedAt` values are supplied by Prisma where the migration has no
SQL default. PostgreSQL 17 reproduction is tested locally; live Supabase
evidence remains separately required.

The clean Supabase project is migration-validation infrastructure. No VPS
production database access, production data export/import, production config
replacement, frontend cutover or deployment is authorized by this procedure.
No HTTP handler, Redis/BullMQ removal or future queue/scheduler is introduced.
The Phase 1 archive, tag and deployment recovery sources remain intact.

## Connection purposes and configuration

[database-connection.config.ts](../apps/backend/src/database/database-connection.config.ts)
defines the following boundaries:

| Name | Purpose |
| --- | --- |
| `WIZPAY_DATABASE_PROFILE` | `vps` by default, or explicit `supavisor-transaction`; unknown/blank profiles fail closed. The default keeps existing VPS driver behavior. |
| `ARC_MAINNET_DATABASE_URL` | Runtime endpoint. For the transaction profile, supply the project-provided Supavisor transaction-pooler URL. Never derive a pooler host from the region or put this value in frontend/public variables. |
| `WIZPAY_DATABASE_POOL_MAX` | Transaction profile only: default 1, integer override 1–3. The adapter owns one pool per PrismaService, not one connection/pool per query. |
| `ARC_MAINNET_MIGRATION_DATABASE_URL` | Dedicated CLI direct/session endpoint. Mandatory in the transaction profile; no fallback to the runtime URL. Runtime does not need this binding. |
| `WIZPAY_MIGRATION_DATABASE_MODE` | Transaction-profile CLI tooling requires the explicit value `direct` or `session`. Use the supplied project's direct URL if reachable, otherwise its explicitly supplied session-mode pooler URL. |
| `WIZPAY_ARC_NETWORK`, `WIZPAY_MIGRATION_NETWORK` | Existing explicit matching `arc-mainnet` migration selectors. API/worker network, capabilities, Redis and queue isolation remain unchanged. |

The legacy VPS profile deliberately retains its existing shared direct
`ARC_MAINNET_DATABASE_URL` CLI/runtime connection. If a dedicated migration URL
is explicitly supplied, CLI uses it; an empty binding is an error. This is
legacy profile behavior, not a fallback from missing transaction-profile
migration configuration. Known Supavisor runtime endpoints cannot silently use
the default VPS profile. `DATABASE_URL` and `DIRECT_URL` inputs are rejected by
runtime/CLI isolation; only validation derives the internal runtime
`DATABASE_URL`. Supavisor runtime endpoints are not rewritten to Docker/loopback
hosts. Existing VPS Compose/templates are unchanged.

Credentials are distinct by purpose: migration credentials stay in operator
tooling and should have only the schema-management permissions needed; runtime
credentials belong only to the server runtime. The clean test project can use
the same database principal via different supplied endpoint modes, but this
does not mean migration credentials should be injected into a future HTTP
function. No `service_role` key, Supabase Auth dependency or new wallet authority
is involved. Database roles/grants and public Data API exposure must be checked
on the actual target before any later production use; this phase does not claim
that provider-default privileges are safe for production.

## TLS, pool lifetime and transaction compatibility

Transaction-profile URLs use `sslmode=verify-full`. Optional `sslrootcert`
references an operator-provided trusted CA file outside tracked source when
required. Other URL options are rejected rather than overriding identity,
session state, TLS or pool limits. The `pg` adapter receives explicit fields
with `rejectUnauthorized: true`, the supplied CA if present, a 10-second
connection timeout and 10-second idle timeout, plus `allowExitOnIdle: true`.
There is no certificate-verification bypass. Concurrency across many function
instances is still multiplicative: the per-instance cap does not replace a
provider/project connection budget or later concurrency controls.

Native Prisma CLI engines use different TLS options from `pg`. The migration
resolver converts the verified configuration to `sslmode=require` plus
`sslaccept=strict`, mapping the trusted root file to native `sslcert`. Passing
`pg` URL options through unchanged was found insufficient in a local negative
certificate test; the strict native path rejects an untrusted certificate.
No URLs, passwords or CA contents are logged by the new configuration code.

[PrismaService](../apps/backend/src/database/prisma.service.ts) still creates
one adapter, connects during module initialization with bounded retries and
disconnects during shutdown. Future warm-function application reuse is outside
Phase 2; do not create PrismaService per query. Default VPS pool maximum remains
the installed `pg` default of 10, while transaction profile defaults to 1.

The pinned PrismaPg adapter has no statement-name generator configured. Its
queries are unnamed parameterized queries, with no cached named prepared
statements. A driver-contract test exercises that behavior and verifies that
`BEGIN`, `SET TRANSACTION ISOLATION LEVEL`, and subsequent transaction queries
use the same checked-out client until commit/rollback. Transaction-local
isolation and database row leases do not require session affinity between
transactions. Application code uses no `LISTEN/NOTIFY`, session-level `SET`,
session advisory locks or temporary tables. Prisma CLI migration advisory
locking/session behavior remains on the dedicated direct/session endpoint,
never on the transaction pooler. Test setup's `SET LOCAL search_path` occurs
inside a transaction on one migration connection and is not runtime session
state. These findings require a live transaction-pooler check before acceptance.

## Safe clean-project migration validation

Obtain both endpoint strings from the authorized clean project's connection
panel and inject them through secure operator environment configuration. Do not
paste passwords into chat, commit `.env`, echo URLs, enable shell tracing, or
reuse VPS production credentials. This document intentionally contains no
project reference, hostname, password or full connection string.

Use a fresh operator shell in the repository root with these secure bindings:

- `WIZPAY_EXTERNAL_TEST_DATABASE_URL`: clean project's direct/session URL with
  verified TLS; not the transaction-pooler endpoint.
- `WIZPAY_EXTERNAL_TEST_TARGET_HOST`: independently confirm its exact hostname.
- `WIZPAY_EXTERNAL_TEST_TARGET_DATABASE`: independently confirm its database name.
- `WIZPAY_EXTERNAL_TEST_ACK=ISOLATED_NONPRODUCTION_SCHEMA`: acknowledge that this
  target is nonproduction and allows creation/removal of temporary test schemas.
- `WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL`: clean project's transaction-pooler
  URL with verified TLS, for runtime persistence tests.
- `WIZPAY_EXTERNAL_TEST_RUNTIME_TARGET_HOST`: independently confirm that runtime
  endpoint's hostname; both test connections must reach the same clean project.
- `WIZPAY_MIGRATION_DATABASE_MODE`: explicitly `direct` or `session`, matching
  the supplied migration endpoint. No generic `DATABASE_URL`/`DIRECT_URL` binding.

Do not begin if target identity, mode, TLS or permission scope is uncertain.
The checker rejects production `NODE_ENV`, missing acknowledgements, endpoint
mismatch and known transaction-pooler setup endpoints. It cannot independently
prove that an operator-labelled remote project is nonproduction; verify the
project in the provider panel before setting the acknowledgement.

Run these commands, stopping on any failure:

```sh
set -e
export WIZPAY_DATABASE_PROFILE=supavisor-transaction
export WIZPAY_ARC_NETWORK=arc-mainnet
export WIZPAY_MIGRATION_NETWORK=arc-mainnet
export ARC_MAINNET_MIGRATION_DATABASE_URL="$WIZPAY_EXTERNAL_TEST_DATABASE_URL"

npm run prisma:generate -w backend
npm exec -w backend -- prisma validate
npm exec -w backend -- ts-node test/check-postgres-catalog.ts --preflight
npm run prisma:migrate:arc-mainnet -w backend
npm exec -w backend -- prisma migrate status
npm exec -w backend -- ts-node test/check-postgres-catalog.ts

npm run test -w backend -- --runInBand --runTestsByPath \
  src/execution-intent/execution-intent.postgres.spec.ts \
  src/phase7/phase7-offline-rehearsal.postgres.spec.ts \
  src/database/persistence.postgres.spec.ts
```

The read-only preflight requires PostgreSQL 17 and an empty public table set.
Never reset an existing database to satisfy it. Apply the unchanged migrations
in order with `migrate deploy`, never `db push` or `migrate reset`. Re-running
`migrate deploy`/`migrate status` after successful application is expected to be
idempotent; the empty-schema preflight is only for the initial application.
The read-only catalog checker verifies the canonical migration checksums/state,
14 tables and their column types/nullability/defaults, six enums, 49 indexes
including uniqueness/column definitions, primary keys and four cascading
foreign keys. Lease/idempotency structures are covered by those columns/indexes
and behavioral integration assertions. Preserve failure output securely without
publishing credential-bearing driver logs. No production data is involved.

## Shared integration coverage and remaining evidence

[postgres-harness.ts](../apps/backend/test/postgres-harness.ts) retains the
existing dedicated local admin-database guards. Explicit external mode instead
creates UUID-named test schemas, applies the migration chain in a pinned
session, and supplies the adapter schema to runtime clients. Only schemas
created by that harness are dropped on cleanup. It does not clear the public
application schema, require `CREATE DATABASE` on Supabase, or introduce schema
changes. Do not set local and external targets simultaneously. Normal test runs
without a target retain explicit skipped integration outcomes.

Existing ExecutionIntent/rehearsal tests retain uniqueness, recovery and receipt
checks; previously dormant historical readiness/token assertions are corrected
to the current registry, and cross-namespace isolation asserts deterministic
logical keys plus distinct IDs and independent state. Added database-backed
tests cover terminal guards, one-time wallet challenges and hashed/revocable
sessions, transactional/idempotent TaskUnit counters and rollback, invoice
evidence uniqueness/foreign keys, bridge evidence/restart persistence,
verified-swap uniqueness, and activity ownership/idempotency/sync leases.
Signature and chain receipt I/O use offline fixtures; no payment is broadcast.

Source-level tests and local PostgreSQL 17/TLS tests are available without live
Supabase credentials. Live evidence still needs clean-project migration/status,
the catalog/history report, all three suites over the supplied transaction
pooler, secure certificate verification and permission/lifecycle compatibility.
No Phase 2 acceptance or Phase 3 implementation follows automatically.

## Remote validation when Codex cannot reach PostgreSQL

[Phase 2 clean Supabase validation](../.github/workflows/phase2-supabase-validation.yml)
provides a GitHub-hosted runner path for the same migration chain and three
integration suites. It runs only on `feat/serverless-free-stack`; it has no
deployment steps or production credentials. Installation and Prisma generation
run before database secrets are supplied to the validation step.

Provision the existing authorized clean-project URLs as repository Actions
secrets named `WIZPAY_EXTERNAL_TEST_DATABASE_URL` and
`WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL`. Set the independently confirmed
endpoint hostnames as repository Actions variables
`WIZPAY_EXTERNAL_TEST_TARGET_HOST` and
`WIZPAY_EXTERNAL_TEST_RUNTIME_TARGET_HOST`. When the provider certificate needs
an explicit trusted root, provision the provider-issued PEM as
`WIZPAY_EXTERNAL_TEST_CA_PEM`; it is written only to a temporary runner file and
removed afterward. Never substitute an unverified certificate or disable TLS.
Credentials must be transferred through the GitHub secret API or browser
settings, never through Git, workflow inputs or logs.

[validate-live-supabase.ts](../apps/backend/test/validate-live-supabase.ts)
adds a missing `verify-full` option only in process, verifies both endpoint
modes and certificate authorization, checks PostgreSQL 17 and setup permissions,
then runs migration status/deploy/status/repeated deploy, the catalog/history
checker, and all three suites with the transaction endpoint mandatory. It
checks cleanup and zero public application rows afterward. A rerun accepts only
a canonical, fully migrated schema containing no application data; unfamiliar
or partially migrated schemas fail closed without reset or repair.

Only selected metadata, command outcomes and numeric test summaries are emitted.
Raw child-process/driver output stays in memory and is not uploaded. A workflow
failure is evidence of its failed stage, not acceptance. Missing bindings fail
before any database writes. A push changing the workflow/validator triggers the
feature-branch run; after provisioning bindings, use the Actions browser or API
to rerun it. The workflow need not be merged into `main` to rerun an existing
push-triggered run. Dispatch requires GitHub's default-branch workflow
registration, so do not change `main` merely to enable dispatch.

During the cloud investigation, native DNS returned `EAI_AGAIN` and direct DNS
queries returned `ECONNREFUSED`; GitHub API requests through the cloud proxy
returned `Forbidden`. These observations do not establish a product defect or
a failed Supabase TLS/authentication check. The remote workflow remains unproven
until it executes with authorized bindings and its evidence is reviewed.
