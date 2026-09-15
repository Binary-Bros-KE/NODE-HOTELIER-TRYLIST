-- CreateEnum
CREATE TYPE "PosReturnRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "PosOrderReturnRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "PosReturnRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "PosOrderReturnRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosOrderReturnRequest_tenantId_status_requestedAt_idx" ON "PosOrderReturnRequest"("tenantId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "PosOrderReturnRequest_orderId_idx" ON "PosOrderReturnRequest"("orderId");

-- CreateIndex
CREATE INDEX "PosOrderReturnRequest_orderItemId_idx" ON "PosOrderReturnRequest"("orderItemId");

-- AddForeignKey
ALTER TABLE "PosOrderReturnRequest" ADD CONSTRAINT "PosOrderReturnRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosOrderReturnRequest" ADD CONSTRAINT "PosOrderReturnRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PosOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosOrderReturnRequest" ADD CONSTRAINT "PosOrderReturnRequest_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "PosOrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
