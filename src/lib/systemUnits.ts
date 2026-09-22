import type { Prisma, PrismaClient } from "@prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

/** Built-in units every tenant is seeded with, so there's always a sensible
 * option for each measurement kind out of the box — a tenant is free to add
 * its own on top (a "Week", a "Bus Seat") with any name, as long as it also
 * declares a measurementKind. systemKey just locks these five specific rows
 * against rename/delete; it no longer gates what's usable for room pricing. */
export const SYSTEM_UNITS = [
  { key: "HOUR", label: "Hour", kind: "HOURS" },
  { key: "NIGHT", label: "Night", kind: "DAYS" },
  { key: "DAY", label: "Day", kind: "DAYS" },
  { key: "PERSON", label: "Person", kind: "HEADCOUNT" },
  { key: "EACH", label: "Each", kind: "EACH" },
] as const;

/**
 * Makes sure a tenant has every built-in unit. A unit the user already made
 * with the same name (any casing) is adopted rather than duplicated — its
 * measurementKind is set to match if it didn't already have one, but left
 * alone if the user had already picked a (different, deliberate) kind for
 * it. Cheap and idempotent — call it wherever units are listed or created,
 * so new tenants never need a provisioning step.
 */
export async function ensureSystemUnits(client: Client, tenantId: string) {
  const existing = await client.unitOfMeasure.findMany({ where: { tenantId }, select: { id: true, name: true, systemKey: true, measurementKind: true } });
  for (const { key, label, kind } of SYSTEM_UNITS) {
    const already = existing.find((u) => u.systemKey === key);
    if (already) {
      if (!already.measurementKind) await client.unitOfMeasure.update({ where: { id: already.id }, data: { measurementKind: kind } });
      continue;
    }
    const adoptable = existing.find((u) => !u.systemKey && u.name.toLowerCase() === label.toLowerCase());
    if (adoptable) await client.unitOfMeasure.update({ where: { id: adoptable.id }, data: { systemKey: key, measurementKind: adoptable.measurementKind ?? kind } });
    else await client.unitOfMeasure.create({ data: { tenantId, name: label, systemKey: key, measurementKind: kind } });
  }
}
