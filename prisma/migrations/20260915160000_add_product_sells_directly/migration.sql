-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "sellsDirectly" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: preserve existing behaviour for every product that was already
-- sellable via Products POS under the old implicit rule (sellingPrice IS
-- NOT NULL) — without this, every tenant's real retail products (water,
-- decor, snacks, etc.) would silently vanish from Products POS the moment
-- this migration runs, tenant-agnostic across the whole platform.
UPDATE "Product" SET "sellsDirectly" = true WHERE "sellingPrice" IS NOT NULL;
