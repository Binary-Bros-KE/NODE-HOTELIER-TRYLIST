-- AlterEnum
ALTER TYPE "PrintJobKind" ADD VALUE 'ORDER_TICKET';

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "orderTicketAutoPrint" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PrintJob" ADD COLUMN     "ticket" JSONB;
