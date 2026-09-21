import type { Prisma } from "@prisma/client";

/** Collapses identical menu lines on one order into a single line (5 x White
 * Cap instead of 1 + 1 + 1 + 2). Rounds added after the bar/kitchen engaged are
 * deliberately stored as separate flagged rows so they can see exactly what's
 * new — this is the tidy-up for once that's done (served, acknowledged, or the
 * bill completed), so the receipt isn't needlessly long.
 *
 * Two lines are "identical" only if everything that affects the bill matches:
 * same item, variant, price, tax snapshot and add-ons — so merging never
 * changes a total. A line that has any return request against it is left
 * alone (its history hangs off that row). */
export async function mergeDuplicateOrderLines(
  tx: Prisma.TransactionClient,
  orderId: string,
  opts: { includeFlagged: boolean },
): Promise<number> {
  const items = await tx.posOrderItem.findMany({
    where: { orderId, menuItemId: { not: null } },
    include: { addons: true, _count: { select: { returnRequests: true } } },
    orderBy: { createdAt: "asc" },
  });

  const groups = new Map<string, typeof items>();
  for (const item of items) {
    if (item._count.returnRequests > 0) continue;
    if (item.addedAfterSend && !opts.includeFlagged) continue;
    const key = [
      // Lines covered by different store-dispatch requests stay separate while the
      // order is live, or the merged quantity would claim more was dispatched than was.
      opts.includeFlagged ? "" : item.dispatchRequestId ?? "",
      item.menuItemId, item.variantId ?? "", String(item.unitPrice), String(item.taxRate ?? ""), item.taxMode ?? "", item.taxTreatment ?? "",
      item.addons.map((a) => `${a.addonId}:${a.quantity}:${String(a.unitPrice)}`).sort().join("|"),
    ].join("~");
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  let merged = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = group;
    await tx.posOrderItem.update({
      where: { id: keep.id },
      data: { quantity: group.reduce((sum, row) => sum + row.quantity, 0), addedAfterSend: false },
    });
    await tx.posOrderItem.deleteMany({ where: { id: { in: rest.map((row) => row.id) } } });
    merged += rest.length;
  }
  return merged;
}
