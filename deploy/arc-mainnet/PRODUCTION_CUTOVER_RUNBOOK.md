# WizPay fresh Arc Mainnet production cutover

This runbook is for a later, explicitly authorized maintenance window. It is
not authorization to access the VPS, deploy, alter DNS/Vercel, or broadcast a
transaction now.

The target is a fresh Arc Mainnet installation. The historical Testnet
database, Redis state, sessions, activity, migration history, and `.env` must
not be reused.

## 1. Completed Testnet-retirement checkpoint

The following work is already complete on the VPS and must not be repeated:

- old WizPay Testnet containers, PostgreSQL volume, network, backend/frontend
  images, checkout, `.env`, migration directory, and Caddy block were removed;
- WizPay references were removed from Caddy backup files;
- Caddy remains valid and active, while Cooket and Zonk remain intact;
- `/home/wizpay/apps/wizpay` exists and is empty; and
- `/home/wizpay/backups/wizpay-20260922T140530Z` is retained.

Perform only these read-only checkpoint checks. Do not recreate, move, stop, or
remove retired Testnet resources:

```sh
test -d /home/wizpay/apps/wizpay
find /home/wizpay/apps/wizpay -mindepth 1 -maxdepth 1 -printf '%f\n'
test -d /home/wizpay/backups/wizpay-20260922T140530Z
systemctl is-active --quiet caddy
```

The application directory must be empty. Stop for operator review if it is
not, or if the retained backup or active Caddy service is absent.

## 2. Create a fresh future Mainnet checkout

Use the reviewed future Mainnet repository origin; do not guess it:

```sh
git clone --branch main --single-branch <reviewed-mainnet-repository-origin> /home/wizpay/apps/wizpay/repo
cd /home/wizpay/apps/wizpay/repo
test "$(git branch --show-current)" = main
test -z "$(git status --short)"
git log -1 --oneline
```

Confirm the checked-out commit is the reviewed Mainnet release before
continuing.

## 3. Create the new Mainnet-only environment

Create `/home/wizpay/apps/wizpay/arc-mainnet.env` from
`deploy/arc-mainnet/environment.template`. It must be outside the checkout,
owned by the deployment user, and mode `0600`:

```sh
install -m 600 /dev/null /home/wizpay/apps/wizpay/arc-mainnet.env
```

Populate it through the operator's approved secret-management procedure. Set
`CORS_ORIGINS` exactly to `https://app.wizpay.xyz`.

The public HTTPS backend hostname is the remaining deployment decision. The
operator must select it, configure DNS/TLS and an explicit Caddy reverse proxy
to the backend loopback listener, then use that exact origin for
`NEXT_PUBLIC_API_URL`. Do not guess or record a hostname in this repository.

Validate without printing expanded values:

```sh
env_file=/home/wizpay/apps/wizpay/arc-mainnet.env
docker compose --env-file "$env_file" -f deploy/arc-mainnet/compose.yml config --quiet
```

## 4. Start fresh PostgreSQL and Redis

Inventory the target names and prove they do not already exist:

```sh
docker ps -a --filter name='^/wizpay-arc-mainnet-' --format '{{.Names}}'
docker volume inspect wizpay-arc-mainnet-postgres 2>/dev/null || true
docker volume inspect wizpay-arc-mainnet-redis 2>/dev/null || true
docker network inspect wizpay-arc-mainnet 2>/dev/null || true
```

Stop if any result is an unreviewed pre-existing resource. When the target is
confirmed absent, start only the new data services:

```sh
env_file=/home/wizpay/apps/wizpay/arc-mainnet.env
docker compose --env-file "$env_file" -f deploy/arc-mainnet/compose.yml up -d postgres redis
docker compose --env-file "$env_file" -f deploy/arc-mainnet/compose.yml ps
```

Verify the database is empty before migration:

```sh
docker compose --env-file "$env_file" -f deploy/arc-mainnet/compose.yml \
  exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT tablename FROM pg_tables WHERE schemaname = '\''public'\'' ORDER BY tablename"'
```

The command must print no tables.

## 5. Apply the clean Arc Mainnet baseline

Build the reviewed backend image and run the one-shot migration service:

