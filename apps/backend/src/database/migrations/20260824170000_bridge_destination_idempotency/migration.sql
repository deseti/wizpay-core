ALTER TABLE "BridgeTransaction"
ADD COLUMN "messageHash" TEXT,
ADD COLUMN "nonce" TEXT,
ADD COLUMN "destinationTransactionHash" TEXT,
ADD COLUMN "destinationLeaseId" UUID,
ADD COLUMN "destinationLeaseExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "BridgeTransaction_messageHash_key" ON "BridgeTransaction"("messageHash");
CREATE UNIQUE INDEX "BridgeTransaction_nonce_key" ON "BridgeTransaction"("nonce");
CREATE UNIQUE INDEX "BridgeTransaction_destinationTransactionHash_key" ON "BridgeTransaction"("destinationTransactionHash");
CREATE UNIQUE INDEX "BridgeTransaction_destinationLeaseId_key" ON "BridgeTransaction"("destinationLeaseId");
CREATE INDEX "BridgeTransaction_status_idx" ON "BridgeTransaction"("status");
