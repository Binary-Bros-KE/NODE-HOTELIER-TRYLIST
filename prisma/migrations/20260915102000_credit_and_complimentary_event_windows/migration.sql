ALTER TABLE "PosOrder" ADD COLUMN "complimentaryRecipientName" TEXT;
ALTER TABLE "PosOrder" ADD COLUMN "creditReason" TEXT;
ALTER TABLE "PosOrder" ADD COLUMN "creditExpectedAt" TIMESTAMP(3);

ALTER TABLE "ComplimentarySession" ADD COLUMN "startsAt" TIMESTAMP(3);
ALTER TABLE "ComplimentarySession" ADD COLUMN "endsAt" TIMESTAMP(3);

UPDATE "ComplimentarySession"
SET "startsAt" = "eventDate"
WHERE "startsAt" IS NULL;

CREATE INDEX "PosOrder_tenantId_creditExpectedAt_idx" ON "PosOrder"("tenantId", "creditExpectedAt");
CREATE INDEX "ComplimentarySession_tenantId_startsAt_endsAt_idx" ON "ComplimentarySession"("tenantId", "startsAt", "endsAt");
