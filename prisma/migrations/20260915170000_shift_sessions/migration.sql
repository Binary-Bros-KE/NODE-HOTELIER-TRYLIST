-- CreateEnum
CREATE TYPE "ShiftSessionStatus" AS ENUM ('REQUESTED_START', 'ACTIVE', 'REQUESTED_END', 'ENDED', 'REJECTED_START', 'REJECTED_END');

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN "isSupervisor" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ShiftSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" "ShiftSessionStatus" NOT NULL DEFAULT 'REQUESTED_START',
    "requestedStartAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedStartAt" TIMESTAMP(3),
    "startApprovedBy" TEXT,
    "requestedEndAt" TIMESTAMP(3),
    "approvedEndAt" TIMESTAMP(3),
    "endApprovedBy" TEXT,
    "startNote" TEXT,
    "endNote" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftSession_tenantId_employeeId_status_idx" ON "ShiftSession"("tenantId", "employeeId", "status");

-- CreateIndex
CREATE INDEX "ShiftSession_tenantId_status_requestedStartAt_idx" ON "ShiftSession"("tenantId", "status", "requestedStartAt");

-- CreateIndex
CREATE INDEX "ShiftSession_tenantId_approvedStartAt_idx" ON "ShiftSession"("tenantId", "approvedStartAt");

-- AddForeignKey
ALTER TABLE "ShiftSession" ADD CONSTRAINT "ShiftSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSession" ADD CONSTRAINT "ShiftSession_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSession" ADD CONSTRAINT "ShiftSession_startApprovedBy_fkey" FOREIGN KEY ("startApprovedBy") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSession" ADD CONSTRAINT "ShiftSession_endApprovedBy_fkey" FOREIGN KEY ("endApprovedBy") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
