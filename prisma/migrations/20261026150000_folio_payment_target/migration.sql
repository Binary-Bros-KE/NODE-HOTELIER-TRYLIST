-- A folio payment can say what it pays for: one charged bill (a folio line) or the
-- room & stay charges. Neither set = the whole folio, oldest charges first (as before).
ALTER TABLE "FolioPayment" ADD COLUMN "appliesToLineId" TEXT;
ALTER TABLE "FolioPayment" ADD COLUMN "appliesToRoom" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FolioPayment" ADD CONSTRAINT "FolioPayment_appliesToLineId_fkey" FOREIGN KEY ("appliesToLineId") REFERENCES "FolioLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
