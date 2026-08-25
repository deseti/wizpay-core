-- CreateTable
CREATE TABLE "BridgeTransaction" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BridgeTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BridgeTransaction_taskId_key" ON "BridgeTransaction"("taskId");

-- AddForeignKey
ALTER TABLE "BridgeTransaction" ADD CONSTRAINT "BridgeTransaction_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
