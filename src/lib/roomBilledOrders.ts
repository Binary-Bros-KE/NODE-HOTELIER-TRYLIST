import type { prisma } from "./prisma.js";

type Db = Pick<typeof prisma, "folioLineItem" | "folioPayment" | "posOrder">;

/**
 * A POS order billed to a room is paid by the room's folio, not by the order.
 * Once the folio balance reaches zero, every POS order billed to it is marked
 * PAID, so the POS receipts stop showing them as owing. Partial payments leave
 * the orders as they are until the folio is fully settled.
 */
export async function syncRoomBilledOrderPayments(db: Db, folioId: string): Promise<void> {
  const [lines, payments] = await Promise.all([
    db.folioLineItem.findMany({ where: { folioId }, select: { amount: true, quantity: true, source: true, sourceRefId: true } }),
    db.folioPayment.findMany({ where: { folioId }, select: { amount: true } }),
  ]);
  const charged = lines.reduce((sum, line) => sum + Number(line.amount) * Number(line.quantity), 0);
  const paid = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  if (charged - paid > 0.01) return;

  const orderIds = lines.filter((line) => line.source === "POS_ORDER" && line.sourceRefId).map((line) => line.sourceRefId as string);
  if (!orderIds.length) return;
  await db.posOrder.updateMany({ where: { id: { in: orderIds }, paymentStatus: { not: "PAID" } }, data: { paymentStatus: "PAID" } });
}
