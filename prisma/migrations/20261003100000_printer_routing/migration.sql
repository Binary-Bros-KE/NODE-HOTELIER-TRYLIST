-- Print jobs go to a named printer, and only the computer hosting that printer
-- prints them. Jobs queued before this existed were location-wide and would be
-- claimed by whichever computer at the location polled first, so they're failed
-- here and the order is sent again.
CREATE TABLE "Printer" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Printer_tenantId_name_key" ON "Printer"("tenantId", "name");
CREATE INDEX "Printer_tenantId_locationId_idx" ON "Printer"("tenantId", "locationId");

ALTER TABLE "Printer" ADD CONSTRAINT "Printer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Printer" ADD CONSTRAINT "Printer_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PrintJob" ADD COLUMN "printerId" TEXT;
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "PrintJob_tenantId_printerId_status_idx" ON "PrintJob"("tenantId", "printerId", "status");

UPDATE "PrintJob"
SET status = 'FAILED', error = 'Printer routing was updated - send this order to print again'
WHERE status IN ('PENDING', 'CLAIMED') AND "printerId" IS NULL;
