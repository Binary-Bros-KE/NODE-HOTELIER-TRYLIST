-- Membership plan catalog + ledger source for membership payments. Additive only.
ALTER TYPE "TransactionSource" ADD VALUE IF NOT EXISTS 'MEMBERSHIP_PAYMENT';

CREATE TABLE "MembershipPlan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "durationDays" INTEGER NOT NULL DEFAULT 30,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MembershipPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MembershipPlan_tenantId_name_key" ON "MembershipPlan"("tenantId", "name");
CREATE INDEX "MembershipPlan_tenantId_isActive_idx" ON "MembershipPlan"("tenantId", "isActive");
ALTER TABLE "MembershipPlan" ADD CONSTRAINT "MembershipPlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Membership" ADD COLUMN "planId" TEXT;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MembershipPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
