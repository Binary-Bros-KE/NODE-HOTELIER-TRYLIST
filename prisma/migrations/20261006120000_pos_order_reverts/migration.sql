-- A record of each reverted order, so the Approvals tab can show what was taken off the books.
CREATE TABLE "PosOrderRevert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderNumber" INTEGER NOT NULL,
    "locationName" TEXT,
    "tableLabel" TEXT,
    "orderStatus" TEXT NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "items" JSONB NOT NULL,
    "dispatchNos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "createdByName" TEXT,
    "revertedById" TEXT,
    "revertedByName" TEXT,
    "revertedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosOrderRevert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PosOrderRevert_tenantId_revertedAt_idx" ON "PosOrderRevert"("tenantId", "revertedAt");
