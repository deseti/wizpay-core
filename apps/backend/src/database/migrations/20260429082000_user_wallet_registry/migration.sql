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

-- CreateIndex
CREATE INDEX "UserWallet_userId_idx" ON "UserWallet"("userId");

-- CreateIndex
CREATE INDEX "UserWallet_userId_chain_idx" ON "UserWallet"("userId", "chain");

-- CreateIndex
CREATE UNIQUE INDEX "UserWallet_walletId_key" ON "UserWallet"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "UserWallet_userId_blockchain_key" ON "UserWallet"("userId", "blockchain");