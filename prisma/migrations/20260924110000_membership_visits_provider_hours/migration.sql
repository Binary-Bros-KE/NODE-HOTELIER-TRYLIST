-- Membership visit tracking, product discount flag, provider working hours. Additive only.
ALTER TABLE "MembershipPlan" ADD COLUMN "visitLimit" INTEGER, ADD COLUMN "discountOnProducts" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Membership" ADD COLUMN "visitLimit" INTEGER, ADD COLUMN "discountOnProducts" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ServiceProvider" ADD COLUMN "workDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[], ADD COLUMN "workStartMinute" INTEGER, ADD COLUMN "workEndMinute" INTEGER;

CREATE TABLE "MembershipVisit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "visitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "recordedBy" TEXT,
    CONSTRAINT "MembershipVisit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MembershipVisit_tenantId_membershipId_visitedAt_idx" ON "MembershipVisit"("tenantId", "membershipId", "visitedAt");
ALTER TABLE "MembershipVisit" ADD CONSTRAINT "MembershipVisit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MembershipVisit" ADD CONSTRAINT "MembershipVisit_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
