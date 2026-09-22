CREATE TYPE "CommercialDocumentType" AS ENUM ('QUOTATION', 'INVOICE');
CREATE TYPE "CommercialDocumentStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'CONVERTED', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID');
CREATE TYPE "CommercialDocumentSource" AS ENUM ('MANUAL', 'QUOTATION', 'HOTEL_STAY', 'SERVICE_SALE', 'RESTAURANT_ORDER');
CREATE TYPE "CommercialDocumentLineSource" AS ENUM ('CUSTOM', 'ROOM', 'ROOM_STAY', 'FOLIO', 'SERVICE', 'SERVICE_MEMBERSHIP', 'POS_ORDER');
CREATE TYPE "CommercialDocumentPaymentKind" AS ENUM ('DEPOSIT', 'PAYMENT');

ALTER TYPE "TransactionSource" ADD VALUE 'COMMERCIAL_DOCUMENT_PAYMENT';

CREATE TABLE "CommercialDocument" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "documentNo" TEXT NOT NULL,
  "type" "CommercialDocumentType" NOT NULL,
  "status" "CommercialDocumentStatus" NOT NULL DEFAULT 'DRAFT',
  "source" "CommercialDocumentSource" NOT NULL DEFAULT 'MANUAL',
  "sourceRefId" TEXT,
  "sourceDocumentId" TEXT,
  "customerId" TEXT,
  "prospectName" TEXT,
  "prospectPhone" TEXT,
  "prospectEmail" TEXT,
  "prospectAddress" TEXT,
  "locationId" TEXT,
  "title" TEXT,
  "intro" TEXT,
  "headerText" TEXT,
  "footerText" TEXT,
  "issuedAt" TIMESTAMP(3),
  "acceptedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "dueAt" TIMESTAMP(3),
  "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "net" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "depositRequired" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommercialDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommercialDocumentLine" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "source" "CommercialDocumentLineSource" NOT NULL DEFAULT 'CUSTOM',
  "sourceRefId" TEXT,
  "description" TEXT NOT NULL,
  "details" TEXT,
  "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
  "unitLabel" TEXT,
  "unitPrice" DECIMAL(12,2) NOT NULL,
  "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 16,
  "taxMode" "TaxMode" NOT NULL DEFAULT 'INCLUSIVE',
  "taxTreatment" "TaxTreatment" NOT NULL DEFAULT 'STANDARD',
  "lineSubtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "netAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "lineTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialDocumentLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommercialDocumentPayment" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "paymentNo" TEXT NOT NULL,
  "kind" "CommercialDocumentPaymentKind" NOT NULL DEFAULT 'PAYMENT',
  "paymentMethodId" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "reference" TEXT,
  "note" TEXT,
  "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transactionId" TEXT,
  CONSTRAINT "CommercialDocumentPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommercialDocument_tenantId_documentNo_key" ON "CommercialDocument"("tenantId", "documentNo");
CREATE INDEX "CommercialDocument_tenantId_type_status_idx" ON "CommercialDocument"("tenantId", "type", "status");
CREATE INDEX "CommercialDocument_tenantId_customerId_idx" ON "CommercialDocument"("tenantId", "customerId");
CREATE INDEX "CommercialDocument_tenantId_locationId_idx" ON "CommercialDocument"("tenantId", "locationId");
CREATE INDEX "CommercialDocument_tenantId_dueAt_idx" ON "CommercialDocument"("tenantId", "dueAt");

CREATE INDEX "CommercialDocumentLine_tenantId_documentId_idx" ON "CommercialDocumentLine"("tenantId", "documentId");

CREATE UNIQUE INDEX "CommercialDocumentPayment_tenantId_paymentNo_key" ON "CommercialDocumentPayment"("tenantId", "paymentNo");
CREATE INDEX "CommercialDocumentPayment_tenantId_documentId_idx" ON "CommercialDocumentPayment"("tenantId", "documentId");
CREATE INDEX "CommercialDocumentPayment_tenantId_paymentMethodId_idx" ON "CommercialDocumentPayment"("tenantId", "paymentMethodId");

ALTER TABLE "CommercialDocument" ADD CONSTRAINT "CommercialDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialDocument" ADD CONSTRAINT "CommercialDocument_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialDocument" ADD CONSTRAINT "CommercialDocument_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommercialDocument" ADD CONSTRAINT "CommercialDocument_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "CommercialDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommercialDocumentLine" ADD CONSTRAINT "CommercialDocumentLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialDocumentLine" ADD CONSTRAINT "CommercialDocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "CommercialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommercialDocumentPayment" ADD CONSTRAINT "CommercialDocumentPayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialDocumentPayment" ADD CONSTRAINT "CommercialDocumentPayment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "CommercialDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialDocumentPayment" ADD CONSTRAINT "CommercialDocumentPayment_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialDocumentPayment" ADD CONSTRAINT "CommercialDocumentPayment_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
