-- CreateEnum
CREATE TYPE "StoreUsageStatus" AS ENUM ('ACTIVE', 'VOIDED');

-- CreateTable
CREATE TABLE "UsageCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "usageNo" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "usedAtLocationId" TEXT,
    "title" TEXT,
    "note" TEXT,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "StoreUsageStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdBy" TEXT,
    "voidedBy" TEXT,
    "voidReason" TEXT,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreUsageItem" (
    "id" TEXT NOT NULL,
    "usageId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitCost" DECIMAL(12,2),
    "value" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "StoreUsageItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageCategory_tenantId_name_key" ON "UsageCategory"("tenantId", "name");

-- CreateIndex
CREATE INDEX "StoreUsage_tenantId_usedAt_idx" ON "StoreUsage"("tenantId", "usedAt");

-- CreateIndex
CREATE INDEX "StoreUsage_tenantId_categoryId_idx" ON "StoreUsage"("tenantId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreUsage_tenantId_usageNo_key" ON "StoreUsage"("tenantId", "usageNo");

-- CreateIndex
CREATE INDEX "StoreUsageItem_usageId_idx" ON "StoreUsageItem"("usageId");

-- CreateIndex
CREATE INDEX "StoreUsageItem_productId_idx" ON "StoreUsageItem"("productId");

-- AddForeignKey
ALTER TABLE "UsageCategory" ADD CONSTRAINT "UsageCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreUsage" ADD CONSTRAINT "StoreUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreUsage" ADD CONSTRAINT "StoreUsage_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "UsageCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreUsage" ADD CONSTRAINT "StoreUsage_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreUsage" ADD CONSTRAINT "StoreUsage_usedAtLocationId_fkey" FOREIGN KEY ("usedAtLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreUsageItem" ADD CONSTRAINT "StoreUsageItem_usageId_fkey" FOREIGN KEY ("usageId") REFERENCES "StoreUsage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreUsageItem" ADD CONSTRAINT "StoreUsageItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

