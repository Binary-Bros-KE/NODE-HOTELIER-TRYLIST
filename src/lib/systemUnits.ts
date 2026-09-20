import type { Prisma, PrismaClient } from "@prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

/** Built-in units of measure the system's own logic keys off (never by name). */
export const SYSTEM_UNITS = [
  { key: "HOUR", label: "Hour" },
  { key: "NIGHT", label: "Night" },
  { key: "DAY", label: "Day" },
] as const;

/**
 * Makes sure a tenant has every built-in unit. A unit the user already made
 * with the same name (any casing) is adopted rather than duplicated. Cheap and
 * idempotent — call it wherever units are listed or created, so new tenants
 * never need a provisioning step.
 */
export async function ensureSystemUnits(client: Client, tenantId: string) {
  const existing = await client.unitOfMeasure.findMany({ where: { tenantId }, select: { id: true, name: true, systemKey: true } });
  for (const { key, label } of SYSTEM_UNITS) {
    if (existing.some((u) => u.systemKey === key)) continue;
    const adoptable = existing.find((u) => !u.systemKey && u.name.toLowerCase() === label.toLowerCase());
    if (adoptable) await client.unitOfMeasure.update({ where: { id: adoptable.id }, data: { systemKey: key } });
    else await client.unitOfMeasure.create({ data: { tenantId, name: label, systemKey: key } });
  }
}
