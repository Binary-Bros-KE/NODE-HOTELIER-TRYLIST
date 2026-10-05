-- Recurring allowances and deductions per employee, copied onto each month's salary.
CREATE TABLE "EmployeeSalaryDefault" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "EmployeeSalaryItemType" NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeSalaryDefault_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmployeeSalaryDefault_tenantId_employeeId_idx" ON "EmployeeSalaryDefault"("tenantId", "employeeId");

ALTER TABLE "EmployeeSalaryDefault" ADD CONSTRAINT "EmployeeSalaryDefault_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmployeeSalaryDefault" ADD CONSTRAINT "EmployeeSalaryDefault_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The default a salary line was copied from.
ALTER TABLE "EmployeeSalaryItem" ADD COLUMN "defaultId" TEXT;
