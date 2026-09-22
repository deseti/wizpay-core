-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'VERIFYING', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoicePaymentStatus" AS ENUM ('SUBMITTED', 'VERIFYING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InvoiceSettlementKind" AS ENUM ('INVOICE', 'PAYMENT_LINK');

-- CreateEnum
CREATE TYPE "ExecutionIntentOperation" AS ENUM ('SEND', 'PAYROLL', 'TOKEN_APPROVAL', 'INVOICE_SETTLEMENT', 'PAYMENT_LINK_SETTLEMENT');

-- CreateEnum
CREATE TYPE "ExecutionIntentRoute" AS ENUM ('DIRECT_TRANSFER', 'CROSS_TOKEN_PROVIDER', 'CROSS_TOKEN_ATOMIC', 'CROSS_TOKEN_DISABLED');

-- CreateEnum
CREATE TYPE "ExecutionIntentStatus" AS ENUM ('CREATED', 'AWAITING_WALLET_SIGNATURE', 'AUTHORIZATION_PENDING', 'SUBMISSION_PENDING', 'SUBMITTED', 'VERIFYING', 'COMPLETED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "totalUnits" INTEGER NOT NULL DEFAULT 0,
    "completedUnits" INTEGER NOT NULL DEFAULT 0,
    "failedUnits" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskLog" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'INFO',
    "step" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskUnit" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "error" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTransaction" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "txId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "txHash" TEXT,
    "errorReason" TEXT,
    "batchIndex" INTEGER NOT NULL DEFAULT 0,
    "pollAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserWallet" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "userEmail" TEXT,
    "chain" TEXT NOT NULL,
    "blockchain" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "walletSetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "publicId" TEXT NOT NULL,
    "merchantUserId" TEXT NOT NULL,
    "merchantWalletAddress" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "amountUnits" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "invoiceNumber" TEXT,
    "settlementKind" "InvoiceSettlementKind" NOT NULL DEFAULT 'INVOICE',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "payerAddress" TEXT,
    "status" "InvoicePaymentStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "rejectionCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "BridgeTransaction" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "messageHash" TEXT,
    "nonce" TEXT,
    "destinationTransactionHash" TEXT,
    "destinationLeaseId" UUID,
    "destinationLeaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BridgeTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" UUID NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "direction" TEXT,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "sourceReferenceType" TEXT NOT NULL,
    "sourceReferenceId" TEXT NOT NULL,
    "taskId" TEXT,
    "operationId" TEXT,
    "challengeId" TEXT,
    "transactionId" TEXT,
    "chainId" INTEGER,
    "txHash" TEXT,
    "inputTokenSymbol" TEXT,
    "inputTokenAddress" TEXT,
    "inputAmount" TEXT,
    "outputTokenSymbol" TEXT,
    "outputTokenAddress" TEXT,
    "outputAmount" TEXT,
    "feeAmount" TEXT,
    "feeTokenSymbol" TEXT,
    "counterparty" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityAuthSession" (
    "id" UUID NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityAuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletAuthChallenge" (
    "id" UUID NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletAuthChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerifiedSwapTransaction" (
    "id" UUID NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tokenIn" TEXT NOT NULL,
    "tokenOut" TEXT NOT NULL,
    "amountIn" TEXT NOT NULL,
    "amountOut" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerifiedSwapTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivitySyncState" (
    "id" UUID NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "checkpointTransactionId" TEXT,
    "leaseId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastStartedAt" TIMESTAMP(3),
    "lastCompletedAt" TIMESTAMP(3),
    "nextAllowedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivitySyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskLog_taskId_idx" ON "TaskLog"("taskId");

-- CreateIndex
CREATE INDEX "TaskUnit_taskId_idx" ON "TaskUnit"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskUnit_taskId_id_key" ON "TaskUnit"("taskId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TaskUnit_taskId_index_key" ON "TaskUnit"("taskId", "index");

-- CreateIndex
CREATE INDEX "TaskTransaction_taskId_idx" ON "TaskTransaction"("taskId");

-- CreateIndex
CREATE INDEX "TaskTransaction_txId_idx" ON "TaskTransaction"("txId");

-- CreateIndex
CREATE INDEX "TaskTransaction_taskId_status_idx" ON "TaskTransaction"("taskId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UserWallet_walletId_key" ON "UserWallet"("walletId");

-- CreateIndex
CREATE INDEX "UserWallet_userId_idx" ON "UserWallet"("userId");

-- CreateIndex
CREATE INDEX "UserWallet_userId_chain_idx" ON "UserWallet"("userId", "chain");

-- CreateIndex
CREATE UNIQUE INDEX "UserWallet_userId_blockchain_key" ON "UserWallet"("userId", "blockchain");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_publicId_key" ON "Invoice"("publicId");

-- CreateIndex
CREATE INDEX "Invoice_merchantUserId_createdAt_idx" ON "Invoice"("merchantUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Invoice_merchantUserId_status_idx" ON "Invoice"("merchantUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_invoiceId_key" ON "InvoicePayment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_transactionHash_key" ON "InvoicePayment"("transactionHash");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionIntent_logicalKey_key" ON "ExecutionIntent"("logicalKey");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionIntent_requestFingerprint_key" ON "ExecutionIntent"("requestFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionIntent_idempotencyKey_key" ON "ExecutionIntent"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionIntent_circleChallengeId_key" ON "ExecutionIntent"("circleChallengeId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionIntent_circleTransactionId_key" ON "ExecutionIntent"("circleTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionIntent_transactionHash_key" ON "ExecutionIntent"("transactionHash");

-- CreateIndex
CREATE INDEX "ExecutionIntent_operation_externalReference_idx" ON "ExecutionIntent"("operation", "externalReference");

-- CreateIndex
CREATE INDEX "ExecutionIntent_taskId_idx" ON "ExecutionIntent"("taskId");

-- CreateIndex
CREATE INDEX "ExecutionIntent_status_leaseExpiresAt_idx" ON "ExecutionIntent"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ExecutionIntent_sourceWallet_createdAt_idx" ON "ExecutionIntent"("sourceWallet", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BridgeTransaction_taskId_key" ON "BridgeTransaction"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "BridgeTransaction_messageHash_key" ON "BridgeTransaction"("messageHash");

-- CreateIndex
CREATE UNIQUE INDEX "BridgeTransaction_nonce_key" ON "BridgeTransaction"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "BridgeTransaction_destinationTransactionHash_key" ON "BridgeTransaction"("destinationTransactionHash");

-- CreateIndex
CREATE UNIQUE INDEX "BridgeTransaction_destinationLeaseId_key" ON "BridgeTransaction"("destinationLeaseId");

-- CreateIndex
CREATE INDEX "BridgeTransaction_status_idx" ON "BridgeTransaction"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_idempotencyKey_key" ON "Activity"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Activity_ownerUserId_createdAt_id_idx" ON "Activity"("ownerUserId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Activity_ownerUserId_type_idx" ON "Activity"("ownerUserId", "type");

-- CreateIndex
CREATE INDEX "Activity_ownerUserId_status_idx" ON "Activity"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "Activity_txHash_idx" ON "Activity"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_sourceReferenceType_sourceReferenceId_key" ON "Activity"("sourceReferenceType", "sourceReferenceId");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityAuthSession_sessionHash_key" ON "ActivityAuthSession"("sessionHash");

-- CreateIndex
CREATE INDEX "ActivityAuthSession_ownerUserId_idx" ON "ActivityAuthSession"("ownerUserId");

-- CreateIndex
CREATE INDEX "ActivityAuthSession_expiresAt_idx" ON "ActivityAuthSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletAuthChallenge_nonceHash_key" ON "WalletAuthChallenge"("nonceHash");

-- CreateIndex
CREATE INDEX "WalletAuthChallenge_walletAddress_createdAt_idx" ON "WalletAuthChallenge"("walletAddress", "createdAt");

-- CreateIndex
CREATE INDEX "WalletAuthChallenge_expiresAt_idx" ON "WalletAuthChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "VerifiedSwapTransaction_transactionHash_key" ON "VerifiedSwapTransaction"("transactionHash");

-- CreateIndex
CREATE INDEX "VerifiedSwapTransaction_walletAddress_completedAt_idx" ON "VerifiedSwapTransaction"("walletAddress", "completedAt");

-- CreateIndex
CREATE INDEX "ActivitySyncState_leaseExpiresAt_idx" ON "ActivitySyncState"("leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ActivitySyncState_nextAllowedAt_idx" ON "ActivitySyncState"("nextAllowedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivitySyncState_ownerUserId_source_key" ON "ActivitySyncState"("ownerUserId", "source");

-- AddForeignKey
ALTER TABLE "TaskLog" ADD CONSTRAINT "TaskLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskUnit" ADD CONSTRAINT "TaskUnit_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTransaction" ADD CONSTRAINT "TaskTransaction_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
