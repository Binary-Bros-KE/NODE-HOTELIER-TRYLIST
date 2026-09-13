import { prisma } from "../lib/prisma.js";
import { SYSTEM_ROLES } from "../lib/tenantBootstrap.js";

// One-off, idempotent: SYSTEM_ROLES grew (added "Barman") and ALL_PERMISSIONS
// had drifted from the Permission enum (missing SHIFT_MANAGE/
// ATTENDANCE_MANAGE/SHIFT_EXEMPT) — but provisionTenantBootstrap only ever
// runs once, at tenant creation. Existing tenants never get a new system
// role or a corrected permission set unless something re-runs this upsert
// for them. Mirrors the exact upsert tenantBootstrap.ts uses, just looped
// over every existing tenant. Only ever touches a role whose name matches
// one in SYSTEM_ROLES — a tenant's own custom roles are never read or
// written. Safe to run repeatedly.
async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  let rolesCreated = 0;
  let rolesUpdated = 0;

  for (const tenant of tenants) {
    for (const role of SYSTEM_ROLES) {
      const existing = await prisma.role.findUnique({ where: { tenantId_name: { tenantId: tenant.id, name: role.name } } });
      await prisma.role.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name: role.name } },
        update: { description: role.description, allowedSections: [...role.allowedSections], permissions: [...role.permissions], isSystemRole: true },
        create: { tenantId: tenant.id, name: role.name, description: role.description, allowedSections: [...role.allowedSections], permissions: [...role.permissions], isSystemRole: true },
      });
      if (existing) {
        const samePermissions = JSON.stringify([...existing.permissions].sort()) === JSON.stringify([...role.permissions].sort());
        if (!samePermissions) { rolesUpdated++; console.log(`${tenant.name}: updated "${role.name}" permissions -> [${role.permissions.join(", ")}]`); }
      } else {
        rolesCreated++;
        console.log(`${tenant.name}: created "${role.name}"`);
      }
    }
  }

  console.log(`\nDone — ${rolesCreated} role(s) created, ${rolesUpdated} role(s) had their permissions corrected, across ${tenants.length} tenant(s).`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
