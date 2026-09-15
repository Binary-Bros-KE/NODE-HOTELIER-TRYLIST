-- CreateEnum
CREATE TYPE "EmployeeSalaryStatus" AS ENUM ('DRAFT', 'COMPLETE', 'VOIDED');

-- CreateEnum
CREATE TYPE "EmployeeSalaryItemType" AS ENUM ('ALLOWANCE', 'DEDUCTION');

-- AlterEnum
ALTER TYPE "TransactionSource" ADD VALUE 'SALARY_PAYMENT';

-- CreateTable
CREATE TABLE "EmployeeSalary" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payslipNo" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "payPeriod" DATE NOT NULL,
    "basicSalary" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "grossPay" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalAllowances" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netPay" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paymentMethod" "EmployeePaymentMethod",
    "reference" TEXT,
    "notes" TEXT,
    "status" "EmployeeSalaryStatus" NOT NULL DEFAULT 'DRAFT',
    "paidAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "voidedBy" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeSalary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeSalaryItem" (
    "id" TEXT NOT NULL,
    "salaryId" TEXT NOT NULL,
    "type" "EmployeeSalaryItemType" NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeSalaryItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeSalary_tenantId_payslipNo_key" ON "EmployeeSalary"("tenantId", "payslipNo");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeSalary_tenantId_employeeId_payPeriod_key" ON "EmployeeSalary"("tenantId", "employeeId", "payPeriod");

-- CreateIndex
CREATE INDEX "EmployeeSalary_tenantId_payPeriod_idx" ON "EmployeeSalary"("tenantId", "payPeriod");

-- CreateIndex
CREATE INDEX "EmployeeSalary_tenantId_status_idx" ON "EmployeeSalary"("tenantId", "status");

-- CreateIndex
CREATE INDEX "EmployeeSalaryItem_salaryId_idx" ON "EmployeeSalaryItem"("salaryId");

-- AddForeignKey
ALTER TABLE "EmployeeSalary" ADD CONSTRAINT "EmployeeSalary_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSalary" ADD CONSTRAINT "EmployeeSalary_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSalary" ADD CONSTRAINT "EmployeeSalary_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSalary" ADD CONSTRAINT "EmployeeSalary_voidedBy_fkey" FOREIGN KEY ("voidedBy") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSalaryItem" ADD CONSTRAINT "EmployeeSalaryItem_salaryId_fkey" FOREIGN KEY ("salaryId") REFERENCES "EmployeeSalary"("id") ON DELETE CASCADE ON UPDATE CASCADE;
