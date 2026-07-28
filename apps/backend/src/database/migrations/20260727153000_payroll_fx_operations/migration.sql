-- Durable persistence foundation for App Wallet cross-currency Payroll.
-- This migration intentionally creates no rows and does not inspect legacy task JSON.

CREATE TYPE "PayrollFxExecutionProvider" AS ENUM ('stablefx', 'swapkit');
CREATE TYPE "PayrollFxWalletMode" AS ENUM ('app');
CREATE TYPE "PayrollFxOperationStatus" AS ENUM (
  'CREATED',
  'QUOTE_PENDING',
  'QUOTE_READY',
  'APPROVAL_PENDING',
  'SUBMITTED',
  'FUNDING_PENDING',
  'SETTLEMENT_PENDING',
  'SETTLED',
  'PAYOUT_PENDING',
  'COMPLETED',
  'RECOVERY_REQUIRED',
  'FAILED'
);

CREATE TABLE "PayrollFxOperation" (
  "operationId" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "taskId" UUID,
  "walletMode" "PayrollFxWalletMode" NOT NULL,
  "executionProvider" "PayrollFxExecutionProvider" NOT NULL,
  "sourceTokenAddress" TEXT NOT NULL,
  "destinationTokenAddress" TEXT NOT NULL,
  "sourceTokenSymbol" TEXT NOT NULL,
  "destinationTokenSymbol" TEXT NOT NULL,
  "network" TEXT NOT NULL,
  "sourceWalletAddress" TEXT NOT NULL,
  "treasuryWalletAddress" TEXT NOT NULL,
  "amountInBaseUnits" TEXT NOT NULL,
  "requestedMinimumOutputBaseUnits" TEXT,
  "status" "PayrollFxOperationStatus" NOT NULL DEFAULT 'CREATED',
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "quoteId" TEXT,
  "quoteExpiresAt" TIMESTAMP(3),
  "expectedOutputBaseUnits" TEXT,
  "actualOutputBaseUnits" TEXT,
  "providerOperationId" TEXT,
  "approvalTransactionId" TEXT,
  "approvalTransactionHash" TEXT,
  "fundingTransactionId" TEXT,
  "fundingTransactionHash" TEXT,
  "settlementTransactionId" TEXT,
  "settlementTransactionHash" TEXT,
  "payoutTransactionId" TEXT,
  "payoutTransactionHash" TEXT,
  "lastProviderStatus" TEXT,
  "diagnosticSnapshot" JSONB,
  "submittedAt" TIMESTAMP(3),
  "fundingConfirmedAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "payoutConfirmedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PayrollFxOperation_pkey" PRIMARY KEY ("operationId"),
  CONSTRAINT "PayrollFxOperation_idempotencyKey_key" UNIQUE ("idempotencyKey"),
  CONSTRAINT "PayrollFxOperation_distinct_token_addresses_check"
    CHECK (lower("sourceTokenAddress") <> lower("destinationTokenAddress")),
  CONSTRAINT "PayrollFxOperation_distinct_token_symbols_check"
    CHECK (upper("sourceTokenSymbol") <> upper("destinationTokenSymbol")),
  CONSTRAINT "PayrollFxOperation_amount_in_positive_check"
    CHECK (
      "amountInBaseUnits" ~ '^[0-9]+$'
      AND "amountInBaseUnits"::numeric > 0
    ),
  CONSTRAINT "PayrollFxOperation_minimum_output_non_negative_check"
    CHECK (
      "requestedMinimumOutputBaseUnits" IS NULL
      OR (
        "requestedMinimumOutputBaseUnits" ~ '^[0-9]+$'
        AND "requestedMinimumOutputBaseUnits"::numeric >= 0
      )
    ),
  CONSTRAINT "PayrollFxOperation_expected_output_non_negative_check"
    CHECK (
      "expectedOutputBaseUnits" IS NULL
      OR (
        "expectedOutputBaseUnits" ~ '^[0-9]+$'
        AND "expectedOutputBaseUnits"::numeric >= 0
      )
    ),
  CONSTRAINT "PayrollFxOperation_actual_output_non_negative_check"
    CHECK (
      "actualOutputBaseUnits" IS NULL
      OR (
        "actualOutputBaseUnits" ~ '^[0-9]+$'
        AND "actualOutputBaseUnits"::numeric >= 0
      )
    ),
  CONSTRAINT "PayrollFxOperation_required_text_check"
    CHECK (
      btrim("idempotencyKey") <> ''
      AND btrim("sourceTokenAddress") <> ''
      AND btrim("destinationTokenAddress") <> ''
      AND btrim("sourceTokenSymbol") <> ''
      AND btrim("destinationTokenSymbol") <> ''
      AND btrim("network") <> ''
      AND btrim("sourceWalletAddress") <> ''
      AND btrim("treasuryWalletAddress") <> ''
    ),
  CONSTRAINT "PayrollFxOperation_diagnostic_snapshot_bounded_check"
    CHECK (
      "diagnosticSnapshot" IS NULL
      OR octet_length("diagnosticSnapshot"::text) <= 16384
    ),
  CONSTRAINT "PayrollFxOperation_timestamps_check"
    CHECK (
      "updatedAt" >= "createdAt"
      AND ("submittedAt" IS NULL OR "submittedAt" >= "createdAt")
      AND ("fundingConfirmedAt" IS NULL OR "fundingConfirmedAt" >= "createdAt")
      AND ("settledAt" IS NULL OR "settledAt" >= "createdAt")
      AND ("payoutConfirmedAt" IS NULL OR "payoutConfirmedAt" >= "createdAt")
      AND ("completedAt" IS NULL OR "completedAt" >= "createdAt")
    )
);

