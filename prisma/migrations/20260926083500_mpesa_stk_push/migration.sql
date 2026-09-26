-- M-Pesa Daraja STK push: per-location config + the STK request audit trail. Additive only.

CREATE TYPE "MpesaAccountType" AS ENUM ('PAYBILL', 'TILL');
CREATE TYPE "MpesaEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');
CREATE TYPE "MpesaStkPurpose" AS ENUM ('POS_ORDER', 'FOLIO_DEPOSIT', 'FOLIO_SETTLEMENT', 'GROUP_CHECKOUT', 'MEMBERSHIP_PAYMENT');
CREATE TYPE "MpesaStkStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT');

CREATE TABLE "LocationMpesaConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "accountType" "MpesaAccountType" NOT NULL,
    "shortcode" TEXT NOT NULL,
    "tillNumber" TEXT,
    "passkeyEncrypted" TEXT NOT NULL,
    "consumerKeyEncrypted" TEXT NOT NULL,
    "consumerSecretEncrypted" TEXT NOT NULL,
    "environment" "MpesaEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    CONSTRAINT "LocationMpesaConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LocationMpesaConfig_locationId_key" ON "LocationMpesaConfig"("locationId");
CREATE INDEX "LocationMpesaConfig_tenantId_idx" ON "LocationMpesaConfig"("tenantId");
ALTER TABLE "LocationMpesaConfig" ADD CONSTRAINT "LocationMpesaConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LocationMpesaConfig" ADD CONSTRAINT "LocationMpesaConfig_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LocationMpesaConfig" ADD CONSTRAINT "LocationMpesaConfig_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LocationMpesaConfig" ADD CONSTRAINT "LocationMpesaConfig_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MpesaStkRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "purpose" "MpesaStkPurpose" NOT NULL,
    "purposeRefId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "merchantRequestId" TEXT,
    "checkoutRequestId" TEXT,
    "status" "MpesaStkStatus" NOT NULL DEFAULT 'PENDING',
    "resultCode" INTEGER,
    "resultDesc" TEXT,
    "mpesaReceiptNumber" TEXT,
    "initiatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MpesaStkRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MpesaStkRequest_checkoutRequestId_key" ON "MpesaStkRequest"("checkoutRequestId");
CREATE INDEX "MpesaStkRequest_tenantId_purpose_purposeRefId_idx" ON "MpesaStkRequest"("tenantId", "purpose", "purposeRefId");
CREATE INDEX "MpesaStkRequest_tenantId_status_idx" ON "MpesaStkRequest"("tenantId", "status");
ALTER TABLE "MpesaStkRequest" ADD CONSTRAINT "MpesaStkRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MpesaStkRequest" ADD CONSTRAINT "MpesaStkRequest_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MpesaStkRequest" ADD CONSTRAINT "MpesaStkRequest_initiatedBy_fkey" FOREIGN KEY ("initiatedBy") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
