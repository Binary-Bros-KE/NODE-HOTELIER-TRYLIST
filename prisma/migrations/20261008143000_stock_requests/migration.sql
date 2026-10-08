CREATE TYPE "StockRequestStatus" AS ENUM ('REQUESTED', 'DISPATCHED', 'REJECTED', 'CANCELLED');

CREATE TABLE "StockRequest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "requestNo" TEXT NOT NULL,
  "fromLocationId" TEXT NOT NULL,
  "toLocationId" TEXT NOT NULL,
  "status" "StockRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "note" TEXT,
  "requestedBy" TEXT,
  "requestedByName" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "respondedBy" TEXT,
  "respondedByName" TEXT,
  "respondedAt" TIMESTAMP(3),
  "rejectReason" TEXT,
  "transferId" TEXT,

  CONSTRAINT "StockRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StockRequestItem" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "requestedQty" DECIMAL(12,3) NOT NULL,
  "dispatchedQty" DECIMAL(12,3),

  CONSTRAINT "StockRequestItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockRequest_tenantId_requestNo_key" ON "StockRequest"("tenantId", "requestNo");
CREATE INDEX "StockRequest_tenantId_status_idx" ON "StockRequest"("tenantId", "status");
CREATE INDEX "StockRequest_tenantId_fromLocationId_idx" ON "StockRequest"("tenantId", "fromLocationId");
CREATE INDEX "StockRequest_tenantId_toLocationId_idx" ON "StockRequest"("tenantId", "toLocationId");
CREATE INDEX "StockRequestItem_requestId_idx" ON "StockRequestItem"("requestId");
CREATE INDEX "StockRequestItem_productId_idx" ON "StockRequestItem"("productId");

ALTER TABLE "StockRequest" ADD CONSTRAINT "StockRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockRequest" ADD CONSTRAINT "StockRequest_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockRequest" ADD CONSTRAINT "StockRequest_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockRequestItem" ADD CONSTRAINT "StockRequestItem_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "StockRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockRequestItem" ADD CONSTRAINT "StockRequestItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
