-- Invoices and quotations are cancelled, never deleted: keep who cancelled, when and why.
ALTER TABLE "CommercialDocument" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "CommercialDocument" ADD COLUMN "cancelledBy" TEXT;
ALTER TABLE "CommercialDocument" ADD COLUMN "cancelledByName" TEXT;
ALTER TABLE "CommercialDocument" ADD COLUMN "cancelReason" TEXT;
