-- AlterTable
ALTER TABLE "PosOrderItem" ADD COLUMN     "extendsItemId" TEXT;

-- AddForeignKey
ALTER TABLE "PosOrderItem" ADD CONSTRAINT "PosOrderItem_extendsItemId_fkey" FOREIGN KEY ("extendsItemId") REFERENCES "PosOrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

