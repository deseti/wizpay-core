-- Additive Phase 4 durable orchestration state. This migration intentionally
-- contains no data rewrite and is not executed by the application.
CREATE TYPE "ExecutionIntentOperation" AS ENUM (
  'SEND',
  'PAYROLL',
  'TOKEN_APPROVAL',
  'INVOICE_SETTLEMENT',
  'PAYMENT_LINK_SETTLEMENT'
);

CREATE TYPE "InvoiceSettlementKind" AS ENUM ('INVOICE', 'PAYMENT_LINK');

ALTER TABLE "Invoice"
ADD COLUMN "settlementKind" "InvoiceSettlementKind" NOT NULL DEFAULT 'INVOICE';

CREATE TYPE "ExecutionIntentRoute" AS ENUM (
  'DIRECT_TRANSFER',
  'CROSS_TOKEN_PROVIDER',
  'CROSS_TOKEN_DISABLED'
);

CREATE TYPE "ExecutionIntentStatus" AS ENUM (
  'CREATED',
  'AWAITING_WALLET_SIGNATURE',
  'AUTHORIZATION_PENDING',
  'SUBMISSION_PENDING',
  'SUBMITTED',
  'VERIFYING',
  'COMPLETED',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
  'EXPIRED',
  'CANCELLED'
);

CREATE TABLE "ExecutionIntent" (
  "id" UUID NOT NULL,
  "network" TEXT NOT NULL,
  "operation" "ExecutionIntentOperation" NOT NULL,
  "ownerId" TEXT,
  "walletId" TEXT,
  "sourceWallet" TEXT NOT NULL,
  "recipient" TEXT,
  "batchDigest" TEXT,
  "tokenIn" TEXT NOT NULL,
  "tokenOut" TEXT NOT NULL,
  "amountUnits" TEXT NOT NULL,
  "externalReference" TEXT NOT NULL,
  "logicalKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "idempotencyKey" UUID NOT NULL,
  "route" "ExecutionIntentRoute" NOT NULL,
  "provider" TEXT,
  "contractAddress" TEXT,
  "calldataHash" TEXT,
  "status" "ExecutionIntentStatus" NOT NULL DEFAULT 'CREATED',
  "circleChallengeId" TEXT,
  "circleTransactionId" TEXT,
  "transactionHash" TEXT,
  "taskId" UUID,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ExecutionIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExecutionIntent_logicalKey_key" ON "ExecutionIntent"("logicalKey");
CREATE UNIQUE INDEX "ExecutionIntent_requestFingerprint_key" ON "ExecutionIntent"("requestFingerprint");
CREATE UNIQUE INDEX "ExecutionIntent_idempotencyKey_key" ON "ExecutionIntent"("idempotencyKey");
CREATE UNIQUE INDEX "ExecutionIntent_circleChallengeId_key" ON "ExecutionIntent"("circleChallengeId");
CREATE UNIQUE INDEX "ExecutionIntent_circleTransactionId_key" ON "ExecutionIntent"("circleTransactionId");
CREATE UNIQUE INDEX "ExecutionIntent_transactionHash_key" ON "ExecutionIntent"("transactionHash");
CREATE INDEX "ExecutionIntent_taskId_idx" ON "ExecutionIntent"("taskId");
CREATE INDEX "ExecutionIntent_operation_externalReference_idx" ON "ExecutionIntent"("operation", "externalReference");
CREATE INDEX "ExecutionIntent_status_leaseExpiresAt_idx" ON "ExecutionIntent"("status", "leaseExpiresAt");
CREATE INDEX "ExecutionIntent_sourceWallet_createdAt_idx" ON "ExecutionIntent"("sourceWallet", "createdAt");
