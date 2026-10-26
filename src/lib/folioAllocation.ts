/**
 * How a folio's payments are shared out over its charges.
 *
 * Each charged bill (a POS order billed to the room) is its own pot; every other
 * line - room nights, room-change adjustments, breakfast, extras - is one "room &
 * stay" pot. A payment aimed at a bill or at the room fills that pot first, and any
 * excess joins the unaimed payments, which fill the pots oldest first (the folio's
 * original behaviour, so folios paid before payments could be aimed read the same).
 *
 * The same rule marks a room-billed POS order paid, shows the green tick on its folio
 * line, and decides how much a new aimed payment may be.
 */

export const ROOM_POT = "ROOM";

export type AllocationLine = { id: string; source: string; sourceRefId: string | null; createdAt: Date; total: number };
export type AllocationPayment = { amount: number; appliesToLineId: string | null; appliesToRoom: boolean };
export type Pot = { key: string; total: number; paid: number; lineIds: string[]; orderId: string | null; firstAt: number };

const round2 = (value: number) => Math.round(value * 100) / 100;

export const potKeyFor = (line: { id: string; source: string }) => (line.source === "POS_ORDER" ? line.id : ROOM_POT);

export function allocateFolio(lines: AllocationLine[], payments: AllocationPayment[]) {
  const pots = new Map<string, Pot>();
  for (const line of lines) {
    const key = potKeyFor(line);
    const pot = pots.get(key) ?? { key, total: 0, paid: 0, lineIds: [], orderId: line.source === "POS_ORDER" ? line.sourceRefId : null, firstAt: line.createdAt.getTime() };
    pot.total = round2(pot.total + line.total);
    pot.lineIds.push(line.id);
    pot.firstAt = Math.min(pot.firstAt, line.createdAt.getTime());
    pots.set(key, pot);
  }
  const owing = (pot: Pot) => Math.max(0, round2(pot.total - pot.paid));
  let pool = 0;
  for (const payment of payments) {
    const key = payment.appliesToLineId && pots.has(payment.appliesToLineId) ? payment.appliesToLineId : payment.appliesToRoom && pots.has(ROOM_POT) ? ROOM_POT : null;
    if (!key) { pool = round2(pool + payment.amount); continue; }
    const pot = pots.get(key)!;
    const take = Math.min(owing(pot), payment.amount);
    pot.paid = round2(pot.paid + take);
    pool = round2(pool + payment.amount - take);
  }
  for (const pot of [...pots.values()].sort((a, b) => a.firstAt - b.firstAt)) {
    if (pool <= 0.005) break;
    const take = Math.min(owing(pot), pool);
    pot.paid = round2(pot.paid + take);
    pool = round2(pool - take);
  }
  return { pots, owing };
}
