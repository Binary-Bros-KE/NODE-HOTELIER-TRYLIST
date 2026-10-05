-- A store-dispatch kitchen may send orders to the store even when the store is out of stock.
ALTER TABLE "Location" ADD COLUMN "allowOutOfStockOrders" BOOLEAN NOT NULL DEFAULT false;
