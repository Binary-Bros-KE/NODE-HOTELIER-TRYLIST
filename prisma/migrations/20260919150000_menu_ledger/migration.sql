-- CreateEnum
CREATE TYPE "MenuLedgerType" AS ENUM ('SALE', 'COMPLIMENTARY', 'RETURN');

-- CreateTable
CREATE TABLE "MenuLedgerEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "MenuLedgerType" NOT NULL,
    "menuItemId" TEXT,
    "itemName" TEXT NOT NULL,
    "variantName" TEXT,
    "addonsNote" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderNumber" INTEGER NOT NULL,
    "locationId" TEXT,
    "note" TEXT,
    "performedBy" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MenuLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MenuLedgerEntry_tenantId_occurredAt_idx" ON "MenuLedgerEntry"("tenantId", "occurredAt");
CREATE INDEX "MenuLedgerEntry_tenantId_menuItemId_occurredAt_idx" ON "MenuLedgerEntry"("tenantId", "menuItemId", "occurredAt");
CREATE INDEX "MenuLedgerEntry_tenantId_locationId_occurredAt_idx" ON "MenuLedgerEntry"("tenantId", "locationId", "occurredAt");
CREATE INDEX "MenuLedgerEntry_orderId_idx" ON "MenuLedgerEntry"("orderId");

-- AddForeignKey
ALTER TABLE "MenuLedgerEntry" ADD CONSTRAINT "MenuLedgerEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from orders already served, so the ledger isn't empty on day one.
-- Approximate by nature (the original serve time and server aren't kept):
-- sale time = when the order was served (or the line added, if later), and the
-- original quantity is rebuilt as current quantity + approved returns.
-- Deterministic ids ('bf_...') make this safe to re-run.

-- Sales / complimentary
INSERT INTO "MenuLedgerEntry" ("id", "tenantId", "type", "menuItemId", "itemName", "variantName", "quantity", "unitPrice", "amount", "orderId", "orderNumber", "locationId", "performedBy", "occurredAt")
SELECT 'bf_s_' || i."id", o."tenantId",
       (CASE WHEN o."saleType"::text = 'COMPLIMENTARY' THEN 'COMPLIMENTARY' ELSE 'SALE' END)::"MenuLedgerType",
       i."menuItemId", m."name", v."name",
       i."quantity" + COALESCE(r.qty, 0),
       i."unitPrice" + COALESCE(a.addon_total, 0),
       (i."quantity" + COALESCE(r.qty, 0)) * (i."unitPrice" + COALESCE(a.addon_total, 0)),
       o."id", o."orderNumber", o."locationId", o."createdBy",
       GREATEST(o."servedAt", i."createdAt")
FROM "PosOrderItem" i
JOIN "PosOrder" o ON o."id" = i."orderId"
JOIN "MenuItem" m ON m."id" = i."menuItemId"
LEFT JOIN "MenuItemVariant" v ON v."id" = i."variantId"
LEFT JOIN LATERAL (SELECT SUM(x."unitPrice" * x."quantity") AS addon_total FROM "PosOrderItemAddon" x WHERE x."orderItemId" = i."id") a ON TRUE
LEFT JOIN LATERAL (SELECT SUM(q."quantity") AS qty FROM "PosOrderReturnRequest" q WHERE q."orderItemId" = i."id" AND q."status"::text = 'APPROVED') r ON TRUE
WHERE o."servedAt" IS NOT NULL AND i."menuItemId" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

-- Approved partial returns
INSERT INTO "MenuLedgerEntry" ("id", "tenantId", "type", "menuItemId", "itemName", "variantName", "quantity", "unitPrice", "amount", "orderId", "orderNumber", "locationId", "note", "performedBy", "occurredAt")
SELECT 'bf_r_' || q."id", q."tenantId", 'RETURN'::"MenuLedgerType",
       i."menuItemId", m."name", v."name",
       -q."quantity",
       i."unitPrice" + COALESCE(a.addon_total, 0),
       -q."quantity" * (i."unitPrice" + COALESCE(a.addon_total, 0)),
       o."id", o."orderNumber", o."locationId", q."reason", q."decidedBy",
       COALESCE(q."decidedAt", q."requestedAt")
FROM "PosOrderReturnRequest" q
JOIN "PosOrderItem" i ON i."id" = q."orderItemId"
JOIN "PosOrder" o ON o."id" = q."orderId"
JOIN "MenuItem" m ON m."id" = i."menuItemId"
LEFT JOIN "MenuItemVariant" v ON v."id" = i."variantId"
LEFT JOIN LATERAL (SELECT SUM(x."unitPrice" * x."quantity") AS addon_total FROM "PosOrderItemAddon" x WHERE x."orderItemId" = i."id") a ON TRUE
WHERE q."status"::text = 'APPROVED' AND i."menuItemId" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

-- Cancelled after being served (whole order returned)
INSERT INTO "MenuLedgerEntry" ("id", "tenantId", "type", "menuItemId", "itemName", "variantName", "quantity", "unitPrice", "amount", "orderId", "orderNumber", "locationId", "note", "performedBy", "occurredAt")
SELECT 'bf_c_' || i."id", o."tenantId", 'RETURN'::"MenuLedgerType",
       i."menuItemId", m."name", v."name",
       -i."quantity",
       i."unitPrice" + COALESCE(a.addon_total, 0),
       -i."quantity" * (i."unitPrice" + COALESCE(a.addon_total, 0)),
       o."id", o."orderNumber", o."locationId",
       COALESCE('Order cancelled: ' || o."cancelReason", 'Order cancelled'), o."cancelDecidedBy",
       COALESCE(o."cancelDecidedAt", o."updatedAt")
FROM "PosOrderItem" i
JOIN "PosOrder" o ON o."id" = i."orderId"
JOIN "MenuItem" m ON m."id" = i."menuItemId"
LEFT JOIN "MenuItemVariant" v ON v."id" = i."variantId"
LEFT JOIN LATERAL (SELECT SUM(x."unitPrice" * x."quantity") AS addon_total FROM "PosOrderItemAddon" x WHERE x."orderItemId" = i."id") a ON TRUE
WHERE o."status"::text = 'CANCELLED' AND o."servedAt" IS NOT NULL AND i."menuItemId" IS NOT NULL AND i."quantity" > 0
ON CONFLICT ("id") DO NOTHING;
