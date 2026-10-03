-- SAFE READ-ONLY; secure operator supplies verified target. No embedded URL.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT count(*) FILTER (WHERE "acknowledgedAt" IS NULL AND "failedAt" IS NULL) AS pending,
       count(*) FILTER (WHERE "acknowledgedAt" IS NULL AND "failedAt" IS NULL AND attempts > 0) AS retrying,
       count(*) FILTER (WHERE "leaseToken" IS NOT NULL AND "leaseExpiresAt" < CURRENT_TIMESTAMP AND "acknowledgedAt" IS NULL AND "failedAt" IS NULL) AS expired_leases,
       count(*) FILTER (WHERE "failedAt" IS NOT NULL) AS terminal_failures,
       max("acknowledgedAt") AS latest_success,
       max(attempts) AS highest_attempts
FROM public."ReconciliationWork" WHERE network = 'arc-mainnet';
COMMIT;
-- Retry growth requires two timestamped samples; duplicate conflicts and verified
-- empty batches require secure application/platform logs, not an inferred zero.
