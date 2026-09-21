-- Grant the new STORE_DISPATCH permission to the system roles that should hold
-- it in existing workspaces (new ones get it from tenantBootstrap). Separate
-- from the migration that added the enum value, which can't be used in the
-- same transaction. Idempotent; custom roles are never touched.
UPDATE "Role"
SET "permissions" = array_append("permissions", 'STORE_DISPATCH'::"Permission")
WHERE "isSystemRole" = true
  AND "name" IN ('Super Admin', 'Manager', 'Storekeeper')
  AND NOT ('STORE_DISPATCH'::"Permission" = ANY("permissions"));
