# Separate Vercel API validation environment

Phase 6 targets a dedicated project, suggested name `wizpay-api-serverless`.
The project and live URL are **not yet created**: the current Codex environment
has no Vercel authentication. Local packaging and isolated bundle tests are
deployment preparation, not live acceptance evidence.

Production `https://app.wizpay.xyz` continues using its existing backend.
Do not attach that domain, edit the frontend project/backend target, change DNS,
or stop the VPS. Rollback impact is none because there is no traffic cutover.

## Project and build

Set the dedicated project's root directory to `apps/backend`, framework to
Other, Node.js to **24.x**, and enable inclusion of source outside the root
directory for npm workspaces. Use `apps/backend/vercel.json`; installation runs
frozen `npm ci` at the repository root. Internal Arc/bridge packages already
ship JavaScript and need no extra compilation.

From the repository root:

```sh
npm run build:vercel -w backend
```

This generates Prisma, runs the normal Nest/TypeScript build, then traces the
runtime using pinned `@vercel/nft`. Vercel Build Output API v3 lives in
`apps/backend/.vercel/output`. One Node function routes every HTTP method/path
directly to `api/index.cjs`, which reuses `dist/serverless.js`. Nest keeps its
compiled decorator metadata, body parser, routing, headers and shared lazy
application/Prisma lifecycle; there is no listener or upstream proxy.

The artifact includes Prisma runtime/WASM assets, workspace packages and the
Phase 5 reconciliation entrypoint. It excludes environment files, Vercel
metadata, BullMQ/ioredis, queue workers and the legacy orchestration module.
Shared payroll HTTP services under `orchestrator/` remain included. The normal
VPS build and rollback source are preserved. No reconciliation HTTP route,
Cron schedule or background worker is enabled. Function maximum duration is
60 seconds; reconciliation retains its existing bounded work limits.

## Environment and database

Use the names in [environment.template](environment.template). Configure values
securely in the dedicated Vercel project's production environment. Preserve
existing approved capability flags; do not enable features just for smoke tests
or copy the frontend's environment wholesale.

`ARC_MAINNET_DATABASE_URL` must target the designated **non-production** Supabase
Transaction pooler on port 6543, database `postgres`, with the correct project
username suffix and `sslmode=verify-full`. Use an application runtime credential,
not the temporary Phase 2 CI credential. Pool size defaults to one per warm
application. No generic URL or VPS database fallback exists in this deployment
configuration. Authentication uses existing wallet challenges/sessions in
PostgreSQL; it requires no new wallet/signing secret.

Arc RPC, token and contract identities come from the unchanged Arc registry.
Do not invent RPC/address overrides. Iris defaults to its public production
endpoint and needs no custody credential. `BRIDGE_DESTINATION_RPC_<chainId>`
is required for enabled destination receipt readers. Optional analytics
automation remains disabled; no cron secret or schedule is configured here.

TLS stays certificate-verified. If the existing Supabase connection needs a
custom `sslrootcert`, its public CA file must exist inside the function artifact
at the configured path; do not reuse a temporary runner path or disable TLS.
Resolve that asset before deployment when inspecting the authenticated project's
existing database configuration.

Inspect the designated validation database's migration history first. Apply only
missing migrations using the existing explicit migration profile and its direct
or Session endpoint. Keep migration credentials outside the function environment.
Never reset that database, use the VPS database, export/import production data,
or run the Phase 7 rehearsal. Phase 6 has not applied hosted migrations yet.

## Deploy and smoke test

With Vercel authentication available, link **only** the dedicated backend project:

```sh
vercel link --cwd apps/backend --project wizpay-api-serverless
# Verify the linked project identity and production environment names securely.
npm run build:vercel -w backend
vercel deploy --cwd apps/backend --prod --prebuilt
```

Use the authenticated CLI's token flow when needed. Never put token/DB values in
commands committed to source, logs or chat. `.vercel` files are ignored. Ensure
the separate validation URL is publicly reachable under the project's protection
settings; do not change another project's settings. URL pattern:
`https://wizpay-api-serverless.vercel.app` or its generated deployment URL.

```sh
WIZPAY_VERCEL_API_URL=https://<actual-deployment>.vercel.app \
  npm run smoke:vercel -w backend
```

The smoke runner accepts only HTTPS `*.vercel.app` origins, rejects redirects,
and prints statuses/stages without response diagnostics or secrets. It checks:

- `/health`, strict production CORS, `/capabilities` and sanitized runtime isolation.
- Supabase pooler identity and a persisted **unsigned wallet-auth nonce**. This
  creates one expiring challenge for a random public address, without a key,
  signature, approval, payment or transaction.
- `/user-swap/mainnet/readiness`: actual Arc RPC/static quorum success, not merely
  HTTP 200 with `available=false`.
- A read-only Uniswap quote for enabled swap/cross-token payroll capability.
- A Base-to-Arc Fast bridge quote for enabled bridge capability, exercising
  public Iris fee/allowance reads without burning or minting.

Local artifact validation uses a dedicated loopback PostgreSQL database through
`VERCEL_API_TEST_DATABASE_URL` (`wizpay_phase6_test_admin`). It relocates the
artifact outside the checkout and verifies cold/warm concurrency, health,
headers/JSON, authorization, real Prisma persistence and shared reconciliation
without Redis. Its local `vps` database profile is a test-only fixture, not a
Vercel environment setting. Live acceptance still requires the deployed URL,
Supabase connectivity and enabled integration checks. Phase 7 is not started.
