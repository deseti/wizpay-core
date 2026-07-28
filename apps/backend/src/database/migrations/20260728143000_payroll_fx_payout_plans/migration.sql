-- Phase 4: immutable, planning-only recipient allocation for settled
-- App Wallet StableFX Payroll. This migration creates no plans and performs
-- no historical inference or backfill.

CREATE TYPE "PayrollFxPayoutPlanStatus" AS ENUM ('PLANNED');
CREATE TYPE "PayrollFxPayoutAllocationStatus" AS ENUM ('PLANNED');

DROP INDEX "PayrollFxOperation_taskId_idx";
CREATE UNIQUE INDEX "PayrollFxOperation_taskId_key"
  ON "PayrollFxOperation"("taskId");

ALTER TABLE "PayrollFxOperation"
  DROP CONSTRAINT "PayrollFxOperation_taskId_fkey";
ALTER TABLE "PayrollFxOperation"
  ADD CONSTRAINT "PayrollFxOperation_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "preventPayrollFxOperationTaskChange"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."taskId" IS NOT NULL
    AND NEW."taskId" IS DISTINCT FROM OLD."taskId"
  THEN
    RAISE EXCEPTION 'Payroll FX operation task attachment is one-way'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PayrollFxOperation_task_attachment_one_way"
BEFORE UPDATE OF "taskId" ON "PayrollFxOperation"
FOR EACH ROW
EXECUTE FUNCTION "preventPayrollFxOperationTaskChange"();

CREATE TABLE "PayrollFxPayoutPlan" (
  "id" UUID NOT NULL,
  "operationId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "executionProvider" "PayrollFxExecutionProvider" NOT NULL,
  "network" TEXT NOT NULL,
  "tokenAddress" TEXT NOT NULL,
  "tokenDecimals" INTEGER NOT NULL,
  "sourceWalletAddress" TEXT NOT NULL,
  "settledBudgetBaseUnits" TEXT NOT NULL,
  "totalRequestedWeightBaseUnits" TEXT NOT NULL,
  "totalAllocatedBaseUnits" TEXT NOT NULL,
  "dustBaseUnits" TEXT NOT NULL,
  "allocationAlgorithmVersion" TEXT NOT NULL,
  "immutableInputHash" TEXT NOT NULL,
  "status" "PayrollFxPayoutPlanStatus" NOT NULL DEFAULT 'PLANNED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PayrollFxPayoutPlan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayrollFxPayoutPlan_operationId_key" UNIQUE ("operationId"),
  CONSTRAINT "PayrollFxPayoutPlan_taskId_key" UNIQUE ("taskId"),
  CONSTRAINT "PayrollFxPayoutPlan_immutableInputHash_key"
    UNIQUE ("immutableInputHash"),
  CONSTRAINT "PayrollFxPayoutPlan_token_decimals_check"
    CHECK ("tokenDecimals" >= 0 AND "tokenDecimals" <= 255),
  CONSTRAINT "PayrollFxPayoutPlan_amounts_check"
    CHECK (
      "settledBudgetBaseUnits" ~ '^[0-9]+$'
      AND "totalRequestedWeightBaseUnits" ~ '^[0-9]+$'
      AND "totalAllocatedBaseUnits" ~ '^[0-9]+$'
      AND "dustBaseUnits" ~ '^[0-9]+$'
      AND "totalRequestedWeightBaseUnits"::numeric > 0
      AND "totalAllocatedBaseUnits"::numeric
        + "dustBaseUnits"::numeric
        = "settledBudgetBaseUnits"::numeric
    ),
  CONSTRAINT "PayrollFxPayoutPlan_required_text_check"
    CHECK (
      btrim("network") <> ''
      AND btrim("tokenAddress") <> ''
      AND btrim("sourceWalletAddress") <> ''
      AND btrim("allocationAlgorithmVersion") <> ''
      AND "immutableInputHash" ~ '^[0-9a-f]{64}$'
    )
);

CREATE TABLE "PayrollFxPayoutAllocation" (
  "id" UUID NOT NULL,
  "planId" UUID NOT NULL,
  "recipientLineId" TEXT NOT NULL,
  "recipientIndex" INTEGER NOT NULL,
  "recipientAddress" TEXT NOT NULL,
  "destinationTokenAddress" TEXT NOT NULL,
  "requestedWeightBaseUnits" TEXT NOT NULL,
  "allocatedAmountBaseUnits" TEXT NOT NULL,
  "deterministicRank" INTEGER NOT NULL,
  "status" "PayrollFxPayoutAllocationStatus" NOT NULL DEFAULT 'PLANNED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PayrollFxPayoutAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayrollFxPayoutAllocation_planId_recipientLineId_key"
    UNIQUE ("planId", "recipientLineId"),
  CONSTRAINT "PayrollFxPayoutAllocation_planId_recipientIndex_key"
    UNIQUE ("planId", "recipientIndex"),
  CONSTRAINT "PayrollFxPayoutAllocation_indexes_check"
    CHECK ("recipientIndex" >= 0 AND "deterministicRank" >= 0),
  CONSTRAINT "PayrollFxPayoutAllocation_amounts_check"
    CHECK (
      "requestedWeightBaseUnits" ~ '^[0-9]+$'
      AND "requestedWeightBaseUnits"::numeric > 0
      AND "allocatedAmountBaseUnits" ~ '^[0-9]+$'
    ),
  CONSTRAINT "PayrollFxPayoutAllocation_required_text_check"
    CHECK (
      btrim("recipientLineId") <> ''
      AND btrim("recipientAddress") <> ''
      AND btrim("destinationTokenAddress") <> ''
    )
);

ALTER TABLE "PayrollFxPayoutPlan"
  ADD CONSTRAINT "PayrollFxPayoutPlan_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "PayrollFxOperation"("operationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollFxPayoutPlan"
  ADD CONSTRAINT "PayrollFxPayoutPlan_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollFxPayoutAllocation"
  ADD CONSTRAINT "PayrollFxPayoutAllocation_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "PayrollFxPayoutPlan"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "PayrollFxPayoutAllocation_planId_deterministicRank_idx"
  ON "PayrollFxPayoutAllocation"("planId", "deterministicRank");

CREATE FUNCTION "preventPayrollFxPayoutPlanMutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Payroll FX payout plans are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "PayrollFxPayoutPlan_immutable"
BEFORE UPDATE OR DELETE ON "PayrollFxPayoutPlan"
FOR EACH ROW
EXECUTE FUNCTION "preventPayrollFxPayoutPlanMutation"();

CREATE FUNCTION "preventPayrollFxPayoutAllocationMutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Payroll FX payout allocations are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "PayrollFxPayoutAllocation_immutable"
BEFORE UPDATE OR DELETE ON "PayrollFxPayoutAllocation"
FOR EACH ROW
EXECUTE FUNCTION "preventPayrollFxPayoutAllocationMutation"();
