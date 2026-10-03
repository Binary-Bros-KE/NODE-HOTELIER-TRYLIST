-- The location's default printer. Store dispatch slips are sent to it.
ALTER TABLE "Printer" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;
