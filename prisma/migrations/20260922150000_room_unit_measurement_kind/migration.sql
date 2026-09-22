-- Room pricing was hard-locked to 3 built-in units (Hour/Night/Day, gated
-- on UnitOfMeasure.systemKey) because that was the only thing the charge
-- formula knew how to compute. This replaces that gate with an explicit
-- measurementKind every unit declares — built-in or a tenant's own — so
-- "per person" (and anything else) is a real, usable option, not just a
-- name that happens to sit next to a price.

-- CreateEnum
CREATE TYPE "UnitMeasurementKind" AS ENUM ('HOURS', 'MINUTES', 'DAYS', 'HEADCOUNT', 'EACH');

-- AlterTable
ALTER TABLE "UnitOfMeasure" ADD COLUMN "measurementKind" "UnitMeasurementKind";

-- Backfill every tenant's existing built-in units by their systemKey.
UPDATE "UnitOfMeasure" SET "measurementKind" = 'HOURS' WHERE "systemKey" = 'HOUR';
UPDATE "UnitOfMeasure" SET "measurementKind" = 'DAYS' WHERE "systemKey" IN ('NIGHT', 'DAY');
-- Any tenant's own custom unit (systemKey null) that predates this column
-- defaults to EACH — a flat quantity of 1, the safest fallback (never
-- silently multiplies a price by an assumed time span or headcount).
UPDATE "UnitOfMeasure" SET "measurementKind" = 'EACH' WHERE "measurementKind" IS NULL;

-- FolioLineItem.quantity: Int -> Decimal(12,3). A widening, lossless change
-- (every existing value is a whole number already) — needed so an
-- auto-calculated HOURS/MINUTES charge (e.g. a 4.3-hour stay) can be stored
-- as-is instead of being silently rounded on the way in.
ALTER TABLE "FolioLineItem" ALTER COLUMN "quantity" DROP DEFAULT;
ALTER TABLE "FolioLineItem" ALTER COLUMN "quantity" TYPE DECIMAL(12,3) USING "quantity"::DECIMAL(12,3);
ALTER TABLE "FolioLineItem" ALTER COLUMN "quantity" SET DEFAULT 1;
