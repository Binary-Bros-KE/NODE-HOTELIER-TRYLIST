-- Assets take their unit from the tenant's Units of Measure instead of a fixed text list.
ALTER TABLE "Asset" ADD COLUMN "unitId" TEXT;

-- Carry any existing free-text units over: create a unit for each name the tenant does not have yet.
INSERT INTO "UnitOfMeasure" ("id", "tenantId", "name", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, a."tenantId", a."unit", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT ON ("tenantId", lower("unit")) "tenantId", "unit" FROM "Asset") a
WHERE NOT EXISTS (SELECT 1 FROM "UnitOfMeasure" u WHERE u."tenantId" = a."tenantId" AND lower(u."name") = lower(a."unit"));

UPDATE "Asset" SET "unitId" = u."id"
FROM "UnitOfMeasure" u
WHERE u."tenantId" = "Asset"."tenantId" AND lower(u."name") = lower("Asset"."unit");

ALTER TABLE "Asset" ALTER COLUMN "unitId" SET NOT NULL;
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "UnitOfMeasure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Asset" DROP COLUMN "unit";
