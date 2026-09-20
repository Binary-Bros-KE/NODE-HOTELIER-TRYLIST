-- Room terms: complimentary rooms and per-room discounts.
CREATE TYPE "RoomSaleType" AS ENUM ('PAID', 'COMPLIMENTARY');
CREATE TYPE "RoomDiscountType" AS ENUM ('PERCENT', 'AMOUNT');

ALTER TABLE "Reservation"
  ADD COLUMN "roomSaleType" "RoomSaleType" NOT NULL DEFAULT 'PAID',
  ADD COLUMN "complimentaryReason" TEXT,
  ADD COLUMN "discountType" "RoomDiscountType",
  ADD COLUMN "discountValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "discountReason" TEXT;

-- A negative folio line for a discount / complimentary write-off.
ALTER TYPE "FolioLineSource" ADD VALUE 'DISCOUNT';

-- Checking out with a balance left: what, why, when expected.
ALTER TABLE "Folio"
  ADD COLUMN "creditAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "creditReason" TEXT,
  ADD COLUMN "creditExpectedAt" TIMESTAMP(3);

-- Credit that came from a stay rather than a POS order.
ALTER TABLE "CustomerCreditEntry" ADD COLUMN "folioId" TEXT;
CREATE INDEX "CustomerCreditEntry_folioId_idx" ON "CustomerCreditEntry"("folioId");
