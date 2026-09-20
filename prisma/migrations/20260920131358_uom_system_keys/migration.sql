-- AlterTable
ALTER TABLE "UnitOfMeasure" ADD COLUMN "systemKey" TEXT;

-- Adopt each tenant's existing Hour / Night / Day unit (matched case-insensitively) as the built-in one.
UPDATE "UnitOfMeasure" SET "systemKey" = 'HOUR' WHERE "id" IN (SELECT DISTINCT ON ("tenantId") "id" FROM "UnitOfMeasure" WHERE lower("name") = 'hour' ORDER BY "tenantId", "name" DESC);
UPDATE "UnitOfMeasure" SET "systemKey" = 'NIGHT' WHERE "id" IN (SELECT DISTINCT ON ("tenantId") "id" FROM "UnitOfMeasure" WHERE lower("name") = 'night' ORDER BY "tenantId", "name" DESC);
UPDATE "UnitOfMeasure" SET "systemKey" = 'DAY' WHERE "id" IN (SELECT DISTINCT ON ("tenantId") "id" FROM "UnitOfMeasure" WHERE lower("name") = 'day' ORDER BY "tenantId", "name" DESC);

-- Create whichever built-ins a tenant is still missing.
INSERT INTO "UnitOfMeasure" ("id", "tenantId", "name", "systemKey", "createdAt", "updatedAt")
SELECT 'uom_' || lower(k."key") || '_' || t."id", t."id", k."label", k."key", NOW(), NOW()
FROM "Tenant" t
CROSS JOIN (VALUES ('HOUR', 'Hour'), ('NIGHT', 'Night'), ('DAY', 'Day')) AS k("key", "label")
WHERE NOT EXISTS (SELECT 1 FROM "UnitOfMeasure" u WHERE u."tenantId" = t."id" AND u."systemKey" = k."key");

-- CreateIndex
CREATE UNIQUE INDEX "UnitOfMeasure_tenantId_systemKey_key" ON "UnitOfMeasure"("tenantId", "systemKey");
