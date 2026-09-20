-- Every tenant gets a "Night" unit of measure (existing rates were all per night).
INSERT INTO "UnitOfMeasure" ("id", "tenantId", "name", "createdAt", "updatedAt")
SELECT 'uom_night_' || t."tenantId", t."tenantId", 'Night', NOW(), NOW()
FROM (SELECT DISTINCT "tenantId" FROM "RoomType") t
WHERE NOT EXISTS (SELECT 1 FROM "UnitOfMeasure" u WHERE u."tenantId" = t."tenantId" AND lower(u."name") = 'night');

-- DropIndex
DROP INDEX "RoomRate_roomTypeId_mealPlan_key";

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "rateId" TEXT,
ADD COLUMN     "rateName" TEXT;

-- AlterTable
ALTER TABLE "RoomRate" ADD COLUMN     "name" TEXT,
ADD COLUMN     "unitId" TEXT,
ALTER COLUMN "mealPlan" DROP NOT NULL;

-- AlterTable
ALTER TABLE "RoomType" ADD COLUMN     "priceUnitId" TEXT;

-- Backfill: old hardcoded meal-plan tiers become named variants priced per night.
UPDATE "RoomRate" SET "name" = CASE "mealPlan"
  WHEN 'ROOM_ONLY' THEN 'Room Only'
  WHEN 'BED_AND_BREAKFAST' THEN 'Bed & Breakfast'
  WHEN 'HALF_BOARD' THEN 'Half Board'
  WHEN 'FULL_BOARD' THEN 'Full Board'
  ELSE 'Standard' END;
UPDATE "RoomRate" r SET "unitId" = (SELECT u."id" FROM "UnitOfMeasure" u WHERE u."tenantId" = r."tenantId" AND lower(u."name") = 'night' ORDER BY u."name" DESC LIMIT 1);
UPDATE "RoomType" t SET "priceUnitId" = (SELECT u."id" FROM "UnitOfMeasure" u WHERE u."tenantId" = t."tenantId" AND lower(u."name") = 'night' ORDER BY u."name" DESC LIMIT 1);
ALTER TABLE "RoomRate" ALTER COLUMN "name" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "RoomRate_roomTypeId_name_key" ON "RoomRate"("roomTypeId", "name");

-- AddForeignKey
ALTER TABLE "RoomRate" ADD CONSTRAINT "RoomRate_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "UnitOfMeasure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomType" ADD CONSTRAINT "RoomType_priceUnitId_fkey" FOREIGN KEY ("priceUnitId") REFERENCES "UnitOfMeasure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_rateId_fkey" FOREIGN KEY ("rateId") REFERENCES "RoomRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
