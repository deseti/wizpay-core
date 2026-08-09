-- Repair local schema drift left by the failed XyloNet experiment.
-- App Wallet execution providers are limited to the persisted providers used
-- by the current App Wallet flow. The constraint is NOT VALID because this
-- local database contains historical XyloNet rows that must not be rewritten
-- or reclassified. New rows and updates are still checked immediately.
ALTER TABLE "AppWalletSwapOperation"
  DROP CONSTRAINT IF EXISTS "AppWalletSwapOperation_executionProvider_check";

ALTER TABLE "AppWalletSwapOperation"
  ADD CONSTRAINT "AppWalletSwapOperation_executionProvider_check"
  CHECK (
    "executionProvider" IS NULL
    OR "executionProvider" IN ('swapkit', 'stablefx')
  ) NOT VALID;
