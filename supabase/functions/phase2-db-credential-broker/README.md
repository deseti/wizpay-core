# Temporary Phase 2 database credential broker

This function belongs only to clean-project Phase 2 validation. It is not part
of the WizPay application API, wallet signing, production cutover or Phase 3.
The source is prepared for a separately authorized Supabase connector deployment
as `phase2-db-credential-broker` in the designated clean project. No deployment
or live migration is performed by preparing this source.

## Deployment contract

Use `index.ts` as the entrypoint, with `security.ts`, `database.ts`,
`direct-credentials.ts`, `handler.ts`, `deno.json` and `deno.lock` included in
the deployment bundle. The project-level function configuration is in
`supabase/config.toml`. Supabase gateway JWT verification is disabled for this
function because GitHub OIDC has a different issuer; the function itself always
performs signature and claim verification. There is no unauthenticated bootstrap
or cleanup path.

The only privileged database binding is the platform-injected `SUPABASE_DB_URL`.
`SUPABASE_URL` is checked against the fixed clean project identity. The database
URL must identify that project's direct endpoint, database `postgres` and login
`postgres`. No service-role key, admin password, arbitrary endpoint or SQL is
accepted in a request or committed to source. Provider certificate verification
is mandatory even for this privileged bootstrap connection. Missing platform
bindings or insufficient role-management privileges fail closed.

The broker needs outbound HTTPS to GitHub's fixed JWKS endpoint and the public
Supabase CA endpoint, plus PostgreSQL access to its own project's direct
endpoint. These capabilities must be verified during the separate authorized
deployment. Do not replace them with weaker TLS or a user-entered admin
credential.

## Authentication and credentials

Accept only RS256-signed JWTs verified against GitHub's fixed JWKS URL. Required
claims bind issuer, dedicated audience, repository, feature branch, subject,
workflow path/ref, supported event, run ID and attempt. A reusable-workflow
claim, when present, must match the same workflow. JWT time claims must be valid
and the token lifetime cannot exceed ten minutes. Key URL/algorithm overrides
and unsigned tokens are never accepted.

Phase 2 uses exactly one migration-infrastructure login, `wizpay_phase2_ci`,
with marker `wizpay-phase2-ci:v1`. Its 48 random password bytes are encoded as a
64-character URL-safe string and persist only as the encrypted Vault secret
`wizpay_phase2_ci_password_v1` (PostgreSQL separately stores the SCRAM
verifier). There is no 30-minute role expiry: explicit finalization after
independently accepted Phase 2 bounds its lifecycle. This is not application
runtime infrastructure and must not survive Phase 2 acceptance.

Under the existing transaction advisory lock, bootstrap inventories the exact
role and named Vault record without reading decrypted data. If both are absent,
it creates the nonprivileged role and Vault secret in the same transaction.
`vault.create_secret($1, $2, $3)` receives the password as a bound parameter;
plaintext is never interpolated into SQL text, diagnostics or logs. PostgreSQL
receives only the independently tested SCRAM-SHA-256 verifier, with
transaction-local `password_encryption = 'scram-sha-256'`.

If both exist, bootstrap checks the marker, LOGIN, NOINHERIT, unset expiry and
role configuration, administrative flags, memberships and permission boundaries
before reading only that named secret from `vault.decrypted_secrets`. It does
not recreate, rotate, update or regenerate the password. Only expected minimum
grants are re-established. A missing half, duplicate/invalid record, unexpected
marker or elevated permission fails closed; no partial-state repair occurs.

After the creation transaction commits, a separate connection authenticates to
`db.tsvzblikmgocgksgxguc.supabase.co:5432`, database `postgres`, with raw
username `wizpay_phase2_ci` and the generated or retrieved Vault password. It
reuses the fingerprint-pinned Supabase CA with `rejectUnauthorized: true`,
keeping chain and hostname verification enabled. `current_user`,
`current_database()` and this session's `pg_stat_ssl.ssl` must match. The client
closes on either outcome; this is password authentication, never privileged
`SET ROLE`. Failed direct verification returns only `request_denied` and leaves
the matched role/Vault pair intact for investigation or explicit finalization,
without rotation.

Only a successful direct test permits URL delivery in the authenticated HTTPS
response with `no-store`. Responses assert `directCredentialVerified: true` and
`credentialLifecycle: phase2-vault-v1`; the runner requires both and the fixed
role. Pooler usernames are `wizpay_phase2_ci.tsvzblikmgocgksgxguc`, on Session
port 5432 and Transaction port 6543 with `sslmode=verify-full`. The runner
immediately masks OIDC JWT, both URLs and password, and supplies credentials
only to its validation child's environment. No credential enters GitHub outputs,
`GITHUB_ENV`, artifacts, files or ordinary logs. No GitHub database secret or
manual variable is required.

