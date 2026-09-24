-- Room consumables: amenities/supplies that are included in the room rate
-- but still need stock and cost tracking when housekeeping replenishes them.
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'ROOM_CONSUMPTION';

CREATE TABLE "RoomConsumableStandard" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomConsumableStandard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RoomConsumableUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "usageNo" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "taskId" TEXT,
    "locationId" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomConsumableUsage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RoomConsumableUsageItem" (
    "id" TEXT NOT NULL,
    "usageId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "movementId" TEXT,

    CONSTRAINT "RoomConsumableUsageItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RoomConsumableStandard_tenantId_roomTypeId_productId_key"
    ON "RoomConsumableStandard"("tenantId", "roomTypeId", "productId");
CREATE INDEX "RoomConsumableStandard_tenantId_roomTypeId_idx"
    ON "RoomConsumableStandard"("tenantId", "roomTypeId");
CREATE INDEX "RoomConsumableStandard_tenantId_productId_idx"
    ON "RoomConsumableStandard"("tenantId", "productId");

CREATE UNIQUE INDEX "RoomConsumableUsage_tenantId_usageNo_key"
    ON "RoomConsumableUsage"("tenantId", "usageNo");
CREATE INDEX "RoomConsumableUsage_tenantId_roomId_createdAt_idx"
    ON "RoomConsumableUsage"("tenantId", "roomId", "createdAt");
CREATE INDEX "RoomConsumableUsage_tenantId_taskId_idx"
    ON "RoomConsumableUsage"("tenantId", "taskId");
CREATE INDEX "RoomConsumableUsage_tenantId_locationId_createdAt_idx"
    ON "RoomConsumableUsage"("tenantId", "locationId", "createdAt");

CREATE INDEX "RoomConsumableUsageItem_usageId_idx"
    ON "RoomConsumableUsageItem"("usageId");
CREATE INDEX "RoomConsumableUsageItem_productId_idx"
    ON "RoomConsumableUsageItem"("productId");
CREATE INDEX "RoomConsumableUsageItem_movementId_idx"
    ON "RoomConsumableUsageItem"("movementId");

ALTER TABLE "RoomConsumableStandard"
    ADD CONSTRAINT "RoomConsumableStandard_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomConsumableStandard"
    ADD CONSTRAINT "RoomConsumableStandard_roomTypeId_fkey"
    FOREIGN KEY ("roomTypeId") REFERENCES "RoomType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomConsumableStandard"
    ADD CONSTRAINT "RoomConsumableStandard_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RoomConsumableUsage"
    ADD CONSTRAINT "RoomConsumableUsage_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomConsumableUsage"
    ADD CONSTRAINT "RoomConsumableUsage_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomConsumableUsage"
    ADD CONSTRAINT "RoomConsumableUsage_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "HousekeepingTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RoomConsumableUsage"
    ADD CONSTRAINT "RoomConsumableUsage_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomConsumableUsage"
    ADD CONSTRAINT "RoomConsumableUsage_createdBy_fkey"
    FOREIGN KEY ("createdBy") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RoomConsumableUsageItem"
    ADD CONSTRAINT "RoomConsumableUsageItem_usageId_fkey"
    FOREIGN KEY ("usageId") REFERENCES "RoomConsumableUsage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomConsumableUsageItem"
    ADD CONSTRAINT "RoomConsumableUsageItem_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomConsumableUsageItem"
    ADD CONSTRAINT "RoomConsumableUsageItem_movementId_fkey"
    FOREIGN KEY ("movementId") REFERENCES "InventoryMovement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
