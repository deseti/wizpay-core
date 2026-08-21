CREATE TABLE "AppWalletXylonetOperation" (
    "operationId" UUID NOT NULL,
    "applicationUserId" TEXT NOT NULL,
    "executionMode" TEXT NOT NULL,
    "circleWalletId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tokenIn" TEXT NOT NULL,
    "tokenOut" TEXT NOT NULL,
    "tokenInAddress" TEXT NOT NULL,
    "tokenOutAddress" TEXT NOT NULL,
    "amountIn" TEXT NOT NULL,
    "expectedOutput" TEXT NOT NULL,
    "minimumOutput" TEXT NOT NULL,
    "slippageBps" INTEGER NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "routerAddress" TEXT NOT NULL,
    "executorAddress" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "deadline" TEXT NOT NULL,
    "approvalIdempotencyKey" UUID NOT NULL,
    "swapIdempotencyKey" UUID NOT NULL,
    "approvalChallengeId" TEXT,
    "swapChallengeId" TEXT,
    "approvalTransactionId" TEXT,
    "swapTransactionId" TEXT,
    "approvalTransactionHash" TEXT,
    "swapTransactionHash" TEXT,
    "lifecycleStage" TEXT NOT NULL,
    "terminalStatus" TEXT,
    "failureReason" TEXT,
    "pollAttempts" INTEGER NOT NULL DEFAULT 0,
    "approvalChallengeCreatedAt" TIMESTAMP(3),
    "approvalSubmittedAt" TIMESTAMP(3),
    "approvalConfirmedAt" TIMESTAMP(3),
    "swapChallengeCreatedAt" TIMESTAMP(3),
    "swapSubmittedAt" TIMESTAMP(3),
    "swapConfirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppWalletXylonetOperation_pkey" PRIMARY KEY ("operationId")
);

CREATE UNIQUE INDEX "AppWalletXylonetOperation_approvalIdempotencyKey_key" ON "AppWalletXylonetOperation"("approvalIdempotencyKey");
CREATE UNIQUE INDEX "AppWalletXylonetOperation_swapIdempotencyKey_key" ON "AppWalletXylonetOperation"("swapIdempotencyKey");
CREATE UNIQUE INDEX "AppWalletXylonetOperation_approvalChallengeId_key" ON "AppWalletXylonetOperation"("approvalChallengeId");
CREATE UNIQUE INDEX "AppWalletXylonetOperation_swapChallengeId_key" ON "AppWalletXylonetOperation"("swapChallengeId");
CREATE UNIQUE INDEX "AppWalletXylonetOperation_approvalTransactionId_key" ON "AppWalletXylonetOperation"("approvalTransactionId");
CREATE UNIQUE INDEX "AppWalletXylonetOperation_swapTransactionId_key" ON "AppWalletXylonetOperation"("swapTransactionId");
CREATE INDEX "AppWalletXylonetOperation_applicationUserId_idx" ON "AppWalletXylonetOperation"("applicationUserId");
CREATE INDEX "AppWalletXylonetOperation_circleWalletId_idx" ON "AppWalletXylonetOperation"("circleWalletId");
CREATE INDEX "AppWalletXylonetOperation_lifecycleStage_idx" ON "AppWalletXylonetOperation"("lifecycleStage");
CREATE INDEX "AppWalletXylonetOperation_terminalStatus_idx" ON "AppWalletXylonetOperation"("terminalStatus");
CREATE INDEX "AppWalletXylonetOperation_approvalTransactionHash_idx" ON "AppWalletXylonetOperation"("approvalTransactionHash");
CREATE INDEX "AppWalletXylonetOperation_swapTransactionHash_idx" ON "AppWalletXylonetOperation"("swapTransactionHash");
