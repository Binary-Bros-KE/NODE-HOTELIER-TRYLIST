-- Room & location contents: asset condition, what a room actually holds of each consumable.
CREATE TYPE "AssetCondition" AS ENUM ('WORKING', 'NEEDS_REPAIR', 'UNDER_REPAIR', 'BROKEN', 'MISSING');

ALTER TABLE "Asset"
  ADD COLUMN "condition" "AssetCondition" NOT NULL DEFAULT 'WORKING',
  ADD COLUMN "conditionNote" TEXT,
  ADD COLUMN "affectedQuantity" DECIMAL(12,3),
  ADD COLUMN "conditionUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "conditionUpdatedBy" TEXT;
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_conditionUpdatedBy_fkey" FOREIGN KEY ("conditionUpdatedBy") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AssetConditionLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "fromCondition" "AssetCondition" NOT NULL,
    "toCondition" "AssetCondition" NOT NULL,
    "affectedQuantity" DECIMAL(12,3),
    "note" TEXT,
    "changedBy" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssetConditionLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AssetConditionLog_tenantId_assetId_changedAt_idx" ON "AssetConditionLog"("tenantId", "assetId", "changedAt");
ALTER TABLE "AssetConditionLog" ADD CONSTRAINT "AssetConditionLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetConditionLog" ADD CONSTRAINT "AssetConditionLog_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetConditionLog" ADD CONSTRAINT "AssetConditionLog_changedBy_fkey" FOREIGN KEY ("changedBy") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RoomConsumableUsageItem" ADD COLUMN "usedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0;

CREATE TABLE "RoomConsumableStock" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "firstPlacedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReplacedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RoomConsumableStock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RoomConsumableStock_tenantId_roomId_productId_key" ON "RoomConsumableStock"("tenantId", "roomId", "productId");
CREATE INDEX "RoomConsumableStock_tenantId_roomId_idx" ON "RoomConsumableStock"("tenantId", "roomId");
ALTER TABLE "RoomConsumableStock" ADD CONSTRAINT "RoomConsumableStock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomConsumableStock" ADD CONSTRAINT "RoomConsumableStock_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomConsumableStock" ADD CONSTRAINT "RoomConsumableStock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed the room counts from replenishments already recorded (before this, every restock only added).
INSERT INTO "RoomConsumableStock" ("id", "tenantId", "roomId", "productId", "quantity", "firstPlacedAt", "lastReplacedAt", "updatedAt")
SELECT gen_random_uuid()::text, u."tenantId", u."roomId", i."productId", SUM(i."quantity"), MIN(u."createdAt"), MAX(u."createdAt"), CURRENT_TIMESTAMP
FROM "RoomConsumableUsageItem" i
JOIN "RoomConsumableUsage" u ON u."id" = i."usageId"
GROUP BY u."tenantId", u."roomId", i."productId";
