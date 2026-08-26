-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'VERIFYING', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoicePaymentStatus" AS ENUM ('SUBMITTED', 'VERIFYING', 'VERIFIED', 'REJECTED');

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "publicId" TEXT NOT NULL,
    "merchantUserId" TEXT NOT NULL,
    "merchantWalletAddress" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "amountUnits" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "invoiceNumber" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "payerAddress" TEXT,
    "status" "InvoicePaymentStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "rejectionCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_publicId_key" ON "Invoice"("publicId");
CREATE INDEX "Invoice_merchantUserId_createdAt_idx" ON "Invoice"("merchantUserId", "createdAt");
CREATE INDEX "Invoice_merchantUserId_status_idx" ON "Invoice"("merchantUserId", "status");
CREATE UNIQUE INDEX "InvoicePayment_invoiceId_key" ON "InvoicePayment"("invoiceId");
CREATE UNIQUE INDEX "InvoicePayment_transactionHash_key" ON "InvoicePayment"("transactionHash");

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
