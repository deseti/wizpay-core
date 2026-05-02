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

-- CreateIndex
CREATE INDEX "TaskTransaction_taskId_idx" ON "TaskTransaction"("taskId");

-- CreateIndex
CREATE INDEX "TaskTransaction_txId_idx" ON "TaskTransaction"("txId");

-- CreateIndex
CREATE INDEX "TaskTransaction_taskId_status_idx" ON "TaskTransaction"("taskId", "status");

-- AddForeignKey
ALTER TABLE "TaskTransaction" ADD CONSTRAINT "TaskTransaction_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
