ALTER TABLE "BusinessProfile"
ADD COLUMN "documentLogoUrl" TEXT,
ADD COLUMN "documentBrandingMode" TEXT NOT NULL DEFAULT 'NAME';
