# Analytics Cache Maintenance

This is an operator reference for the existing backend cache endpoints. It does not establish that an analytics refresh job is enabled in production.

## Current Behavior

`GET /analytics/wizpay` returns an in-memory snapshot initialized from values embedded in `AnalyticsService`.

`POST /internal/analytics/wizpay/update` requires `Authorization: Bearer <ANALYTICS_CRON_SECRET>`. It updates cache metadata and the configured contract address. The current implementation does not fetch fresh explorer counters or recalculate transfer volume.

The response source labels describe the stored seed snapshot. Its `updatedAt` value is not evidence that the counters or volume were measured at that time. Do not present these values as freshly verified production totals.

## Operator Configuration

Use the existing production backend endpoint and protected secret storage. The Compose stack exposes port `4100` on loopback by default; `WIZPAY_BACKEND_HOST_PORT` can override it. Port `4000` is the backend container's internal port.

`WIZPAY_ANALYTICS_CONTRACT_ADDRESS` overrides the contract address used by the cache. `ARCSCAN_API_BASE_URL` is read by a placeholder refresh method and does not enable a live explorer fetch in the current implementation.

An external scheduler may call the protected update endpoint when configured. This document does not install a cron job, change production configuration, or require a deployment.
