-- Who may clear customer debts (credit payments) is now a role permission.
ALTER TYPE "Permission" ADD VALUE 'CREDIT_COLLECT';
