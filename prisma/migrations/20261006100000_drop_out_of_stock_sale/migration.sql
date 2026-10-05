-- Selling out of stock is not allowed anywhere, so the Location flag is removed.
ALTER TABLE "Location" DROP COLUMN IF EXISTS "allowOutOfStockSale";
