import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export type ActivityArea = "POS" | "STAYS" | "STOCK" | "MENU" | "DOCUMENTS" | "FINANCE" | "PAYROLL" | "PEOPLE" | "SETTINGS" | "SHIFTS" | "SERVICE_CENTER" | "AUTH";

export type ActivityChange = { field: string; label: string; from: unknown; to: unknown };

export type ActivityEntry = {
  area: ActivityArea;
  action: string;
  summary: string;
  target?: { type: string; id: string; label?: string | null };
  reason?: string | null;
  changes?: ActivityChange[];
  locationId?: string | null;
};

/**
 * Records one sensitive action in the activity log. Call it with the same transaction
 * client that makes the change, so the record and the change land (or fail) together.
 * The actor is always the signed-in session's employee (req.userId, set by authenticate).
 */
export async function logActivity(db: Db, req: { tenantId?: string; userId?: string; ip?: string }, entry: ActivityEntry) {
  if (!req.tenantId) return;
  const actor = req.userId
    ? await db.employee.findFirst({ where: { id: req.userId, tenantId: req.tenantId }, select: { firstName: true, lastName: true, role: { select: { name: true } } } })
    : null;
  await db.activityLog.create({
    data: {
      tenantId: req.tenantId,
      actorId: req.userId ?? null,
      actorName: actor ? `${actor.firstName} ${actor.lastName ?? ""}`.trim() : null,
      actorRole: actor?.role?.name ?? null,
      area: entry.area,
      action: entry.action,
      summary: entry.summary,
      targetType: entry.target?.type ?? null,
      targetId: entry.target?.id ?? null,
      targetLabel: entry.target?.label ?? null,
      reason: entry.reason ?? null,
      changes: entry.changes?.length ? (entry.changes as unknown as Prisma.InputJsonValue) : undefined,
      locationId: entry.locationId ?? null,
      ipAddress: req.ip ?? null,
    },
  });
}

const comparable = (value: unknown) => (value instanceof Date ? value.toISOString() : value != null && typeof value === "object" && "toFixed" in value ? Number(value) : value ?? null);

/** The fields that actually changed between two versions of a record, for an edit's entry. */
export function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>, labels: Partial<Record<keyof T & string, string>>): ActivityChange[] {
  return (Object.keys(labels) as (keyof T & string)[])
    .filter((field) => field in after && JSON.stringify(comparable(before[field])) !== JSON.stringify(comparable(after[field])))
    .map((field) => ({ field, label: labels[field]!, from: comparable(before[field]), to: comparable(after[field]) }));
}
