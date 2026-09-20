import { prisma } from "./prisma.js";

/** Every location an employee is pinned to. Empty = no restriction (can
 * work/sell at any location; the POS asks them to pick one each time). */
export async function employeeLocationIds(tid: string, userId: string | undefined): Promise<string[]> {
  if (!userId) return [];
  const employee = await prisma.employee.findFirst({
    where: { id: userId, tenantId: tid },
    select: { locations: { select: { id: true } } },
  });
  return employee?.locations.map((l) => l.id) ?? [];
}

/** The employee's single location iff they're pinned to exactly one — the
 * only case where a location can be auto-resolved without asking. Null for
 * an unrestricted employee OR one pinned to several (both need a choice). */
export async function employeeLocationId(tid: string, userId: string | undefined): Promise<string | null> {
  const ids = await employeeLocationIds(tid, userId);
  return ids.length === 1 ? ids[0] : null;
}

/** Resolves which location a sale belongs to. Pinned to exactly one → always
 * that, whatever the client sends. Pinned to several → must send one of
 * them (rejected otherwise). Unrestricted → their choice, validated active.
 * Returns location: null only when the property has never created any
 * location (the whole feature is opt-in). Blocks (returns an error) when the
 * location is genuinely ambiguous — used where business logic (stock, sales
 * totals) actually depends on knowing which location a sale belongs to. */
export async function resolveEffectiveLocation(
  tid: string,
  userId: string | undefined,
  requestedLocationId: string | null | undefined,
): Promise<{ location: Awaited<ReturnType<typeof prisma.location.findFirst>> } | { error: string }> {
  const assigned = await employeeLocationIds(tid, userId);

  let effectiveLocationId: string | null;
  if (assigned.length === 1) {
    effectiveLocationId = assigned[0];
  } else if (assigned.length > 1) {
    if (!requestedLocationId) return { error: "Choose which of your locations this sale is for" };
    if (!assigned.includes(requestedLocationId)) return { error: "You can only sell at a location you're assigned to" };
    effectiveLocationId = requestedLocationId;
  } else {
    effectiveLocationId = requestedLocationId ?? null;
  }

  if (!effectiveLocationId) {
    const locationCount = await prisma.location.count({ where: { tenantId: tid } });
    if (locationCount > 0) return { error: "Choose which location this sale is for" };
    return { location: null };
  }
  const location = await prisma.location.findFirst({ where: { id: effectiveLocationId, tenantId: tid, isActive: true } });
  if (!location) return { error: "Choose an active location from this property" };
  return { location };
}

/** Best-effort, never-blocking location capture for audit trails — the
 * acting employee's location iff they're pinned to exactly one, else null.
 * Unlike resolveEffectiveLocation this never errors: recording "who did
 * this, where" must not stop the action just because the location isn't
 * knowable (a floating Manager, or one covering several locations). */
export async function resolveActorLocation(tid: string, userId: string | undefined): Promise<string | null> {
  return employeeLocationId(tid, userId);
}

/** Like resolveActorLocation, but also honours the location the client says
 * it is working at (Reception's location picker). A pinned-to-one employee is
 * always that location; otherwise a requested location is used only if it
 * belongs to the tenant (and to the employee's set, when they have one).
 * Never errors — an unusable request just falls back to null. */
export async function resolveActorLocationWithHint(tid: string, userId: string | undefined, requested: string | undefined): Promise<string | null> {
  const assigned = await employeeLocationIds(tid, userId);
  if (assigned.length === 1) return assigned[0];
  if (!requested) return null;
  if (assigned.length > 1 && !assigned.includes(requested)) return null;
  const location = await prisma.location.findFirst({ where: { id: requested, tenantId: tid, isActive: true }, select: { id: true } });
  return location?.id ?? null;
}
