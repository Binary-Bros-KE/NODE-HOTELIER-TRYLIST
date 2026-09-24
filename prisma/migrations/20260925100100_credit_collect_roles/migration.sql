-- Grant CREDIT_COLLECT to the system roles that should hold it in existing workspaces
-- (new ones get it from tenantBootstrap). Waiters/others deliberately do not. Custom roles untouched.
UPDATE "Role"
SET "permissions" = array_append("permissions", 'CREDIT_COLLECT'::"Permission")
WHERE "isSystemRole" = true
  AND "name" IN ('Super Admin', 'Manager', 'Accountant')
  AND NOT ('CREDIT_COLLECT'::"Permission" = ANY("permissions"));
