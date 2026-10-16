-- AlterTable
ALTER TABLE "TenantWebsite" ADD COLUMN     "redirects" JSONB NOT NULL DEFAULT '[]';

-- Aurora gains the "pathways" section (Stay / Celebrate / Meet / Dine cards).
UPDATE "WebsiteTheme"
SET "sectionTypes" = array_append("sectionTypes", 'pathways'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'aurora' AND NOT ('pathways' = ANY("sectionTypes"));
