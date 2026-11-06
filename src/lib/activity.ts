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
// A changed link reads as the thing it points at ("Gilbeys 375ml"), not its id.
const NAMED_FIELDS: Record<string, (db: Db, tenantId: string, ids: string[]) => Promise<{ id: string; label: string }[]>> = {
  productId: (db, tenantId, ids) => db.product.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } }).then((rows) => rows.map((r) => ({ id: r.id, label: r.name }))),
  recipeId: (db, tenantId, ids) => db.recipe.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } }).then((rows) => rows.map((r) => ({ id: r.id, label: r.name }))),
  menuCategoryId: (db, tenantId, ids) => db.menuCategory.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } }).then((rows) => rows.map((r) => ({ id: r.id, label: r.name }))),
  paymentMethodId: (db, tenantId, ids) => db.paymentMethod.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } }).then((rows) => rows.map((r) => ({ id: r.id, label: r.name }))),
  locationId: (db, tenantId, ids) => db.location.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } }).then((rows) => rows.map((r) => ({ id: r.id, label: r.name }))),
  roomId: (db, tenantId, ids) => db.room.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, number: true } }).then((rows) => rows.map((r) => ({ id: r.id, label: `Room ${r.number}` }))),
  customerId: (db, tenantId, ids) => db.customer.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, firstName: true, lastName: true } }).then((rows) => rows.map((r) => ({ id: r.id, label: `${r.firstName} ${r.lastName ?? ""}`.trim() }))),
};
NAMED_FIELDS.stockProductId = NAMED_FIELDS.productId;
NAMED_FIELDS.expenseCategoryId = (db, tenantId, ids) => db.expenseCategory.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } }).then((rows) => rows.map((r) => ({ id: r.id, label: r.name })));

async function readableChanges(db: Db, tenantId: string, changes: ActivityChange[]) {
  return Promise.all(changes.map(async (change) => {
    const lookup = NAMED_FIELDS[change.field];
    const ids = [change.from, change.to].filter((v): v is string => typeof v === "string" && v.length > 0);
    if (!lookup || ids.length === 0) return change;
    const names = new Map((await lookup(db, tenantId, ids)).map((r) => [r.id, r.label]));
    const name = (v: unknown) => (typeof v === "string" ? names.get(v) ?? v : v);
    return { ...change, from: name(change.from), to: name(change.to) };
  }));
}

export async function logActivity(db: Db, req: { tenantId?: string; userId?: string; ip?: string }, entry: ActivityEntry) {
  if (!req.tenantId) return;
  const changes = entry.changes?.length ? await readableChanges(db, req.tenantId, entry.changes) : undefined;
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
      changes: changes ? (changes as unknown as Prisma.InputJsonValue) : undefined,
      locationId: entry.locationId ?? null,
      ipAddress: req.ip ?? null,
    },
  });
}

/** For an action whose change isn't one transaction the entry can join: log once it has
 * happened, and never turn a done change into an error for the person who made it. */
export async function logActivityAfter(req: { tenantId?: string; userId?: string; ip?: string }, entry: ActivityEntry) {
  const { prisma } = await import("./prisma.js");
  await logActivity(prisma, req, entry).catch((error) => console.error("Activity log write failed", entry.action, error));
}

const comparable = (value: unknown) => (value instanceof Date ? value.toISOString() : value != null && typeof value === "object" && "toFixed" in value ? Number(value) : value ?? null);

/** The fields that actually changed between two versions of a record, for an edit's entry. */
export function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>, labels: Partial<Record<keyof T & string, string>>): ActivityChange[] {
  return (Object.keys(labels) as (keyof T & string)[])
    .filter((field) => field in after && JSON.stringify(comparable(before[field])) !== JSON.stringify(comparable(after[field])))
    .map((field) => ({ field, label: labels[field]!, from: comparable(before[field]), to: comparable(after[field]) }));
}
