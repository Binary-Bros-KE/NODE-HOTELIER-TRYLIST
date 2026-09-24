-- Distinguish ordinary customer credit from POS orders billed to a room,
-- and keep the reception-side settlement audit on the order.
ALTER TABLE "PosOrder"
    ADD COLUMN "billedToRoomAt" TIMESTAMP(3),
    ADD COLUMN "billedToRoomBy" TEXT,
    ADD COLUMN "roomBillSettledAt" TIMESTAMP(3),
    ADD COLUMN "roomBillSettledBy" TEXT,
    ADD COLUMN "roomBillSettlementLocation" TEXT,
    ADD COLUMN "roomBillSettlementMethod" TEXT,
    ADD COLUMN "roomBillSettlementReference" TEXT;

CREATE INDEX "PosOrder_tenantId_billedToRoomAt_idx" ON "PosOrder"("tenantId", "billedToRoomAt");

UPDATE "PosOrder" o
SET
    "billedToRoomAt" = COALESCE(o."billedToRoomAt", f."createdAt"),
    "billedToRoomBy" = COALESCE(o."billedToRoomBy", f."createdBy")
FROM "FolioLineItem" f
WHERE f."source" = 'POS_ORDER'
  AND f."sourceRefId" = o."id";

UPDATE "FolioLineItem" f
SET "label" = f."label" || ' - ' || l."name"
FROM "PosOrder" o
JOIN "Location" l ON l."id" = o."locationId"
WHERE f."source" = 'POS_ORDER'
  AND f."sourceRefId" = o."id"
  AND f."label" NOT LIKE '% - %';
