-- AlterTable
ALTER TABLE "PosOrderItem" ADD COLUMN     "unitCost" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "cost" DECIMAL(12,2),
ADD COLUMN     "taxMode" "TaxMode",
ADD COLUMN     "taxRate" DECIMAL(5,2),
ADD COLUMN     "taxTreatment" "TaxTreatment";

