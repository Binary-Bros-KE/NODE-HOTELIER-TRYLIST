-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('STAFF', 'WEBSITE');

-- CreateEnum
CREATE TYPE "WebsiteStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "WebsiteBookingConfirmation" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "WebsiteDomainStatus" AS ENUM ('PENDING_DNS', 'VERIFYING', 'ACTIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "WebsitePageKind" AS ENUM ('HOME', 'STANDARD', 'SYSTEM');

-- CreateEnum
CREATE TYPE "WebsiteInquiryKind" AS ENUM ('GENERAL', 'EVENT', 'ROOM', 'SERVICE', 'MEMBERSHIP');

-- CreateEnum
CREATE TYPE "WebsiteInquiryStatus" AS ENUM ('NEW', 'CONTACTED', 'CLOSED', 'SPAM');

-- AlterEnum
ALTER TYPE "ModuleKey" ADD VALUE 'WEBSITE';

-- AlterEnum
ALTER TYPE "MpesaStkPurpose" ADD VALUE 'WEBSITE_BOOKING';

-- AlterTable
ALTER TABLE "RoomType" ADD COLUMN     "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "showOnWebsite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "websiteDescription" TEXT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "bookableOnline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "showOnWebsite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "websiteDescription" TEXT;

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "holdExpiresAt" TIMESTAMP(3),
ADD COLUMN     "manageToken" TEXT;

-- AlterTable
ALTER TABLE "MenuCategory" ADD COLUMN     "showOnWebsite" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "hideFromWebsite" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MembershipPlan" ADD COLUMN     "highlights" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "showOnWebsite" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "bookingRef" TEXT,
ADD COLUMN     "holdExpiresAt" TIMESTAMP(3),
ADD COLUMN     "manageToken" TEXT,
ADD COLUMN     "source" "AppointmentSource" NOT NULL DEFAULT 'STAFF';

-- CreateTable
CREATE TABLE "WebsiteTheme" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "previewImageUrl" TEXT,
    "sectionTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteTheme_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "TenantWebsite" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "themeKey" TEXT NOT NULL,
    "status" "WebsiteStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "primaryColor" TEXT,
    "accentColor" TEXT,
    "fontFamily" TEXT,
    "logoUrl" TEXT,
    "faviconUrl" TEXT,
    "siteTitle" TEXT,
    "tagline" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "ogImageUrl" TEXT,
    "analyticsId" TEXT,
    "whatsappNumber" TEXT,
    "mapEmbedUrl" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "socialLinks" JSONB NOT NULL DEFAULT '{}',
    "featureRoomBooking" BOOLEAN NOT NULL DEFAULT false,
    "featureMenu" BOOLEAN NOT NULL DEFAULT false,
    "featureAppointments" BOOLEAN NOT NULL DEFAULT false,
    "featureMemberships" BOOLEAN NOT NULL DEFAULT false,
    "featureInquiries" BOOLEAN NOT NULL DEFAULT true,
    "bookingConfirmation" "WebsiteBookingConfirmation" NOT NULL DEFAULT 'MANUAL',
    "requirePayment" BOOLEAN NOT NULL DEFAULT false,
    "depositPercent" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "holdMinutes" INTEGER NOT NULL DEFAULT 30,
    "bookingLocationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantWebsite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantDomain" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "status" "WebsiteDomainStatus" NOT NULL DEFAULT 'PENDING_DNS',
    "verificationToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsitePage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "WebsitePageKind" NOT NULL DEFAULT 'STANDARD',
    "sections" JSONB NOT NULL DEFAULT '[]',
    "draftSections" JSONB,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "ogImageUrl" TEXT,
    "showInNav" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsitePage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsiteMedia" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "altText" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebsiteMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsiteInquiry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "WebsiteInquiryKind" NOT NULL DEFAULT 'GENERAL',
    "status" "WebsiteInquiryStatus" NOT NULL DEFAULT 'NEW',
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "subject" TEXT,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "sourcePage" TEXT,
    "customerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantWebsite_tenantId_key" ON "TenantWebsite"("tenantId");

-- CreateIndex
CREATE INDEX "TenantWebsite_themeKey_idx" ON "TenantWebsite"("themeKey");

-- CreateIndex
CREATE UNIQUE INDEX "TenantDomain_hostname_key" ON "TenantDomain"("hostname");

-- CreateIndex
CREATE INDEX "TenantDomain_tenantId_idx" ON "TenantDomain"("tenantId");

-- CreateIndex
CREATE INDEX "WebsitePage_tenantId_isPublished_sortOrder_idx" ON "WebsitePage"("tenantId", "isPublished", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "WebsitePage_tenantId_slug_key" ON "WebsitePage"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "WebsiteMedia_tenantId_createdAt_idx" ON "WebsiteMedia"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "WebsiteInquiry_tenantId_status_createdAt_idx" ON "WebsiteInquiry"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_manageToken_key" ON "Reservation"("manageToken");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_manageToken_key" ON "Appointment"("manageToken");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_tenantId_bookingRef_key" ON "Appointment"("tenantId", "bookingRef");

-- AddForeignKey
ALTER TABLE "TenantWebsite" ADD CONSTRAINT "TenantWebsite_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantWebsite" ADD CONSTRAINT "TenantWebsite_themeKey_fkey" FOREIGN KEY ("themeKey") REFERENCES "WebsiteTheme"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantWebsite" ADD CONSTRAINT "TenantWebsite_bookingLocationId_fkey" FOREIGN KEY ("bookingLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantDomain" ADD CONSTRAINT "TenantDomain_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsitePage" ADD CONSTRAINT "WebsitePage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteMedia" ADD CONSTRAINT "WebsiteMedia_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteInquiry" ADD CONSTRAINT "WebsiteInquiry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteInquiry" ADD CONSTRAINT "WebsiteInquiry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

