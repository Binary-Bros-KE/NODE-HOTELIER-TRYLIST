-- A party booked together: one billing customer, many rooms (each still its own reservation).
CREATE TABLE "ReservationGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "groupNo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReservationGroup_tenantId_groupNo_key" ON "ReservationGroup"("tenantId", "groupNo");
CREATE INDEX "ReservationGroup_tenantId_createdAt_idx" ON "ReservationGroup"("tenantId", "createdAt");

ALTER TABLE "ReservationGroup" ADD CONSTRAINT "ReservationGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReservationGroup" ADD CONSTRAINT "ReservationGroup_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Reservation" ADD COLUMN "groupId" TEXT;
CREATE INDEX "Reservation_groupId_idx" ON "Reservation"("groupId");
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ReservationGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
