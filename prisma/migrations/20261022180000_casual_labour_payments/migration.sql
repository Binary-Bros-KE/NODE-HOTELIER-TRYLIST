
-- CreateTable
CREATE TABLE "CasualLabourPayment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "paymentNo" TEXT NOT NULL,
    "workerName" TEXT NOT NULL,
    "workerPhone" TEXT,
    "workerIdNo" TEXT,
    "job" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "locationId" TEXT,
    "quantity" DECIMAL(12,3),
    "unitLabel" TEXT,
    "rate" DECIMAL(12,2),
    "amount" DECIMAL(12,2) NOT NULL,
    "paymentMethod" "EmployeePaymentMethod" NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "status" "EmployeeSalaryStatus" NOT NULL DEFAULT 'COMPLETE',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "voidedBy" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CasualLabourPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CasualLabourPayment_tenantId_workDate_idx" ON "CasualLabourPayment"("tenantId", "workDate");

-- CreateIndex
CREATE INDEX "CasualLabourPayment_tenantId_workerName_idx" ON "CasualLabourPayment"("tenantId", "workerName");

-- CreateIndex
CREATE UNIQUE INDEX "CasualLabourPayment_tenantId_paymentNo_key" ON "CasualLabourPayment"("tenantId", "paymentNo");

-- AddForeignKey
ALTER TABLE "CasualLabourPayment" ADD CONSTRAINT "CasualLabourPayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CasualLabourPayment" ADD CONSTRAINT "CasualLabourPayment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
