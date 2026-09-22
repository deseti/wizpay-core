ALTER TABLE "ActivityAuthSession"
ADD COLUMN "revokedAt" TIMESTAMP(3),
ADD COLUMN "lastUsedAt" TIMESTAMP(3);

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

CREATE UNIQUE INDEX "WalletAuthChallenge_nonceHash_key" ON "WalletAuthChallenge"("nonceHash");
CREATE INDEX "WalletAuthChallenge_walletAddress_createdAt_idx" ON "WalletAuthChallenge"("walletAddress", "createdAt");
CREATE INDEX "WalletAuthChallenge_expiresAt_idx" ON "WalletAuthChallenge"("expiresAt");

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

CREATE UNIQUE INDEX "VerifiedSwapTransaction_transactionHash_key" ON "VerifiedSwapTransaction"("transactionHash");
CREATE INDEX "VerifiedSwapTransaction_walletAddress_completedAt_idx" ON "VerifiedSwapTransaction"("walletAddress", "completedAt");
