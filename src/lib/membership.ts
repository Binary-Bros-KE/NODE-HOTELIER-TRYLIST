import type { Prisma, PrismaClient } from "@prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

/** ACTIVE only counts while its end date hasn't passed — nothing flips the
 * stored status when a membership lapses, so expiry is decided on read. */
export function effectiveMembershipStatus(status: string, endsAt: Date, now = new Date()) {
  return status === "ACTIVE" && endsAt < now ? "EXPIRED" : status;
}

export type MemberDiscount = { percent: number; label: string; onProducts: boolean };

/** The best discount a customer's current (active, started, not lapsed)
 * memberships give them, or null. Used by every till and by appointments so
 * a member gets the same discount wherever they buy. */
export async function currentMemberDiscount(client: Client, tid: string, customerId: string | null | undefined, now = new Date()): Promise<MemberDiscount | null> {
  if (!customerId) return null;
  const memberships = await client.membership.findMany({
    where: { tenantId: tid, customerId, status: "ACTIVE", startsAt: { lte: now }, endsAt: { gte: now }, discountPercent: { gt: 0 } },
    select: { planName: true, discountPercent: true, discountOnProducts: true },
  });
  const best = memberships.sort((a, b) => Number(b.discountPercent) - Number(a.discountPercent))[0];
  return best ? { percent: Number(best.discountPercent), label: `Membership: ${best.planName} (${Number(best.discountPercent)}% off)`, onProducts: best.discountOnProducts } : null;
}

/** Visits count against the current term only: from the later of the start
 * date and (end date - duration), so a renewal opens a fresh allowance. */
export function termStart(m: { startsAt: Date; endsAt: Date; durationDays: number }) {
  const byDuration = new Date(m.endsAt.getTime() - m.durationDays * 86_400_000);
  return byDuration > m.startsAt ? byDuration : m.startsAt;
}

export function visitsInTerm(m: { startsAt: Date; endsAt: Date; durationDays: number }, visits: { visitedAt: Date }[]) {
  const from = termStart(m);
  return visits.filter((v) => v.visitedAt >= from).length;
}
