CREATE TYPE "SupplierBalanceEntryType" AS ENUM ('OPENING_BALANCE', 'GOODS_RECEIPT', 'PAYMENT', 'ADJUSTMENT');

ALTER TABLE "Purchase" ADD COLUMN "paymentStatus" "PosPaymentStatus" NOT NULL DEFAULT 'UNPAID';
ALTER TABLE "PurchaseItem" ADD COLUMN "taxMode" "TaxMode" NOT NULL DEFAULT 'INCLUSIVE';

ALTER TABLE "SupplierPayment" ADD COLUMN "purchaseId" TEXT;

CREATE TABLE "SupplierBalanceEntry" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "type" "SupplierBalanceEntryType" NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "balanceBefore" DECIMAL(12,2) NOT NULL,
  "balanceAfter" DECIMAL(12,2) NOT NULL,
  "note" TEXT,
  "purchaseId" TEXT,
  "goodsReceiptId" TEXT,
  "paymentId" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupplierBalanceEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseItemMenuPriceUpdate" (
  "id" TEXT NOT NULL,
  "purchaseItemId" TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  "sellingPrice" DECIMAL(12,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PurchaseItemMenuPriceUpdate_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplierBalanceEntry" ADD CONSTRAINT "SupplierBalanceEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierBalanceEntry" ADD CONSTRAINT "SupplierBalanceEntry_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierBalanceEntry" ADD CONSTRAINT "SupplierBalanceEntry_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplierBalanceEntry" ADD CONSTRAINT "SupplierBalanceEntry_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplierBalanceEntry" ADD CONSTRAINT "SupplierBalanceEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "SupplierPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplierBalanceEntry" ADD CONSTRAINT "SupplierBalanceEntry_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PurchaseItemMenuPriceUpdate" ADD CONSTRAINT "PurchaseItemMenuPriceUpdate_purchaseItemId_fkey" FOREIGN KEY ("purchaseItemId") REFERENCES "PurchaseItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseItemMenuPriceUpdate" ADD CONSTRAINT "PurchaseItemMenuPriceUpdate_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "SupplierPayment_purchaseId_idx" ON "SupplierPayment"("purchaseId");
CREATE INDEX "SupplierBalanceEntry_tenantId_supplierId_createdAt_idx" ON "SupplierBalanceEntry"("tenantId", "supplierId", "createdAt");
CREATE INDEX "SupplierBalanceEntry_purchaseId_idx" ON "SupplierBalanceEntry"("purchaseId");
CREATE INDEX "SupplierBalanceEntry_goodsReceiptId_idx" ON "SupplierBalanceEntry"("goodsReceiptId");
CREATE INDEX "SupplierBalanceEntry_paymentId_idx" ON "SupplierBalanceEntry"("paymentId");
CREATE UNIQUE INDEX "PurchaseItemMenuPriceUpdate_purchaseItemId_menuItemId_key" ON "PurchaseItemMenuPriceUpdate"("purchaseItemId", "menuItemId");
CREATE INDEX "PurchaseItemMenuPriceUpdate_menuItemId_idx" ON "PurchaseItemMenuPriceUpdate"("menuItemId");

INSERT INTO "SupplierBalanceEntry" ("id", "tenantId", "supplierId", "type", "amount", "balanceBefore", "balanceAfter", "note")
SELECT
  'cmig_' || md5(random()::text || clock_timestamp()::text || s."id"),
  s."tenantId",
  s."id",
  'OPENING_BALANCE'::"SupplierBalanceEntryType",
  s."balance",
  0,
  s."balance",
  'Opening supplier balance before ledger tracking'
FROM "Supplier" AS s
WHERE s."balance" <> 0;
