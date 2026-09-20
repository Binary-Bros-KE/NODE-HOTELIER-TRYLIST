-- Timeline entries for the two new things that can happen to a stay.
ALTER TYPE "ReservationActivityAction" ADD VALUE 'ROOM_TERMS_CHANGED';
ALTER TYPE "ReservationActivityAction" ADD VALUE 'CREDIT_PAYMENT';
