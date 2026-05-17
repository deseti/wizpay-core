-- Persist App Wallet swap operation state across backend restarts.
CREATE TABLE "AppWalletSwapOperation" (
    "operationId" UUID NOT NULL,
    "operationMode" TEXT NOT NULL,
    "sourceChain" TEXT NOT NULL,
    "tokenIn" TEXT NOT NULL,
    "tokenOut" TEXT NOT NULL,
    "amountIn" TEXT NOT NULL,
    "userWalletAddress" TEXT NOT NULL,
    "treasuryDepositAddress" TEXT NOT NULL,
    "expectedOutput" JSONB,
    "minimumOutput" JSONB,
    "expiresAt" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "quoteId" JSONB,
    "rawQuote" JSONB,
    "depositTxHash" TEXT,
    "circleTransactionId" TEXT,
    "circleReferenceId" TEXT,
    "circleWalletId" TEXT,
    "depositSubmittedAt" TIMESTAMP(3),
    "depositConfirmedAt" TIMESTAMP(3),
    "depositConfirmedAmount" TEXT,
    "depositConfirmationError" TEXT,
    "executionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppWalletSwapOperation_pkey" PRIMARY KEY ("operationId")
);

CREATE INDEX "AppWalletSwapOperation_status_idx" ON "AppWalletSwapOperation"("status");
CREATE INDEX "AppWalletSwapOperation_circleTransactionId_idx" ON "AppWalletSwapOperation"("circleTransactionId");
CREATE INDEX "AppWalletSwapOperation_circleReferenceId_idx" ON "AppWalletSwapOperation"("circleReferenceId");
CREATE INDEX "AppWalletSwapOperation_depositTxHash_idx" ON "AppWalletSwapOperation"("depositTxHash");
