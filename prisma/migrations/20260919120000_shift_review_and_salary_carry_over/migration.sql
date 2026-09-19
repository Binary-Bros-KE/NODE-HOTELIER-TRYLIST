-- Two new action-level permissions: editing a shift's outcome after the
-- fact, and recording/completing salary adjustments.
ALTER TYPE "Permission" ADD VALUE IF NOT EXISTS 'SHIFT_REVIEW';
ALTER TYPE "Permission" ADD VALUE IF NOT EXISTS 'SALARY_MANAGE';

-- Discrepancy notes + audit of after-the-fact edits on a shift.
ALTER TABLE "ShiftSession"
  ADD COLUMN "varianceNote" TEXT,
  ADD COLUMN "reviewedBy" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewReason" TEXT;

-- Deductions that exceeded gross pay, pushed onto next month's draft.
ALTER TABLE "EmployeeSalary" ADD COLUMN "carriedOverAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Trace a salary line back to the shift (or prior salary) that produced it.
ALTER TABLE "EmployeeSalaryItem"
  ADD COLUMN "shiftSessionId" TEXT,
  ADD COLUMN "carriedFromSalaryId" TEXT;
CREATE INDEX "EmployeeSalaryItem_shiftSessionId_idx" ON "EmployeeSalaryItem"("shiftSessionId");
