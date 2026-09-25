-- Track simple service-center customer groups. These are labels for filtering
-- memberships, appointments and payments; pricing logic still lives in
-- membership plans.
CREATE TABLE "ServiceCustomerGroup" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ServiceCustomerGroup_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Customer" ADD COLUMN "serviceGroupId" TEXT;

CREATE UNIQUE INDEX "ServiceCustomerGroup_tenantId_name_key" ON "ServiceCustomerGroup"("tenantId", "name");
CREATE INDEX "ServiceCustomerGroup_tenantId_isActive_idx" ON "ServiceCustomerGroup"("tenantId", "isActive");
CREATE INDEX "Customer_tenantId_serviceGroupId_idx" ON "Customer"("tenantId", "serviceGroupId");

ALTER TABLE "ServiceCustomerGroup"
  ADD CONSTRAINT "ServiceCustomerGroup_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_serviceGroupId_fkey"
  FOREIGN KEY ("serviceGroupId") REFERENCES "ServiceCustomerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
