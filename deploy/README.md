# WizPay Arc Mainnet production configuration

The canonical VPS topology is `deploy/arc-mainnet/compose.yml`. It runs only:

- the WizPay backend and workers;
- PostgreSQL with a fresh Arc Mainnet volume;
- Redis with a fresh Arc Mainnet volume;
- an explicit one-shot Prisma migration service.

The frontend is deployed separately to Vercel at
`https://app.wizpay.xyz`. The root `docker-compose.yml` is for local full-stack
development only. It is not a production VPS definition.

## Public API requirement

Browser requests from Vercel require a publicly reachable HTTPS backend
origin. The repository intentionally does not guess that hostname. The
operator must provision DNS/TLS/reverse-proxy routing to the backend's
loopback listener and set that exact origin as `NEXT_PUBLIC_API_URL` in
Vercel. Backend production CORS accepts only `https://app.wizpay.xyz`.

## Environment boundaries

`deploy/arc-mainnet/environment.template` contains the complete fresh
production variable inventory. Copy it to a file outside the checkout,
replace every angle-bracket placeholder, restrict its filesystem permissions,
and never reuse an older Testnet env file.

The required Vercel variables are:

- `NEXT_PUBLIC_WIZPAY_ARC_NETWORK=arc-mainnet`
- `NEXT_PUBLIC_API_URL=<operator-provided HTTPS backend origin>`
- `NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL=https://app.wizpay.xyz`
- `NEXT_PUBLIC_REOWN_PROJECT_ID=<Reown project ID>`

No Circle App Wallet, W3S, passkey, XyloNet, StableFX, Testnet, or Sepolia
variables are accepted by the production architecture.

Destination-chain RPC variables are route-specific. When an external chain is
the CCTP destination, `BRIDGE_DESTINATION_RPC_<chainId>` is required for the
backend to verify its mint receipt and project a completed bridge Activity.
Without it, the intent can settle but remains unverified in activity.

## Local configuration validation

Use a populated, untracked env file rather than the placeholder template:

```sh
docker compose \
  --env-file /absolute/path/to/arc-mainnet.env \
  -f deploy/arc-mainnet/compose.yml \
  config --quiet
```

The migration entry point is network-scoped and rejects `DATABASE_URL`:

```sh
WIZPAY_ARC_NETWORK=arc-mainnet \
WIZPAY_MIGRATION_NETWORK=arc-mainnet \
ARC_MAINNET_DATABASE_URL='postgresql://...' \
npm run prisma:migrate:arc-mainnet -w backend
```

The single baseline migration is only for a brand-new empty Mainnet database.
It must never be deployed over the historical Testnet database or a database
that replayed the retired migration chain.

See `deploy/arc-mainnet/PRODUCTION_CUTOVER_RUNBOOK.md` for the later manual
cutover. Repository preparation does not authorize deployment.