```sh
docker compose --env-file "$env_file" -f deploy/arc-mainnet/compose.yml build backend migrate
docker compose --env-file "$env_file" -f deploy/arc-mainnet/compose.yml \
  --profile migration run --rm migrate
```

Inspect migration bookkeeping and tables:

```sh
docker compose --env-file "$env_file" -f deploy/arc-mainnet/compose.yml \
  exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "TABLE \"_prisma_migrations\""'
docker compose --env-file "$env_file" -f deploy/arc-mainnet/compose.yml \
  exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT tablename FROM pg_tables WHERE schemaname = '\''public'\'' ORDER BY tablename"'
```

There must be exactly one successful migration named
`20260922210000_arc_mainnet_fresh_baseline`, the 14 expected application
tables, and `_prisma_migrations`. There must be no App Wallet, XyloNet,
StableFX, Testnet, W3S, or treasury-era objects.

Verify application tables contain zero rows before starting the backend:

```sh
docker compose --env-file "$env_file" -f deploy/arc-mainnet/compose.yml \
  exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT
    (SELECT count(*) FROM \"Task\") +
    (SELECT count(*) FROM \"TaskLog\") +
    (SELECT count(*) FROM \"TaskUnit\") +
    (SELECT count(*) FROM \"TaskTransaction\") +
    (SELECT count(*) FROM \"UserWallet\") +
    (SELECT count(*) FROM \"Invoice\") +
    (SELECT count(*) FROM \"InvoicePayment\") +
    (SELECT count(*) FROM \"ExecutionIntent\") +
    (SELECT count(*) FROM \"BridgeTransaction\") +
    (SELECT count(*) FROM \"Activity\") +
    (SELECT count(*) FROM \"ActivityAuthSession\") +
    (SELECT count(*) FROM \"WalletAuthChallenge\") +
    (SELECT count(*) FROM \"VerifiedSwapTransaction\") +
    (SELECT count(*) FROM \"ActivitySyncState\")"'
```

The result must be `0`.

## 6. Start and verify backend/workers

```sh
docker compose --env-file "$env_file" -f deploy/arc-mainnet/compose.yml up -d backend
docker compose --env-file "$env_file" -f deploy/arc-mainnet/compose.yml ps
curl -fsS http://127.0.0.1:4100/health
curl -fsS http://127.0.0.1:4100/health/runtime-isolation
```

The diagnostic must report `arc-mainnet`, the new Mainnet database target,
Mainnet Redis index, Mainnet queue prefix, and no secret values. Confirm there
is no VPS frontend container.

## 7. Configure the public backend origin and Vercel

The operator must first choose the public HTTPS backend hostname. Configure its
DNS/TLS and Caddy reverse proxy exclusively to the backend loopback listener
at `127.0.0.1:4100`; no hostname is prescribed here.

Set the selected origin as `NEXT_PUBLIC_API_URL` in Vercel, then configure the
remaining Vercel variables from the production template:

- `NEXT_PUBLIC_WIZPAY_ARC_NETWORK`
- `NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL`
- `NEXT_PUBLIC_REOWN_PROJECT_ID`

Deploy the reviewed frontend through Vercel only after the operator completes
those DNS, Caddy, and Vercel project actions.

Verify:

```text
https://app.wizpay.xyz
```

Check the browser network panel for the operator-chosen API origin, exact CORS,
no CSP violations, no remote Reown fonts, and no Coinbase telemetry requests.

## 8. Post-deployment E2E checklist

First perform read-only checks:

- Arc Mainnet chain ID is `5042`.
- USDC, EURC, Payroll, and Swap executor addresses match the reviewed registry.
- External EOA and Safe connection, authentication, switching, and privacy work.
- Fresh database contains no historical sessions, activity, invoices, tasks, or intents.
- Destination RPCs are present for every enabled CCTP destination route.
- Activity projections require verified receipts.

Only under separate explicit transaction authorization and with bounded funds,
exercise Send, Invoice, Payment Link, same-token Payroll, both cross-token
Payroll directions, mixed Payroll, both Swap directions, each enabled CCTP
route, and per-wallet Unified Activity. Verify receipts and explorer evidence.

Keep `/home/wizpay/backups/wizpay-20260922T140530Z` until Mainnet validation
and the chosen retention period are complete. Any later archival deletion is a
separate, explicitly authorized operation and is outside this runbook.
