-- AlterTable
ALTER TABLE "Addon" ADD COLUMN     "recipeId" TEXT;

-- AlterTable
ALTER TABLE "MenuItemVariant" ADD COLUMN     "recipeId" TEXT;

-- CreateTable
CREATE TABLE "MenuItemVariantIngredient" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "isRemoved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MenuItemVariantIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MenuItemVariantIngredient_productId_idx" ON "MenuItemVariantIngredient"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemVariantIngredient_variantId_productId_key" ON "MenuItemVariantIngredient"("variantId", "productId");

-- AddForeignKey
ALTER TABLE "MenuItemVariantIngredient" ADD CONSTRAINT "MenuItemVariantIngredient_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "MenuItemVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemVariantIngredient" ADD CONSTRAINT "MenuItemVariantIngredient_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemVariant" ADD CONSTRAINT "MenuItemVariant_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Addon" ADD CONSTRAINT "Addon_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

