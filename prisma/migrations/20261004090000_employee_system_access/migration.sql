-- Employees without system access have no PIN and cannot sign in.
ALTER TABLE "Employee" ALTER COLUMN "pin" DROP NOT NULL;
ALTER TABLE "Employee" ADD COLUMN "hasSystemAccess" BOOLEAN NOT NULL DEFAULT true;
