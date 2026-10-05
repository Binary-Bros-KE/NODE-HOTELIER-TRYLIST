-- AlterTable
ALTER TABLE "Product" ADD COLUMN "tags" "LocationType"[] DEFAULT ARRAY[]::"LocationType"[];
