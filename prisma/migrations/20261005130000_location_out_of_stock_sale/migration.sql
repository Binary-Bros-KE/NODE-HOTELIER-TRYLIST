-- Locations can sell items that are out of stock (e.g. a restaurant posting before its counts are in).
ALTER TABLE "Location" ADD COLUMN "allowOutOfStockSale" BOOLEAN NOT NULL DEFAULT false;
