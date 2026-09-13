-- Move purchase pricing/tax detail down to each line and let products carry
-- tax defaults for future direct retail sales.

ALTER TABLE "Product"
  ADD COLUMN "taxRate" DECIMAL(5,2),
  ADD COLUMN "taxMode" "TaxMode",
  ADD COLUMN "taxTreatment" "TaxTreatment";

ALTER TABLE "PurchaseItem"
  ADD COLUMN "sellingPrice" DECIMAL(12,2),
  ADD COLUMN "discountPerUnit" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN "taxTreatment" "TaxTreatment" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

UPDATE "PurchaseItem" pi
SET
  "sellingPrice" = p."sellingPrice",
  "taxRate" = po."taxRate",
  "taxTreatment" = CASE WHEN po."taxRate" > 0 THEN 'STANDARD'::"TaxTreatment" ELSE 'ZERO_RATED'::"TaxTreatment" END,
  "taxAmount" = CASE
    WHEN po."taxRate" > 0 THEN ROUND((pi."lineTotal" - (pi."lineTotal" / (1 + (po."taxRate" / 100))))::numeric, 2)
    ELSE 0
  END
FROM "Purchase" po, "Product" p
WHERE pi."purchaseId" = po."id"
  AND pi."productId" = p."id";
