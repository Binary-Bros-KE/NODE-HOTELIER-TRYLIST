-- Assign durable assets directly to rooms, while keeping location-level assets
-- for general stock/equipment pools.
ALTER TABLE "Asset" ADD COLUMN "roomId" TEXT;

CREATE INDEX "Asset_tenantId_roomId_idx" ON "Asset"("tenantId", "roomId");

ALTER TABLE "Asset"
    ADD CONSTRAINT "Asset_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
