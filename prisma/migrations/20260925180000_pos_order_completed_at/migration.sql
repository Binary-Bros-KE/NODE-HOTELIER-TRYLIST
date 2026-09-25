-- Sales reports were placing completed orders in a business day by updatedAt, which changes when a
-- debt on the order is paid later, so yesterday's total shrank and today's grew. Give the order a
-- fixed completion time instead.
ALTER TABLE "PosOrder" ADD COLUMN "completedAt" TIMESTAMP(3);

-- Backfill: an order completed on credit was completed when the credit was given (first CREDIT entry);
-- otherwise when it was fully paid (last payment), or billed to a room, or served, or created.
UPDATE "PosOrder" o SET "completedAt" = COALESCE(
  (SELECT MIN(c."createdAt") FROM "CustomerCreditEntry" c WHERE c."orderId" = o."id" AND c."type" = 'CREDIT'),
  (SELECT MAX(p."createdAt") FROM "Payment" p WHERE p."orderId" = o."id"),
  o."billedToRoomAt", o."servedAt", o."createdAt"
)
WHERE o."status" = 'COMPLETED';

CREATE INDEX "PosOrder_tenantId_status_completedAt_idx" ON "PosOrder"("tenantId", "status", "completedAt");
