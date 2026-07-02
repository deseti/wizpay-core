# WizPay Analytics Cron

## Purpose

The production GCP VM can refresh the backend-owned WizPay analytics cache with a 24-hour cron job. The cron calls the backend internal update endpoint and updates only the in-memory analytics cache metadata for the first implementation.

This job does not push to GitHub, does not deploy, does not run Vercel or GitHub scheduled jobs, and does not recompute volume from full Arcscan token-transfer pagination.

## Required Environment

Set `ANALYTICS_CRON_SECRET` in the backend runtime and in the VM cron environment. This value must be a strong secret and must not have an insecure production default.

Optional backend environment variables:

- `WIZPAY_ANALYTICS_CONTRACT_ADDRESS`: defaults to `0x87ACE45582f45cC81AC1E627E875AE84cbd75946`.
- `ARCSCAN_API_BASE_URL`: defaults to `https://testnet.arcscan.app/api/v2`.

## Endpoint

The VM cron should call the backend on localhost:

```sh
curl -fsS -X POST http://127.0.0.1:<BACKEND_PORT>/internal/analytics/wizpay/update -H "Authorization: Bearer $ANALYTICS_CRON_SECRET"
```

Example daily cron entry:

```cron
0 0 * * * curl -fsS -X POST http://127.0.0.1:<BACKEND_PORT>/internal/analytics/wizpay/update -H "Authorization: Bearer $ANALYTICS_CRON_SECRET" >> /var/log/wizpay-analytics-cron.log 2>&1
```

Replace `<BACKEND_PORT>` with the backend port exposed on the VM, usually `4000` unless production uses a different port.

## Docker Compose Alternative

If the backend is reachable only inside Docker, run the same curl command from the backend container network instead of the VM host network. For example:

```cron
0 0 * * * docker compose exec -T backend sh -lc 'curl -fsS -X POST http://127.0.0.1:${PORT:-4000}/internal/analytics/wizpay/update -H "Authorization: Bearer $ANALYTICS_CRON_SECRET"' >> /var/log/wizpay-analytics-cron.log 2>&1
```

Use the compose project and service name that are already running in production. Do not run `docker compose up` or redeploy from this cron.

## Public Read Path

Frontend analytics pages should read:

```http
GET /analytics/wizpay
```

The response contains verified seed contract counters, token-transfer counts, stablecoin volume totals, token breakdowns, and `updatedAt`. The first implementation serves seed data and refreshes backend cache metadata only.
