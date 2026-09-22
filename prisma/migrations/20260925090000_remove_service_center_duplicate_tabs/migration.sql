ALTER TABLE "Membership"
  ADD COLUMN "planName" TEXT,
  ADD COLUMN "planPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "durationDays" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0;

UPDATE "Membership" m
SET
  "planName" = p."name",
  "planPrice" = p."price",
  "durationDays" = p."durationDays",
  "discountPercent" = p."discountPercent"
FROM "MembershipPlan" p
WHERE m."planId" = p."id";

UPDATE "Membership"
SET "planName" = 'Membership'
WHERE "planName" IS NULL OR trim("planName") = '';

ALTER TABLE "Membership"
  ALTER COLUMN "planName" SET NOT NULL;

ALTER TABLE "Membership" DROP CONSTRAINT "Membership_planId_fkey";
DROP INDEX IF EXISTS "MembershipPlan_tenantId_name_key";
ALTER TABLE "Membership" DROP COLUMN "planId";
DROP TABLE "MembershipPlan";

DROP TABLE "ProviderSchedule";
