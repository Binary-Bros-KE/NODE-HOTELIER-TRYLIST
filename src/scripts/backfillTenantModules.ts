import { prisma } from "../lib/prisma.js";
import { MODULE_KEYS } from "../lib/tenantBootstrap.js";

// One-off, idempotent: MODULE_KEYS grew over time (most recently to add
// SERVICE_CENTER and ACCOUNTING), but existing tenants only ever got the
// keys MODULE_KEYS listed *when they were created* — a tenant provisioned
// before SERVICE_CENTER was added has no TenantModule row for it at all,
// so requireModule("SERVICE_CENTER") 403s every request. This fills in any
// missing key for every tenant, enabled by default so nobody loses access
// they conceptually always had. Safe to run repeatedly.
async function main() {
  const [tenants] = await Promise.all([
    prisma.tenant.findMany({ select: { id: true, name: true } }),
  ]);

  for (const moduleKey of MODULE_KEYS) {
    await prisma.module.upsert({
      where: { key: moduleKey },
      update: {},
      create: { key: moduleKey, name: moduleKey.replace("_", " ") },
    });
  }

  let created = 0;
  for (const tenant of tenants) {
    const existing = await prisma.tenantModule.findMany({ where: { tenantId: tenant.id }, select: { moduleKey: true } });
    const have = new Set(existing.map((m) => m.moduleKey));
    const missing = MODULE_KEYS.filter((k) => !have.has(k));
    if (missing.length === 0) continue;
    await prisma.tenantModule.createMany({
      // WEBSITE is an opt-in add-on, never something a tenant "always had".
      data: missing.map((moduleKey) => ({ tenantId: tenant.id, moduleKey, isEnabled: moduleKey !== "WEBSITE" })),
    });
    console.log(`${tenant.name}: added ${missing.join(", ")}`);
    created += missing.length;
  }

  console.log(`Done — ${created} TenantModule row(s) created across ${tenants.length} tenant(s).`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
