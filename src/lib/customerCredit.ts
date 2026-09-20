import type { Prisma } from "@prisma/client";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Moves a customer's balance by a signed delta and writes the matching
 * ledger row (with the running balance after). Same mechanism the POS uses
 * for an order completed on credit — here it also carries the folio (room
 * stay) the credit came from. No-op for a zero delta. */
export async function applyCustomerBalance(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    customerId: string;
    orderId?: string | null;
    folioId?: string | null;
    delta: number;
    type: "CREDIT" | "REPAYMENT" | "ADJUSTMENT";
    note?: string | null;
    by?: string | null;
  },
) {
  const delta = round2(args.delta);
  if (delta === 0) return;
  const customer = await tx.customer.update({ where: { id: args.customerId }, data: { balance: { increment: delta } }, select: { balance: true } });
  await tx.customerCreditEntry.create({
    data: {
      tenantId: args.tenantId,
      customerId: args.customerId,
      orderId: args.orderId ?? undefined,
      folioId: args.folioId ?? undefined,
      type: args.type,
      amount: delta,
      balanceAfter: customer.balance,
      note: args.note ?? undefined,
      createdBy: args.by ?? undefined,
    },
  });
}

/** What a stay's credit still owes: every CREDIT entry for the folio less its
 * repayments. Positive = still outstanding. */
export async function folioCreditOutstanding(client: Prisma.TransactionClient | { customerCreditEntry: Prisma.TransactionClient["customerCreditEntry"] }, tenantId: string, folioIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (folioIds.length === 0) return result;
  const rows = await client.customerCreditEntry.groupBy({ by: ["folioId"], where: { tenantId, folioId: { in: folioIds } }, _sum: { amount: true } });
  for (const row of rows) if (row.folioId) result.set(row.folioId, round2(Number(row._sum.amount ?? 0)));
  return result;
}
