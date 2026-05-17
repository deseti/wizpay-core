-- Add App Wallet swap execution tracking fields without rewriting the applied base table migration.
ALTER TABLE "AppWalletSwapOperation"
  ADD COLUMN IF NOT EXISTS "treasurySwapId" TEXT,
  ADD COLUMN IF NOT EXISTS "treasurySwapQuoteId" TEXT,
  ADD COLUMN IF NOT EXISTS "treasurySwapTxHash" TEXT,
  ADD COLUMN IF NOT EXISTS "treasurySwapSubmittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "treasurySwapConfirmedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "treasurySwapExpectedOutput" JSONB,
  ADD COLUMN IF NOT EXISTS "treasurySwapActualOutput" TEXT,
  ADD COLUMN IF NOT EXISTS "rawTreasurySwap" JSONB,
  ADD COLUMN IF NOT EXISTS "payoutTxHash" TEXT,
  ADD COLUMN IF NOT EXISTS "payoutAmount" TEXT,
  ADD COLUMN IF NOT EXISTS "payoutSubmittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "payoutConfirmedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rawPayout" JSONB,
  ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "executionError" TEXT;

CREATE INDEX IF NOT EXISTS "AppWalletSwapOperation_treasurySwapId_idx"
  ON "AppWalletSwapOperation"("treasurySwapId");

CREATE INDEX IF NOT EXISTS "AppWalletSwapOperation_treasurySwapTxHash_idx"
  ON "AppWalletSwapOperation"("treasurySwapTxHash");

CREATE INDEX IF NOT EXISTS "AppWalletSwapOperation_payoutTxHash_idx"
  ON "AppWalletSwapOperation"("payoutTxHash");
