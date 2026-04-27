-- AlterTable
ALTER TABLE "Task"
ADD COLUMN "totalUnits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "completedUnits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failedUnits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "metadata" JSONB;

-- AlterTable
ALTER TABLE "TaskLog"
ADD COLUMN "level" TEXT NOT NULL DEFAULT 'INFO',
ADD COLUMN "context" JSONB;

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

-- CreateIndex
CREATE INDEX "TaskUnit_taskId_idx" ON "TaskUnit"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskUnit_taskId_id_key" ON "TaskUnit"("taskId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TaskUnit_taskId_index_key" ON "TaskUnit"("taskId", "index");

-- AddForeignKey
ALTER TABLE "TaskUnit" ADD CONSTRAINT "TaskUnit_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;