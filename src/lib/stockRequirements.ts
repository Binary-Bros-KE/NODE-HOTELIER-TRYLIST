import type { Prisma } from "@prisma/client";

// What an order line consumes from stock. Shared by POS (deducts at serve time,
// checks availability) and the kitchen's store-dispatch request (asks the store
// for exactly these quantities), so both always agree on the recipe maths.

export type StockRef = { id: string; name: string };
export type QtyLike = Prisma.Decimal | number | null;
export type OrderItemForStock = {
  quantity: number;
  variant?: { stockProductId: string | null; stockQtyPerUnit: QtyLike; stockProduct: StockRef | null } | null;
  menuItem: {
    product: StockRef | null;
    stockQtyPerUnit?: QtyLike;
    recipe: { ingredients: { product: StockRef; quantity: Prisma.Decimal | number }[] } | null;
  } | null;
  addons?: { quantity: number; addon: { stockProductId: string | null; stockQtyPerUnit: QtyLike; stockProduct: StockRef | null } }[];
};

/** Totals up how much of each product a set of order items actually needs.
 * Priority per line for the item itself: a variant's own product+serving
 * (Tot/Double/Bottle) → the menu item's recipe ingredients → the menu item's
 * directly-linked product times its stockQtyPerUnit (defaulting to 1 = a
 * whole unit). Each add-on on the line is independent of that choice and,
 * when it carries its own stock link, adds its own requirement on top (an
 * "Extra Red Bull" consumes a can regardless of what the parent drink
 * consumes) — see the pricing math in orderTotals.ts's lineSubtotal, which
 * the same addon.quantity × orderItem.quantity multiplication mirrors. */
export function computeStockRequirements(items: OrderItemForStock[]): Map<string, { quantity: number; name: string }> {
  const requirements = new Map<string, { quantity: number; name: string }>();
  const add = (item: StockRef, quantity: number) => {
    const current = requirements.get(item.id);
    requirements.set(item.id, { quantity: (current?.quantity ?? 0) + quantity, name: item.name });
  };
  for (const orderItem of items) {
    const v = orderItem.variant;
    let ingredients: { item: StockRef; quantity: number }[] | null = null;
    if (v?.stockProductId && v.stockProduct) {
      ingredients = [{ item: v.stockProduct, quantity: Number(v.stockQtyPerUnit ?? 1) }];
    } else if (orderItem.menuItem?.recipe?.ingredients.length) {
      ingredients = orderItem.menuItem.recipe.ingredients.map((ingredient) => ({ item: ingredient.product, quantity: Number(ingredient.quantity) }));
    } else if (orderItem.menuItem?.product) {
      ingredients = [{ item: orderItem.menuItem.product, quantity: Number(orderItem.menuItem.stockQtyPerUnit ?? 1) }];
    }
    if (ingredients) {
      for (const ingredient of ingredients) add(ingredient.item, ingredient.quantity * orderItem.quantity);
    }
    for (const orderAddon of orderItem.addons ?? []) {
      if (!orderAddon.addon.stockProductId || !orderAddon.addon.stockProduct) continue;
      add(orderAddon.addon.stockProduct, Number(orderAddon.addon.stockQtyPerUnit ?? 1) * orderAddon.quantity * orderItem.quantity);
    }
  }
  return requirements;
}