## Vault and role permissions

The role is LOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
NOREPLICATION and NOBYPASSRLS. Grants remain CONNECT/CREATE on `postgres`,
USAGE/CREATE on public and DML/type usage on enumerated canonical WizPay
objects. No database-side connection limit is imposed on Supavisor's internal
pools; application validation retains its one-connection runtime pool. Reverse
membership grants the CI role to `postgres` with INHERIT/SET and preserves
PostgreSQL 17's automatic creator ADMIN grant for reuse and finalization. It
does not explicitly re-grant ADMIN to the nonsuperuser creator: PostgreSQL
rejects granting ADMIN back to one's own grantor. Multiple creator/reverse-grant
records are allowed only in this exact CI-to-postgres direction. The CI role
must belong to no other role; no provider/admin role is granted to it.

Only the broker's platform-provided `postgres` connection accesses Vault. The CI
role receives no Vault grant. Effective schema privileges, including PUBLIC,
must deny Vault USAGE/CREATE, which blocks table/view reads and function
invocation, even when a Vault function has PostgreSQL's default PUBLIC EXECUTE.
The guard also rejects access to other provider/admin schemas, unexpected
explicit object/database ACLs, grant options and default grants. Catalog access
is limited by PostgreSQL's normal catalog ACLs. Shared PUBLIC/provider ACLs are
never rewritten to satisfy the guard; an incompatible provider permission
configuration fails closed before decrypted-secret retrieval or URL delivery.
The local PostgreSQL permission fixture proves denial of `vault.secrets`,
`vault.decrypted_secrets`, `vault.create_secret` and `vault.update_secret`, and
proves a leaked PUBLIC Vault schema grant is rejected. This fixture does not
simulate Vault encryption; actual Vault encryption and provider ACLs require
separate deployment/live evidence.

## Supavisor preflight

Session preflight (and then Transaction preflight) retries only exact SQLSTATE
`28P01`, using the same role, password and endpoint. Waits are 5, 10, 15, 20 and
30 seconds: at most six attempts and 80 seconds of scheduled delay. Individual
connections have a five-second limit and the overall deadline is 110 seconds.
Failed clients close before waiting. DNS, TLS, permission and other SQLSTATE
errors fail immediately; post-connect checks, queries and migrations are never
retried by this policy. Retry evidence contains only retry count and final
PASS/FAIL, never raw driver data.

## Normal cleanup and finalization

GitHub job concurrency remains serialized with `cancel-in-progress: false`. Each
run's `always()` cleanup obtains fresh OIDC and operates only on the fixed CI
role. It terminates that role's remaining sessions, drops only owned
`wizpay_test_<32 hexadecimal characters>` schemas, verifies retained public
tables/types against canonical names/kinds, rejects unexpected owned functions
or objects, and reassigns expected retained objects to `postgres`. It preserves
LOGIN, password, Vault record and expected grants: there is no NOLOGIN, password
clearing, DROP OWNED, role deletion, secret deletion or rotation during normal
cleanup. Bootstrap re-establishes canonical object grants on the next run. Fully
absent role/secret state is a cleanup no-op; partial state fails closed.

A separate broker action `finalize` requires the same strict GitHub OIDC
identity. Optional `role` and `secret` targets must exactly equal the fixed CI
role and Vault name; arbitrary targets are rejected before connecting. No runner
command or normal workflow invokes finalization. The authorized ChatGPT/Supabase
process invokes it only after Phase 2 is independently ACCEPTED.

Finalization first commits NOLOGIN/password removal. A second locked transaction
terminates sessions, removes only owned isolated schemas, checks retained
ownership, reassigns canonical public objects, removes owned grants and drops
`wizpay_phase2_ci`. It deletes only the Vault record selected by both its UUID
and exact name `wizpay_phase2_ci_password_v1`, atomically with the role drop.
Unexpected ownership/termination failure keeps login revoked and leaves the
secret for operator review; retrying finalization can finish that revoked state.
After both are absent, finalization is idempotent. Remove the temporary broker
through the authorized connector after finalization; do not retain a production
credential API. No finalization, deployment or live migration runs from Codex.

The workflow and broker are tested locally with synthetic tokens and mocked SQL,
plus this explicit isolated PostgreSQL 17 SCRAM interoperability test using a
cached image and Vault permission fixture (no pulls, host ports, persistent
volumes or migrations):

```sh
deno test --config supabase/functions/phase2-db-credential-broker/deno.json \
  --allow-run=env \
  supabase/functions/phase2-db-credential-broker/scram-postgres-integration.ts
```

Deployment, actual Supabase role permissions/custom-role pooler authentication,
live migrations, certificate trust and cleanup remain separate live evidence.
