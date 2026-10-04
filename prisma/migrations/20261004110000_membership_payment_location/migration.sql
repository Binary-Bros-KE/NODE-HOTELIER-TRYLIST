-- Membership payments are tied to the location that took the payment.
ALTER TABLE "MembershipPayment" ADD COLUMN "locationId" TEXT;

ALTER TABLE "MembershipPayment" ADD CONSTRAINT "MembershipPayment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "MembershipPayment_tenantId_locationId_createdAt_idx" ON "MembershipPayment"("tenantId", "locationId", "createdAt");
