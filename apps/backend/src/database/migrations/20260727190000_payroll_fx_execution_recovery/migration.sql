ALTER TABLE "PayrollFxOperation"
ADD COLUMN "approvalTargetAddress" TEXT,
ADD COLUMN "executionLeaseId" TEXT,
ADD COLUMN "executionLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "executionAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastAttemptStartedAt" TIMESTAMP(3),
ADD COLUMN "lastAttemptFinishedAt" TIMESTAMP(3),
ADD COLUMN "recoveryFromStatus" "PayrollFxOperationStatus";

ALTER TABLE "PayrollFxOperation"
ADD CONSTRAINT "PayrollFxOperation_execution_lease_pair_check"
CHECK (
  ("executionLeaseId" IS NULL AND "executionLeaseExpiresAt" IS NULL)
  OR
  ("executionLeaseId" IS NOT NULL AND "executionLeaseExpiresAt" IS NOT NULL)
);

ALTER TABLE "PayrollFxOperation"
ADD CONSTRAINT "PayrollFxOperation_execution_attempt_count_check"
CHECK ("executionAttemptCount" >= 0);

CREATE INDEX "PayrollFxOperation_executionLeaseExpiresAt_idx"
ON "PayrollFxOperation"("executionLeaseExpiresAt");
