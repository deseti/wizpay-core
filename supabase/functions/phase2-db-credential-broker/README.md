# Temporary Phase 2 database credential broker

This function belongs only to clean-project Phase 2 validation. It is not part
of the WizPay application API, wallet signing, production cutover or Phase 3.
The source is prepared for a separately authorized Supabase connector deployment
as `phase2-db-credential-broker` in the designated clean project. No deployment
or live migration is performed by preparing this source.

## Deployment contract

Use `index.ts` as the entrypoint, with `security.ts`, `database.ts`,
`handler.ts`, `deno.json` and `deno.lock` included in the deployment bundle. The
project-level function configuration is in `supabase/config.toml`. Supabase
gateway JWT verification is disabled for this function because GitHub OIDC has a
different issuer; the function itself always performs signature and claim
verification. There is no unauthenticated bootstrap or cleanup path.

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

Each run/attempt gets a distinct bounded `wizpay_p2_<run_id>_<attempt>` role and
48 random password bytes. PostgreSQL receives a salted SCRAM-SHA-256 verifier;
plaintext passwords never enter SQL statements, broker logs or persistent broker
state. PostgreSQL necessarily stores the password verifier. The two returned
URLs are delivered only in the authenticated HTTPS response with `no-store`. The
runner immediately issues GitHub mask commands for JWT, URLs, password and role,
then supplies the validation environment only to its child process. No database
credential is written to GitHub outputs/environment files or artifacts.

The role is LOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
NOREPLICATION and NOBYPASSRLS, with a 30-minute password expiry. Runtime pools
retain the existing one-connection default. No database-side connection limit is
imposed on the provider's internal Supavisor pools. `CREATE` on database
`postgres` permits isolated schemas; it does not grant `CREATEDB`. Grants are
limited to CONNECT/CREATE on that database, USAGE/CREATE on public, and DML/type
usage on enumerated retained baseline objects when rerunning. No provider/admin
role is granted to the temporary login. The reverse membership grant lets
`postgres` terminate the role's sessions and reassign its temporary objects; it
never gives the login access to `postgres`. GitHub job concurrency and a broker
PostgreSQL transaction lock prevent overlap. Another unexpired managed role
blocks bootstrap rather than sharing credentials.

## Cleanup and reruns

The `always()` workflow step obtains a fresh OIDC token and requests cleanup for
its own run/attempt. Cleanup derives the role from signed claims; a supplied
role must match exactly. A catalog marker and nonprivileged role attributes must
also match. Replays cannot select another run's role or an arbitrary provider
role.

Cleanup commits NOLOGIN/password removal and terminates existing backend
sessions before attempting ownership changes. It then drops only UUID test
schemas owned by that role, validates retained public objects against the
canonical baseline, reassigns them to `postgres`, removes remaining grants and
drops the role. Unexpected ownership fails closed, leaving the login revoked for
operator review. It never drops public or rewrites migration history. A failed
bootstrap transaction does not leave a partly created role. Subsequent
authenticated bootstrap can reclaim expired, correctly marked roles before
issuing a new role.

If a runner is forcibly terminated before cleanup, password expiry is a
fallback, not a promise that an already-open pooled session instantly ends.
Verify cleanup and role absence after every run; expired-role reclamation
terminates sessions. After Phase 2 evidence is collected, remove this temporary
function through the authorized connector. It must not become a permanent
production credential API.

The workflow and broker are tested locally with synthetic tokens and mocked SQL.
Deployment, actual Supabase role permissions/custom-role pooler authentication,
live migrations, certificate trust and cleanup remain separate live evidence.
