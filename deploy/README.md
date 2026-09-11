# Arc runtime isolation

Arc Testnet and Arc Mainnet use separate Compose projects, networks, PostgreSQL
volumes, Redis volumes, database variables, Redis variables, queue prefixes, and
deployment manifests.

Configuration templates contain placeholders only. Copy the selected template
outside version control, provide only that network's authorized values, and use
the matching Compose file. Do not combine both templates or pass unscoped
`DATABASE_URL`, `REDIS_URL`, or queue-prefix variables.

Testnet configuration can be inspected without starting services:

```sh
docker compose --env-file deploy/arc-testnet/environment.template -f deploy/arc-testnet/compose.yml config
```

Mainnet is a non-executable template. Its RPC, Circle blockchain identifier,
tokens, contracts, database, Redis, wallet set, and receipts remain unavailable
until later authorized phases supply official resources. Do not run its backend
or migration service before those resources are recorded and reviewed.

Migration entry points are network-specific:

```sh
npm run prisma:migrate:arc-testnet -w backend
npm run prisma:migrate:arc-mainnet -w backend
```

Each command requires the matching scoped database variable and matching
`WIZPAY_MIGRATION_NETWORK`; the package scripts set the network identities and
Prisma rejects unscoped `DATABASE_URL`.
