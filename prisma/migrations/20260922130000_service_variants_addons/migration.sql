-- CreateEnum
CREATE TYPE "AddonScope" AS ENUM ('MENU', 'SERVICE');

-- AlterTable
ALTER TABLE "Addon" ADD COLUMN     "scope" "AddonScope" NOT NULL DEFAULT 'MENU',
ADD COLUMN     "serviceCategoryId" TEXT;

-- AlterTable
ALTER TABLE "PosOrderItem" ADD COLUMN     "listPrice" DECIMAL(12,2),
ADD COLUMN     "priceOverriddenBy" TEXT,
ADD COLUMN     "priceOverrideReason" TEXT,
ADD COLUMN     "serviceVariantId" TEXT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "durationMinutes" INTEGER,
ADD COLUMN     "productId" TEXT,
ADD COLUMN     "recipeId" TEXT,
ADD COLUMN     "stockQtyPerUnit" DECIMAL(12,3);

-- CreateTable
CREATE TABLE "ServiceVariant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "durationMinutes" INTEGER,
    "cost" DECIMAL(12,2),
    "stockProductId" TEXT,
    "stockQtyPerUnit" DECIMAL(12,3),
    "recipeId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceVariantIngredient" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "isRemoved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ServiceVariantIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceVariant_tenantId_serviceId_idx" ON "ServiceVariant"("tenantId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceVariant_tenantId_serviceId_name_key" ON "ServiceVariant"("tenantId", "serviceId", "name");

-- CreateIndex
CREATE INDEX "ServiceVariantIngredient_productId_idx" ON "ServiceVariantIngredient"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceVariantIngredient_variantId_productId_key" ON "ServiceVariantIngredient"("variantId", "productId");

-- CreateIndex
CREATE INDEX "PosOrderItem_serviceVariantId_idx" ON "PosOrderItem"("serviceVariantId");

-- AddForeignKey
ALTER TABLE "ServiceVariant" ADD CONSTRAINT "ServiceVariant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVariant" ADD CONSTRAINT "ServiceVariant_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVariant" ADD CONSTRAINT "ServiceVariant_stockProductId_fkey" FOREIGN KEY ("stockProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVariant" ADD CONSTRAINT "ServiceVariant_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVariantIngredient" ADD CONSTRAINT "ServiceVariantIngredient_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ServiceVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVariantIngredient" ADD CONSTRAINT "ServiceVariantIngredient_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosOrderItem" ADD CONSTRAINT "PosOrderItem_serviceVariantId_fkey" FOREIGN KEY ("serviceVariantId") REFERENCES "ServiceVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Addon" ADD CONSTRAINT "Addon_serviceCategoryId_fkey" FOREIGN KEY ("serviceCategoryId") REFERENCES "ServiceCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

