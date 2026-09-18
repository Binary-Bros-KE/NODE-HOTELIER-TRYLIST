-- DropIndex
DROP INDEX "PurchaseItemMenuPriceUpdate_purchaseItemId_menuItemId_key";

-- AlterTable
ALTER TABLE "PurchaseItemMenuPriceUpdate" ADD COLUMN     "variantId" TEXT;

-- CreateIndex
CREATE INDEX "PurchaseItemMenuPriceUpdate_variantId_idx" ON "PurchaseItemMenuPriceUpdate"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseItemMenuPriceUpdate_purchaseItemId_menuItemId_varia_key" ON "PurchaseItemMenuPriceUpdate"("purchaseItemId", "menuItemId", "variantId");

-- AddForeignKey
ALTER TABLE "PurchaseItemMenuPriceUpdate" ADD CONSTRAINT "PurchaseItemMenuPriceUpdate_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "MenuItemVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
