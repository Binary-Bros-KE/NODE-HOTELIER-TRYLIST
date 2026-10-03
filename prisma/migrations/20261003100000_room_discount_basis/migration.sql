-- A fixed-amount room discount can come off the whole stay (TOTAL) or once
-- per unit, e.g. per person in a boardroom (PER_UNIT).
CREATE TYPE "RoomDiscountBasis" AS ENUM ('TOTAL', 'PER_UNIT');
ALTER TABLE "Reservation" ADD COLUMN "discountBasis" "RoomDiscountBasis" NOT NULL DEFAULT 'TOTAL';
