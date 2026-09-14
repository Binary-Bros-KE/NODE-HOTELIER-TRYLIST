UPDATE "InventoryMovement" AS m
SET "value" = ROUND((ABS(m."quantity") / p."packSize") * COALESCE(m."unitCost", p."unitCost"), 2)
FROM "Product" AS p
WHERE m."productId" = p."id"
  AND p."packSize" IS NOT NULL
  AND p."packSize" > 0
  AND COALESCE(m."unitCost", p."unitCost") IS NOT NULL;

UPDATE "PurchaseItem" AS i
SET
  "lineTotal" = ROUND((i."quantity" / p."packSize") * GREATEST(0, i."unitCost" - i."discountPerUnit"), 2),
  "taxAmount" = CASE
    WHEN i."taxTreatment" = 'STANDARD' AND i."taxRate" > 0 THEN
      ROUND(
        ((i."quantity" / p."packSize") * GREATEST(0, i."unitCost" - i."discountPerUnit"))
        - (((i."quantity" / p."packSize") * GREATEST(0, i."unitCost" - i."discountPerUnit")) / (1 + i."taxRate" / 100)),
        2
      )
    ELSE 0
  END
FROM "Product" AS p
WHERE i."productId" = p."id"
  AND p."packSize" IS NOT NULL
  AND p."packSize" > 0;

UPDATE "Purchase" AS po
SET
  "total" = totals."total",
  "taxAmount" = totals."taxAmount",
  "subtotal" = totals."total" - totals."taxAmount"
FROM (
  SELECT
    "purchaseId",
    ROUND(SUM("lineTotal"), 2) AS "total",
    ROUND(SUM("taxAmount"), 2) AS "taxAmount"
  FROM "PurchaseItem"
  GROUP BY "purchaseId"
) AS totals
WHERE po."id" = totals."purchaseId";

UPDATE "Supplier" AS s
SET "balance" = ROUND(COALESCE(receipts."total", 0) - COALESCE(payments."total", 0), 2)
FROM (
  SELECT
    p."supplierId",
    ROUND(SUM(
      CASE
        WHEN prod."packSize" IS NOT NULL AND prod."packSize" > 0 THEN
          (gri."quantity" / prod."packSize") * gri."unitCost"
        ELSE gri."quantity" * gri."unitCost"
      END
    ), 2) AS "total"
  FROM "GoodsReceiptItem" AS gri
  JOIN "GoodsReceipt" AS gr ON gr."id" = gri."goodsReceiptId"
  JOIN "Purchase" AS p ON p."id" = gr."purchaseId"
  JOIN "Product" AS prod ON prod."id" = gri."productId"
  GROUP BY p."supplierId"
) AS receipts
FULL OUTER JOIN (
  SELECT "supplierId", ROUND(SUM("amount"), 2) AS "total"
  FROM "SupplierPayment"
  GROUP BY "supplierId"
) AS payments ON payments."supplierId" = receipts."supplierId"
WHERE s."id" = COALESCE(receipts."supplierId", payments."supplierId");
