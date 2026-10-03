-- Additive PostgreSQL delivery metadata, portable to VPS and Supabase.
-- No scheduler, extension, credential or financial execution is installed.
CREATE TABLE "ReconciliationWork" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "evidenceKey" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'arc-mainnet',
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReconciliationWork_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReconciliationWork_kind_check" CHECK ("kind" IN ('INTENT', 'SWAP', 'BRIDGE', 'ACTIVITY')),
    CONSTRAINT "ReconciliationWork_network_check" CHECK ("network" = 'arc-mainnet'),
    CONSTRAINT "ReconciliationWork_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "ReconciliationWork_lease_check" CHECK (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL))
);
CREATE UNIQUE INDEX "ReconciliationWork_kind_recordId_evidenceKey_key"
  ON "ReconciliationWork"("kind", "recordId", "evidenceKey");
CREATE INDEX "ReconciliationWork_network_availableAt_leaseExpiresAt_idx"
  ON "ReconciliationWork"("network", "availableAt", "leaseExpiresAt");
