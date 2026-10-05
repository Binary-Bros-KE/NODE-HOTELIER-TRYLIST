-- Product stock tracking: how a product's stock leaves a location (per dish,
-- issued and treated as used, or kept on the shelf and counted).
CREATE TYPE "StockTrackingMode" AS ENUM ('PER_SALE', 'ISSUE_ONLY', 'PERIODIC_COUNT');

ALTER TABLE "Product" ADD COLUMN "trackingMode" "StockTrackingMode" NOT NULL DEFAULT 'PER_SALE';

ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'ISSUE';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'USAGE';