ALTER TABLE "PayrollFxOperation"
  ADD CONSTRAINT "PayrollFxOperation_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PayrollFxOperation_taskId_idx"
  ON "PayrollFxOperation"("taskId");
CREATE INDEX "PayrollFxOperation_executionProvider_providerOperationId_idx"
  ON "PayrollFxOperation"("executionProvider", "providerOperationId");
CREATE INDEX "PayrollFxOperation_status_failureCode_idx"
  ON "PayrollFxOperation"("status", "failureCode");

-- Immutable creation intent remains protected even from future accidental
-- direct Prisma/raw-SQL updates. Lifecycle evidence and task attachment remain mutable.
CREATE FUNCTION "preventPayrollFxOperationIntentChange"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."walletMode" IS DISTINCT FROM OLD."walletMode"
    OR NEW."executionProvider" IS DISTINCT FROM OLD."executionProvider"
    OR NEW."sourceTokenAddress" IS DISTINCT FROM OLD."sourceTokenAddress"
    OR NEW."destinationTokenAddress" IS DISTINCT FROM OLD."destinationTokenAddress"
    OR NEW."sourceTokenSymbol" IS DISTINCT FROM OLD."sourceTokenSymbol"
    OR NEW."destinationTokenSymbol" IS DISTINCT FROM OLD."destinationTokenSymbol"
    OR NEW."network" IS DISTINCT FROM OLD."network"
    OR NEW."sourceWalletAddress" IS DISTINCT FROM OLD."sourceWalletAddress"
    OR NEW."treasuryWalletAddress" IS DISTINCT FROM OLD."treasuryWalletAddress"
    OR NEW."amountInBaseUnits" IS DISTINCT FROM OLD."amountInBaseUnits"
    OR NEW."requestedMinimumOutputBaseUnits"
      IS DISTINCT FROM OLD."requestedMinimumOutputBaseUnits"
  THEN
    RAISE EXCEPTION 'Payroll FX operation execution intent is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PayrollFxOperation_intent_immutable"
BEFORE UPDATE ON "PayrollFxOperation"
FOR EACH ROW
EXECUTE FUNCTION "preventPayrollFxOperationIntentChange"();
