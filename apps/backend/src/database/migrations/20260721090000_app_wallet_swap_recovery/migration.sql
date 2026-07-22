ALTER TABLE "AppWalletSwapOperation"
  ADD COLUMN IF NOT EXISTS "stablefxFundingRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "stablefxFundedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "refundTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "refundTxHash" TEXT,
  ADD COLUMN IF NOT EXISTS "refundAmount" TEXT,
  ADD COLUMN IF NOT EXISTS "refundSubmittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "refundConfirmedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rawRefund" JSONB,
  ADD COLUMN IF NOT EXISTS "executionLeaseId" TEXT,
  ADD COLUMN IF NOT EXISTS "executionLeaseExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "AppWalletSwapOperation_refundTransactionId_idx"
  ON "AppWalletSwapOperation"("refundTransactionId");
CREATE INDEX IF NOT EXISTS "AppWalletSwapOperation_refundTxHash_idx"
  ON "AppWalletSwapOperation"("refundTxHash");
CREATE INDEX IF NOT EXISTS "AppWalletSwapOperation_executionLeaseExpiresAt_idx"
  ON "AppWalletSwapOperation"("executionLeaseExpiresAt");
