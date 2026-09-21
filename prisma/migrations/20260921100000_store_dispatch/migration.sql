-- CreateEnum
CREATE TYPE "StockDispatchStatus" AS ENUM ('REQUESTED', 'DISPATCHED', 'REJECTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "Permission" ADD VALUE 'STORE_DISPATCH';

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "dispatchFromLocationId" TEXT,
ADD COLUMN     "requireStoreDispatch" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PosOrder" ADD COLUMN     "preparingAt" TIMESTAMP(3),
ADD COLUMN     "preparingBy" TEXT,
ADD COLUMN     "readyBy" TEXT;

-- AlterTable
ALTER TABLE "PosOrderItem" ADD COLUMN     "dispatchRequestId" TEXT;

-- CreateTable
CREATE TABLE "StockDispatchRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestNo" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" INTEGER NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "status" "StockDispatchStatus" NOT NULL DEFAULT 'REQUESTED',
    "note" TEXT,
    "requestedBy" TEXT,
    "requestedByName" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedBy" TEXT,
    "respondedByName" TEXT,
    "respondedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "transferId" TEXT,

    CONSTRAINT "StockDispatchRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockDispatchItem" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "requestedQty" DECIMAL(12,3) NOT NULL,
    "dispatchedQty" DECIMAL(12,3),

    CONSTRAINT "StockDispatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockDispatchRequest_tenantId_status_idx" ON "StockDispatchRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "StockDispatchRequest_orderId_idx" ON "StockDispatchRequest"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "StockDispatchRequest_tenantId_requestNo_key" ON "StockDispatchRequest"("tenantId", "requestNo");

-- CreateIndex
CREATE INDEX "StockDispatchItem_requestId_idx" ON "StockDispatchItem"("requestId");

-- CreateIndex
CREATE INDEX "PosOrderItem_dispatchRequestId_idx" ON "PosOrderItem"("dispatchRequestId");

-- AddForeignKey
ALTER TABLE "StockDispatchRequest" ADD CONSTRAINT "StockDispatchRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDispatchRequest" ADD CONSTRAINT "StockDispatchRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PosOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDispatchRequest" ADD CONSTRAINT "StockDispatchRequest_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDispatchRequest" ADD CONSTRAINT "StockDispatchRequest_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDispatchItem" ADD CONSTRAINT "StockDispatchItem_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "StockDispatchRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDispatchItem" ADD CONSTRAINT "StockDispatchItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosOrderItem" ADD CONSTRAINT "PosOrderItem_dispatchRequestId_fkey" FOREIGN KEY ("dispatchRequestId") REFERENCES "StockDispatchRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

