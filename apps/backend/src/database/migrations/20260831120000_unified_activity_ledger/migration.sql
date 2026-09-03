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

CREATE UNIQUE INDEX "Activity_idempotencyKey_key" ON "Activity"("idempotencyKey");
CREATE UNIQUE INDEX "Activity_sourceReferenceType_sourceReferenceId_key" ON "Activity"("sourceReferenceType", "sourceReferenceId");
CREATE INDEX "Activity_ownerUserId_createdAt_id_idx" ON "Activity"("ownerUserId", "createdAt", "id");
CREATE INDEX "Activity_ownerUserId_type_idx" ON "Activity"("ownerUserId", "type");
CREATE INDEX "Activity_ownerUserId_status_idx" ON "Activity"("ownerUserId", "status");
CREATE INDEX "Activity_txHash_idx" ON "Activity"("txHash");

CREATE TABLE "ActivityAuthSession" (
    "id" UUID NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ActivityAuthSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ActivityAuthSession_sessionHash_key" ON "ActivityAuthSession"("sessionHash");
CREATE INDEX "ActivityAuthSession_ownerUserId_idx" ON "ActivityAuthSession"("ownerUserId");
CREATE INDEX "ActivityAuthSession_expiresAt_idx" ON "ActivityAuthSession"("expiresAt");

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

CREATE UNIQUE INDEX "ActivitySyncState_ownerUserId_source_key" ON "ActivitySyncState"("ownerUserId", "source");
CREATE INDEX "ActivitySyncState_leaseExpiresAt_idx" ON "ActivitySyncState"("leaseExpiresAt");
CREATE INDEX "ActivitySyncState_nextAllowedAt_idx" ON "ActivitySyncState"("nextAllowedAt");
