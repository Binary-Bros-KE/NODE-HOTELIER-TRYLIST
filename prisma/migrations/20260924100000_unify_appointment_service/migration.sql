-- Unifies the appointments booking catalog (ServiceCenterService) onto the
-- same Service catalog the till sells from, so a completed appointment gets
-- real tax, stock consumption, receipts and reports. Existing rows are moved
-- across keeping their original id, so Appointment.serviceId keeps working
-- right up until its foreign key is repointed below - no Appointment row
-- needs its own data touched.

-- 1. Drop the old FK so the id can be reused as a Service id.
ALTER TABLE "Appointment" DROP CONSTRAINT "Appointment_serviceId_fkey";

-- 2. Every tenant that has at least one ServiceCenterService row gets a
--    "Appointments" category and a "Session" unit to file them under (created
--    only if missing; an existing category/unit with that exact name is
--    reused rather than duplicated).
INSERT INTO "ServiceCategory" ("id", "tenantId", "name", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."tenantId", 'Appointments', true, now(), now()
FROM (SELECT DISTINCT "tenantId" FROM "ServiceCenterService") t
WHERE NOT EXISTS (
  SELECT 1 FROM "ServiceCategory" c WHERE c."tenantId" = t."tenantId" AND c."name" = 'Appointments'
);

INSERT INTO "UnitOfMeasure" ("id", "tenantId", "name", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."tenantId", 'Session', now(), now()
FROM (SELECT DISTINCT "tenantId" FROM "ServiceCenterService") t
WHERE NOT EXISTS (
  SELECT 1 FROM "UnitOfMeasure" u WHERE u."tenantId" = t."tenantId" AND u."name" = 'Session'
);

-- 3. Copy each ServiceCenterService row into Service, keeping its id (so the
--    Appointment rows that reference it need no change at all). A name that
--    already exists as a Service in the same tenant (Service has a unique
--    (tenantId, name) constraint ServiceCenterService never had) is suffixed
--    to avoid a collision, rather than silently dropping the row.
INSERT INTO "Service" ("id", "tenantId", "name", "categoryId", "unitId", "price", "durationMinutes", "description", "isActive", "createdAt", "updatedAt")
SELECT
  scs."id",
  scs."tenantId",
  CASE WHEN EXISTS (SELECT 1 FROM "Service" s WHERE s."tenantId" = scs."tenantId" AND s."name" = scs."name")
    THEN scs."name" || ' (Appointments)'
    ELSE scs."name"
  END,
  (SELECT c."id" FROM "ServiceCategory" c WHERE c."tenantId" = scs."tenantId" AND c."name" = 'Appointments' LIMIT 1),
  (SELECT u."id" FROM "UnitOfMeasure" u WHERE u."tenantId" = scs."tenantId" AND u."name" = 'Session' LIMIT 1),
  scs."price",
  scs."durationMinutes",
  scs."description",
  scs."isActive",
  scs."createdAt",
  scs."updatedAt"
FROM "ServiceCenterService" scs;

-- 4. The old table and its own FK can now go.
ALTER TABLE "ServiceCenterService" DROP CONSTRAINT "ServiceCenterService_tenantId_fkey";
DROP TABLE "ServiceCenterService";

-- 5. New Appointment columns: the chosen option, which location, and the
--    real sale once completed.
ALTER TABLE "Appointment" ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "serviceVariantId" TEXT;

CREATE UNIQUE INDEX "Appointment_orderId_key" ON "Appointment"("orderId");
CREATE INDEX "Appointment_tenantId_serviceId_idx" ON "Appointment"("tenantId", "serviceId");

ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_serviceVariantId_fkey" FOREIGN KEY ("serviceVariantId") REFERENCES "ServiceVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PosOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
