-- Persist the immutable App Wallet execution provider.
--
-- Legacy classification is intentionally narrow: the prior application stored
-- the normalized quote provider in rawQuote.provider. Rows without one exact
-- supported value remain NULL and are blocked by the application before
-- execution or recovery side effects.
ALTER TABLE "AppWalletSwapOperation"
  ADD COLUMN IF NOT EXISTS "executionProvider" TEXT;

UPDATE "AppWalletSwapOperation"
SET "executionProvider" = "rawQuote"->>'provider'
WHERE "executionProvider" IS NULL
  AND jsonb_typeof("rawQuote") = 'object'
  AND "rawQuote"->>'provider' IN ('swapkit', 'stablefx');

ALTER TABLE "AppWalletSwapOperation"
  DROP CONSTRAINT IF EXISTS "AppWalletSwapOperation_executionProvider_check";

ALTER TABLE "AppWalletSwapOperation"
  ADD CONSTRAINT "AppWalletSwapOperation_executionProvider_check"
  CHECK (
    "executionProvider" IS NULL
    OR "executionProvider" IN ('swapkit', 'stablefx')
  );

-- Once classified, an operation cannot cross providers. Unresolved legacy rows
-- may be classified exactly once by changing NULL to a supported value.
CREATE OR REPLACE FUNCTION "preventAppWalletSwapExecutionProviderChange"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."executionProvider" IS NOT NULL
    AND NEW."executionProvider" IS DISTINCT FROM OLD."executionProvider"
  THEN
    RAISE EXCEPTION 'App Wallet swap execution provider is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "AppWalletSwapOperation_executionProvider_immutable"
  ON "AppWalletSwapOperation";

CREATE TRIGGER "AppWalletSwapOperation_executionProvider_immutable"
BEFORE UPDATE OF "executionProvider" ON "AppWalletSwapOperation"
FOR EACH ROW
EXECUTE FUNCTION "preventAppWalletSwapExecutionProviderChange"();

-- Preserve unresolved legacy NULL rows without allowing future inserts or
-- updates to omit the provider. NOT VALID skips the existing-row scan while
-- still enforcing the constraint for new row versions.
ALTER TABLE "AppWalletSwapOperation"
  DROP CONSTRAINT IF EXISTS "AppWalletSwapOperation_executionProvider_required";

ALTER TABLE "AppWalletSwapOperation"
  ADD CONSTRAINT "AppWalletSwapOperation_executionProvider_required"
  CHECK ("executionProvider" IS NOT NULL) NOT VALID;
