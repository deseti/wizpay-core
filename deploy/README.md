# Arc runtime isolation

Arc Mainnet uses a dedicated Compose project, network, PostgreSQL volume,
Redis volume, database variables, Redis variables, queue prefix, and
deployment manifest.

The configuration template contains placeholders only. Copy the template
outside version control, provide only the authorized Mainnet values, and use
the matching Compose file. Do not pass unscoped `DATABASE_URL`, `REDIS_URL`,
or queue-prefix variables.

Mainnet configuration can be inspected without starting services:

```sh
docker compose --env-file deploy/arc-mainnet/environment.template -f deploy/arc-mainnet/compose.yml config
```

Mainnet is a non-executable template until later authorized phases supply
official resources. Its RPC, tokens, contracts, database, Redis, and receipts
remain unavailable until those resources are recorded and reviewed. Do not run
its backend or migration service before those resources are recorded and
reviewed.

Migration entry point is network-specific:

```sh
npm run prisma:migrate:arc-mainnet -w backend
```

The command requires the matching scoped database variable and matching
`WIZPAY_MIGRATION_NETWORK`; the package script sets the network identity and
Prisma rejects unscoped `DATABASE_URL`.
