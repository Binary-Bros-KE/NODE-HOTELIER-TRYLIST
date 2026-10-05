-- Products bought and recorded as expenses on receipt (never stocked).
ALTER TABLE "Product" ADD COLUMN "isExpenseItem" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "expenseCategoryId" TEXT;
ALTER TABLE "Product" ADD CONSTRAINT "Product_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An expense accrued on goods receipt has no payment method until the supplier is paid.
ALTER TABLE "Expense" ALTER COLUMN "paymentMethodId" DROP NOT NULL;
