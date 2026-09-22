-- Room/stay billing has never carried tax. Adds the same nullable
-- override/snapshot fields MenuItem, Service and Product already use
-- (null = inherit the tenant's BusinessProfile default). Purely additive,
-- safe for existing production data.

-- AlterTable
ALTER TABLE "RoomType" ADD COLUMN "taxRate" DECIMAL(5,2),
ADD COLUMN "taxMode" "TaxMode",
ADD COLUMN "taxTreatment" "TaxTreatment";

-- AlterTable
ALTER TABLE "FolioLineItem" ADD COLUMN "taxRate" DECIMAL(5,2),
ADD COLUMN "taxMode" "TaxMode",
ADD COLUMN "taxTreatment" "TaxTreatment";
