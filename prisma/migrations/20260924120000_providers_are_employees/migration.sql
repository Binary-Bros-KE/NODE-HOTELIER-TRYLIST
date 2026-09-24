-- A service provider is just an employee at a service-selling location, not a separate record.
-- Existing appointments are re-pointed at the employee whose full name matches the old
-- provider; any that can't be matched keep no provider (column becomes nullable).
ALTER TABLE "Appointment" DROP CONSTRAINT "Appointment_providerId_fkey";
ALTER TABLE "Appointment" ALTER COLUMN "providerId" DROP NOT NULL;

UPDATE "Appointment" a
SET "providerId" = e."id"
FROM "ServiceProvider" p
JOIN "Employee" e ON e."tenantId" = p."tenantId" AND lower(trim(e."firstName" || ' ' || e."lastName")) = lower(trim(p."name"))
WHERE a."providerId" = p."id";

UPDATE "Appointment" SET "providerId" = NULL WHERE "providerId" IS NOT NULL AND "providerId" NOT IN (SELECT "id" FROM "Employee");

ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TABLE "ServiceProvider";
