import type { Prisma } from "@prisma/client";

/** One menu-level movement line: what the customer got, not which ingredient
 * products it consumed (that's the stock ledger's job — see stockLedger.ts).
 * unitPrice is per unit INCLUDING add-ons, before order-level discount/tax. */
export type MenuLedgerLine = {
  menuItemId: string | null;
  itemName: string;
  variantName?: string | null;
  addonsNote?: string | null;
  quantity: number;
  unitPrice: number;
};

type OrderItemShape = {
  menuItemId: string | null;
  quantity: number;
  unitPrice: Prisma.Decimal | number;
  menuItem?: { name: string } | null;
  variant?: { name: string } | null;
  addons?: { quantity: number; unitPrice: Prisma.Decimal | number; addon?: { name: string } | null }[];
};

/** Menu lines out of stored order items. Retail product/service lines have no
 * menuItemId and are skipped — the menu ledger is only for menu items. */
export function menuLedgerLinesFromItems(items: OrderItemShape[], quantityOf: (item: OrderItemShape) => number = (i) => i.quantity): MenuLedgerLine[] {
  return items.flatMap((item) => {
    if (!item.menuItemId || !item.menuItem) return [];
    const quantity = quantityOf(item);
    if (quantity <= 0) return [];
    const addons = item.addons ?? [];
    const addonsTotal = addons.reduce((sum, a) => sum + Number(a.unitPrice) * a.quantity, 0);
    return [{
      menuItemId: item.menuItemId,
      itemName: item.menuItem.name,
      variantName: item.variant?.name ?? null,
      addonsNote: addons.length ? addons.map((a) => `${a.addon?.name ?? "Add-on"}${a.quantity > 1 ? ` x${a.quantity}` : ""}`).join(", ") : null,
      quantity,
      unitPrice: Number(item.unitPrice) + addonsTotal,
    }];
  });
}

/** Append menu-ledger rows for an order. Call inside the same transaction as
 * the stock movement it accompanies, so the two ledgers can't disagree about
 * whether something happened. SALE/COMPLIMENTARY store positive quantity and
 * amount, RETURN stores both negative. */
export async function recordMenuLedger(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    type: "SALE" | "COMPLIMENTARY" | "RETURN";
    order: { id: string; orderNumber: number; locationId: string | null };
    lines: MenuLedgerLine[];
    note?: string | null;
    by?: string | null;
  },
) {
  if (args.lines.length === 0) return;
  const sign = args.type === "RETURN" ? -1 : 1;
  await tx.menuLedgerEntry.createMany({
    data: args.lines.map((line) => ({
      tenantId: args.tenantId,
      type: args.type,
      menuItemId: line.menuItemId,
      itemName: line.itemName,
      variantName: line.variantName ?? null,
      addonsNote: line.addonsNote ?? null,
      quantity: sign * line.quantity,
      unitPrice: line.unitPrice,
      amount: Math.round(sign * line.quantity * line.unitPrice * 100) / 100,
      orderId: args.order.id,
      orderNumber: args.order.orderNumber,
      locationId: args.order.locationId,
      note: args.note ?? null,
      performedBy: args.by ?? null,
    })),
  });
}
