import type { Prisma } from "@prisma/client";

// What an order line consumes from stock. Shared by POS (deducts at serve time,
// checks availability) and the kitchen's store-dispatch request (asks the store
// for exactly these quantities), so both always agree on the recipe maths.

export type StockRef = { id: string; name: string };
export type QtyLike = Prisma.Decimal | number | null;
type RecipeLike = { ingredients: { product: StockRef; quantity: Prisma.Decimal | number }[] } | null;
type VariantForStock = {
  stockProductId: string | null;
  stockQtyPerUnit: QtyLike;
  stockProduct: StockRef | null;
  recipe?: RecipeLike;
  ingredientOverrides?: { product: StockRef; quantity: Prisma.Decimal | number; isRemoved: boolean }[];
};
type AddonForStock = { stockProductId: string | null; stockQtyPerUnit: QtyLike; stockProduct: StockRef | null; recipe?: RecipeLike };
export type OrderItemForStock = {
  quantity: number;
  variant?: VariantForStock | null;
  menuItem: {
    product: StockRef | null;
    stockQtyPerUnit?: QtyLike;
    recipe: RecipeLike;
  } | null;
  addons?: { quantity: number; addon: AddonForStock }[];
};

/** How every place that loads a variant or add-on for stock maths should select it. */
export const stockRefSelect = { select: { id: true, name: true } } as const;
export const recipeIngredientsSelect = { select: { ingredients: { select: { quantity: true, product: stockRefSelect } } } } as const;
export const variantStockSelect = {
  id: true, name: true, stockProductId: true, stockQtyPerUnit: true,
  stockProduct: stockRefSelect,
  recipe: recipeIngredientsSelect,
  ingredientOverrides: { select: { quantity: true, isRemoved: true, product: stockRefSelect } },
} satisfies Prisma.MenuItemVariantSelect;
export const variantStockInclude = {
  stockProduct: stockRefSelect,
  recipe: recipeIngredientsSelect,
  ingredientOverrides: { select: { quantity: true, isRemoved: true, product: stockRefSelect } },
} satisfies Prisma.MenuItemVariantInclude;
export const addonStockSelect = {
  id: true, name: true, price: true, stockProductId: true, stockQtyPerUnit: true,
  stockProduct: stockRefSelect,
  recipe: recipeIngredientsSelect,
} satisfies Prisma.AddonSelect;
export const addonStockInclude = { stockProduct: stockRefSelect, recipe: recipeIngredientsSelect } satisfies Prisma.AddonInclude;

/**
 * A variant's effective ingredients: its recipe's ingredients, then the
 * variant's own overrides on top - a changed quantity, an ingredient dropped
 * (isRemoved), or an extra the recipe doesn't have. Explicit per-variant
 * numbers, never a multiplier of the base recipe.
 */
export function variantRecipeIngredients(variant: VariantForStock): { item: StockRef; quantity: number }[] | null {
  if (!variant.recipe) return null;
  const merged = new Map<string, { item: StockRef; quantity: number }>();
  for (const ingredient of variant.recipe.ingredients) merged.set(ingredient.product.id, { item: ingredient.product, quantity: Number(ingredient.quantity) });
  for (const override of variant.ingredientOverrides ?? []) {
    if (override.isRemoved) merged.delete(override.product.id);
    else merged.set(override.product.id, { item: override.product, quantity: Number(override.quantity) });
  }
  return [...merged.values()].filter((entry) => entry.quantity > 0);
}

/** Totals up how much of each product a set of order items actually needs.
 * Priority per line for the item itself: a variant's own product+serving
 * (Tot/Double/Bottle) → the variant's own recipe (with its overrides) → the
 * menu item's recipe ingredients → the menu item's directly-linked product
 * times its stockQtyPerUnit (defaulting to 1 = a whole unit). Each add-on on
 * the line is independent of that choice and, when it carries a stock link
 * (one product, or a recipe), adds its own requirement on top (an "Extra Red
 * Bull" consumes a can regardless of what the parent drink consumes) — see the
 * pricing math in orderTotals.ts's lineSubtotal, which the same addon.quantity
 * × orderItem.quantity multiplication mirrors. */
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
    } else if (v?.recipe) {
      ingredients = variantRecipeIngredients(v);
    } else if (orderItem.menuItem?.recipe?.ingredients.length) {
      ingredients = orderItem.menuItem.recipe.ingredients.map((ingredient) => ({ item: ingredient.product, quantity: Number(ingredient.quantity) }));
    } else if (orderItem.menuItem?.product) {
      ingredients = [{ item: orderItem.menuItem.product, quantity: Number(orderItem.menuItem.stockQtyPerUnit ?? 1) }];
    }
    if (ingredients) {
      for (const ingredient of ingredients) add(ingredient.item, ingredient.quantity * orderItem.quantity);
    }
    for (const orderAddon of orderItem.addons ?? []) {
      const addon = orderAddon.addon;
      const factor = orderAddon.quantity * orderItem.quantity;
      if (addon.stockProductId && addon.stockProduct) {
        add(addon.stockProduct, Number(addon.stockQtyPerUnit ?? 1) * factor);
      } else if (addon.recipe) {
        for (const ingredient of addon.recipe.ingredients) add(ingredient.product, Number(ingredient.quantity) * factor);
      }
    }
  }
  return requirements;
}
