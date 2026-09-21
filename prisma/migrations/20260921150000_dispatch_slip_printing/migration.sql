-- CreateEnum
CREATE TYPE "PrintJobKind" AS ENUM ('RECEIPT', 'DISPATCH');

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "dispatchAutoPrint" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "PrintJob" ADD COLUMN     "dispatchRequestId" TEXT,
ADD COLUMN     "kind" "PrintJobKind" NOT NULL DEFAULT 'RECEIPT';

