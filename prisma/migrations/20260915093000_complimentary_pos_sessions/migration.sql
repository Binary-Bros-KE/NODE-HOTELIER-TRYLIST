CREATE TYPE "PosOrderSaleType" AS ENUM ('SALE', 'COMPLIMENTARY');
CREATE TYPE "ComplimentaryOrderRole" AS ENUM ('HOST_COMP', 'GUEST_SPEND');
CREATE TYPE "ComplimentarySessionStatus" AS ENUM ('OPEN', 'CLOSED');

CREATE TABLE "ComplimentarySession" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "hostName" TEXT NOT NULL,
  "hostPhone" TEXT,
  "eventDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" "ComplimentarySessionStatus" NOT NULL DEFAULT 'OPEN',
  "notes" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ComplimentarySession_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PosOrder" ADD COLUMN "saleType" "PosOrderSaleType" NOT NULL DEFAULT 'SALE';
ALTER TABLE "PosOrder" ADD COLUMN "complimentarySessionId" TEXT;
ALTER TABLE "PosOrder" ADD COLUMN "complimentaryOrderRole" "ComplimentaryOrderRole";
ALTER TABLE "PosOrder" ADD COLUMN "complimentaryReason" TEXT;

ALTER TABLE "ComplimentarySession" ADD CONSTRAINT "ComplimentarySession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PosOrder" ADD CONSTRAINT "PosOrder_complimentarySessionId_fkey" FOREIGN KEY ("complimentarySessionId") REFERENCES "ComplimentarySession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ComplimentarySession_tenantId_status_eventDate_idx" ON "ComplimentarySession"("tenantId", "status", "eventDate");
CREATE INDEX "PosOrder_tenantId_saleType_updatedAt_idx" ON "PosOrder"("tenantId", "saleType", "updatedAt");
CREATE INDEX "PosOrder_complimentarySessionId_idx" ON "PosOrder"("complimentarySessionId");
