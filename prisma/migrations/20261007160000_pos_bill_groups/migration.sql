ALTER TABLE "PosOrder" ADD COLUMN "billGroupId" TEXT;

CREATE INDEX "PosOrder_tenantId_billGroupId_idx" ON "PosOrder"("tenantId", "billGroupId");
