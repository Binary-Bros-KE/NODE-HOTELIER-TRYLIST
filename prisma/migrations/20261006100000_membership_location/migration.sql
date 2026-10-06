-- A membership is tied to the location it was registered at.
ALTER TABLE "Membership" ADD COLUMN "locationId" TEXT;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Membership_tenantId_locationId_idx" ON "Membership"("tenantId", "locationId");

-- Existing memberships take the location of their first payment that has one.
UPDATE "Membership" m
SET "locationId" = (
  SELECT mp."locationId" FROM "MembershipPayment" mp
  WHERE mp."membershipId" = m.id AND mp."locationId" IS NOT NULL
  ORDER BY mp."createdAt" ASC
  LIMIT 1
)
WHERE m."locationId" IS NULL;
