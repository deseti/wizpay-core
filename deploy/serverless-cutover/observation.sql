-- SAFE READ-ONLY. Operator supplies secure, pinned target; never embed a URL.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT CASE WHEN "acknowledgedAt" IS NOT NULL THEN 'ACKNOWLEDGED'
            WHEN "failedAt" IS NOT NULL THEN 'FAILED' ELSE 'RETRYABLE' END AS state,
       count(*) AS work_count, max(attempts) AS highest_attempts,
       count(*) FILTER (WHERE "leaseExpiresAt" < CURRENT_TIMESTAMP AND "leaseToken" IS NOT NULL) AS expired_leases,
       count(*) FILTER (WHERE "availableAt" <= CURRENT_TIMESTAMP AND "acknowledgedAt" IS NULL AND "failedAt" IS NULL) AS currently_available
FROM public."ReconciliationWork" WHERE network = 'arc-mainnet' GROUP BY 1 ORDER BY 1;
SELECT status, count(*) AS intent_count,
       count(*) FILTER (WHERE "leaseExpiresAt" < CURRENT_TIMESTAMP AND "leaseOwner" IS NOT NULL) AS expired_leases
FROM public."ExecutionIntent" WHERE network = 'arc-mainnet' GROUP BY status ORDER BY status;
COMMIT;
