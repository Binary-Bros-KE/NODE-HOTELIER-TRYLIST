import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { partialNoDefaults } from "../../lib/zod.js";

// Menu ▸ Items (Phase 2). The new, richer menu-item CRUD built on the
// dedicated MenuCategory table. `isActive` (in the menu at all) and
// `isAvailable` (currently sellable) are deliberately separate. Recipe /
// product / inventory linkage is intentionally NOT handled here.
export const menuItemsRouter = Router();
menuItemsRouter.use(requireModule("POS"));

const DRINK_TEMPS = ["HOT", "COLD", "OTHER"] as const;

const DRINK_TAX_MODES = ["INCLUSIVE", "EXCLUSIVE"] as const;
const TAX_TREATMENTS = ["STANDARD", "ZERO_RATED", "EXEMPT"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const blankToNull = (v: unknown) => (v === "" || v == null ? null : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
// null clears the link / quantity.
const nullableId = z.preprocess(blankToNull, z.string().trim().min(1).nullable());
const nullableQty = z.preprocess(blankToNull, z.coerce.number().positive().max(9_999_999).nullable());
// Tax facets: null = inherit the tenant's BusinessProfile default, a value = override.
const nullableRate = z.preprocess(blankToNull, z.coerce.number().min(0).max(100).nullable());
const nullableEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(blankToNull, z.enum(values).nullable());

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  shortName: optionalText(40),
  menuCategoryId: z.string().trim().min(1, "Choose a category"),
  description: optionalText(500),
  sku: optionalText(60),
  price: z.coerce.number().min(0, "Price cannot be negative").max(9_999_999),
  taxRate: nullableRate.optional(),
  taxMode: nullableEnum(DRINK_TAX_MODES).optional(),
  taxTreatment: nullableEnum(TAX_TREATMENTS).optional(),
  // Stock deduction: either a direct product (consumes stockQtyPerUnit of
  // it per sale) or a recipe (multi-ingredient). Both null = no stock use.
  productId: nullableId.optional(),
  recipeId: nullableId.optional(),
  stockQtyPerUnit: nullableQty.optional(),
  photoUrl: optionalText(2000),
  temperature: z.enum(DRINK_TEMPS).default("OTHER"),
  isVegetarian: z.boolean().default(false),
  allowsAddons: z.boolean().default(false),
  isActive: z.boolean().default(true),
  isAvailable: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(99999).optional(),
  // Which selling points this item is offered at. Empty/omitted = unallocated
  // = sellable everywhere (the default). POS filters on this.
  locationIds: z.array(z.string().cuid()).optional(),
});
const updateSchema = partialNoDefaults(createSchema);
const reorderSchema = z.object({ menuCategoryId: z.string().trim().min(1), orderedIds: z.array(z.string().trim().min(1)).min(1) });

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const packUnitSelect = { select: { id: true, name: true } } as const;
const stockProductSelect = {
  select: { id: true, name: true, unit: true, packSize: true, packLabel: true, packUnit: packUnitSelect },
} as const;

const itemFields = {
  id: true,
  name: true,
  shortName: true,
  menuCategoryId: true,
  menuCategory: { select: { id: true, name: true, isActive: true } },
  description: true,
  sku: true,
  price: true,
  taxRate: true,
  taxMode: true,
  taxTreatment: true,
  productId: true,
  recipeId: true,
  stockQtyPerUnit: true,
  product: stockProductSelect,
  recipe: { select: { id: true, name: true } },
  photoUrl: true,
  temperature: true,
  isVegetarian: true,
  allowsAddons: true,
  isActive: true,
  isAvailable: true,
  sortOrder: true,
  locations: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
  variants: { select: { price: true } },
  _count: { select: { orderItems: true, variants: true } },
} as const;

const variantFields = {
  id: true,
  menuItemId: true,
  name: true,
  sku: true,
  price: true,
  stockProductId: true,
  stockQtyPerUnit: true,
  stockProduct: stockProductSelect,
  recipeId: true,
  recipe: { select: { id: true, name: true, ingredients: { select: { quantity: true, product: { select: { id: true, name: true, unit: true } } } } } },
  ingredientOverrides: { select: { productId: true, quantity: true, isRemoved: true, product: { select: { id: true, name: true, unit: true } } } },
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const;
const variantOrderBy: Prisma.MenuItemVariantOrderByWithRelationInput[] = [{ sortOrder: "asc" }, { name: "asc" }];

const orderBy: Prisma.MenuItemOrderByWithRelationInput[] = [
  { menuCategory: { sortOrder: "asc" } },
  { sortOrder: "asc" },
  { name: "asc" },
];

async function assertCategory(tid: string, menuCategoryId: string) {
  const category = await prisma.menuCategory.findFirst({ where: { id: menuCategoryId, tenantId: tid }, select: { id: true } });
  if (!category) throw Object.assign(new Error("Selected category was not found"), { status: 400 });
}

async function assertLocations(tid: string, ids: string[]) {
  if (!ids.length) return;
  const count = await prisma.location.count({ where: { id: { in: ids }, tenantId: tid } });
  if (count !== new Set(ids).size) throw Object.assign(new Error("Every location must belong to this property"), { status: 400 });
}

async function assertProduct(tid: string, productId: string | null | undefined) {
  if (!productId) return;
  const found = await prisma.product.findFirst({ where: { id: productId, tenantId: tid }, select: { id: true } });
  if (!found) throw Object.assign(new Error("Selected product was not found"), { status: 400 });
}

/** Validates a variant's recipe and override products, and returns the override rows to store. */
async function checkVariantRecipe(tid: string, recipeId: string | null | undefined, overrides: { productId: string; quantity: number; isRemoved: boolean }[] | undefined) {
  await assertRecipe(tid, recipeId);
  if (!overrides?.length) return [];
  if (!recipeId) throw Object.assign(new Error("Choose a recipe before changing its ingredients"), { status: 400 });
  const ids = [...new Set(overrides.map((o) => o.productId))];
  if (ids.length !== overrides.length) throw Object.assign(new Error("Each ingredient can only be changed once"), { status: 400 });
  const found = await prisma.product.count({ where: { id: { in: ids }, tenantId: tid } });
  if (found !== ids.length) throw Object.assign(new Error("An ingredient was not found"), { status: 400 });
  return overrides.map((o) => ({ productId: o.productId, quantity: o.isRemoved ? 0 : o.quantity, isRemoved: o.isRemoved }));
}

async function assertRecipe(tid: string, recipeId: string | null | undefined) {
  if (!recipeId) return;
  const found = await prisma.recipe.findFirst({ where: { id: recipeId, tenantId: tid }, select: { id: true } });
  if (!found) throw Object.assign(new Error("Selected recipe was not found"), { status: 400 });
}

menuItemsRouter.get("/", async (req, res, next) => {
  try {
    const query = z.object({
      search: optionalText(120),
      categoryId: z.string().trim().optional(),
      active: z.enum(["true", "false"]).optional(),
      available: z.enum(["true", "false"]).optional(),
    }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid item filters", details: query.error.flatten() }); return; }
    const { search, categoryId, active, available } = query.data;
    const items = await prisma.menuItem.findMany({
      where: {
        tenantId: tenantId(req),
        ...(categoryId ? { menuCategoryId: categoryId } : {}),
        ...(active ? { isActive: active === "true" } : {}),
        ...(available ? { isAvailable: available === "true" } : {}),
        ...(search ? { OR: [
          { name: { contains: search, mode: "insensitive" } },
          { shortName: { contains: search, mode: "insensitive" } },
          { sku: { contains: search, mode: "insensitive" } },
        ] } : {}),
      },
      select: itemFields,
      orderBy,
    });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

menuItemsRouter.get("/:id", async (req, res, next) => {
  try {
    const item = await prisma.menuItem.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: itemFields });
    if (!item) { res.status(404).json({ error: "Menu item not found" }); return; }
    res.json({ item });
  } catch (error) {
    next(error);
  }
});

menuItemsRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid menu item", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    await assertCategory(tid, data.data.menuCategoryId);
    const { locationIds, ...rest } = data.data;
    await assertLocations(tid, locationIds ?? []);
    await assertProduct(tid, rest.productId);
    await assertRecipe(tid, rest.recipeId);
    let { sortOrder } = rest;
    if (sortOrder === undefined) {
      const last = await prisma.menuItem.findFirst({ where: { tenantId: tid, menuCategoryId: data.data.menuCategoryId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }
    const item = await prisma.menuItem.create({
      data: { tenantId: tid, ...rest, sortOrder, ...(locationIds?.length ? { locations: { connect: locationIds.map((id) => ({ id })) } } : {}) },
      select: itemFields,
    });
    res.status(201).json({ item });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A menu item with this SKU already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

menuItemsRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid menu item", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    if (data.data.menuCategoryId) await assertCategory(tid, data.data.menuCategoryId);
    const { locationIds, ...rest } = data.data;
    if (locationIds) await assertLocations(tid, locationIds);
    await assertProduct(tid, rest.productId);
    await assertRecipe(tid, rest.recipeId);
    const existing = await prisma.menuItem.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Menu item not found" }); return; }
    const item = await prisma.menuItem.update({
      where: { id: existing.id },
      data: { ...rest, ...(locationIds ? { locations: { set: locationIds.map((id) => ({ id })) } } : {}) },
      select: itemFields,
    });
    res.json({ item });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A menu item with this SKU already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

menuItemsRouter.post("/reorder", async (req, res, next) => {
  const data = reorderSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid order", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const owned = await prisma.menuItem.count({ where: { id: { in: data.data.orderedIds }, tenantId: tid, menuCategoryId: data.data.menuCategoryId } });
    if (owned !== new Set(data.data.orderedIds).size) { res.status(400).json({ error: "Every item must belong to this category" }); return; }
    await prisma.$transaction(data.data.orderedIds.map((id, index) => prisma.menuItem.update({ where: { id }, data: { sortOrder: index } })));
    const items = await prisma.menuItem.findMany({ where: { tenantId: tid, menuCategoryId: data.data.menuCategoryId }, select: itemFields, orderBy });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

menuItemsRouter.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.menuItem.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: { id: true, _count: { select: { orderItems: true } } } });
    if (!existing) { res.status(404).json({ error: "Menu item not found" }); return; }
    if (existing._count.orderItems > 0) {
      res.status(409).json({ error: `This item is on ${existing._count.orderItems} order${existing._count.orderItems === 1 ? "" : "s"} — deactivate it instead` });
      return;
    }
    // Also clears its variants, add-on and location links.
    await prisma.menuItem.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// ── Variants (Phase 3) ──────────────────────────────────────────────────
// Sizes/options of a menu item with their own price. Zero or many per item;
// with none, the item's base price applies. Not add-ons.

const variantCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  sku: optionalText(60),
  price: z.coerce.number().min(0, "Price cannot be negative").max(9_999_999),
  // Overrides the parent item's stock deduction for this size — e.g. a Tot
  // consumes 25 of the whisky product, a Bottle 750.
  stockProductId: nullableId.optional(),
  stockQtyPerUnit: nullableQty.optional(),
  // Or: made from a recipe (any recipe) with explicit per-ingredient changes -
  // a different quantity, an ingredient removed, or an extra added - for just
  // this size. Instead of a product link, never both.
  recipeId: nullableId.optional(),
  ingredientOverrides: z.array(z.object({
    productId: z.string().trim().min(1),
    quantity: z.coerce.number().min(0).max(9_999_999).default(0),
    isRemoved: z.boolean().default(false),
  })).max(80).optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(99999).optional(),
}).refine((v) => !(v.recipeId && v.stockProductId), { message: "Use a product or a recipe for a variant's stock, not both", path: ["recipeId"] });
const variantUpdateSchema = partialNoDefaults(variantCreateSchema);
const variantReorderSchema = z.object({ orderedIds: z.array(z.string().trim().min(1)).min(1) });

async function assertMenuItem(tid: string, menuItemId: string) {
  const item = await prisma.menuItem.findFirst({ where: { id: menuItemId, tenantId: tid }, select: { id: true } });
  if (!item) throw Object.assign(new Error("Menu item not found"), { status: 404 });
}

// P2002.meta.target isn't reliably populated on this Postgres setup, so
// distinguish the SKU clash from the per-item name clash explicitly.
async function assertVariantSkuFree(tid: string, sku: string | undefined, exceptVariantId?: string) {
  if (!sku) return;
  const clash = await prisma.menuItemVariant.findFirst({ where: { tenantId: tid, sku, ...(exceptVariantId ? { id: { not: exceptVariantId } } : {}) }, select: { id: true } });
  if (clash) throw Object.assign(new Error("A variant with this SKU already exists"), { status: 409 });
}

menuItemsRouter.get("/:menuItemId/variants", async (req, res, next) => {
  try {
    const tid = tenantId(req);
    await assertMenuItem(tid, req.params.menuItemId);
    const variants = await prisma.menuItemVariant.findMany({ where: { tenantId: tid, menuItemId: req.params.menuItemId }, select: variantFields, orderBy: variantOrderBy });
    res.json({ variants });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

menuItemsRouter.post("/:menuItemId/variants", async (req, res, next) => {
  const data = variantCreateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid variant", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    await assertMenuItem(tid, req.params.menuItemId);
    await assertVariantSkuFree(tid, data.data.sku);
    await assertProduct(tid, data.data.stockProductId);
    const overrideRows = await checkVariantRecipe(tid, data.data.recipeId, data.data.ingredientOverrides);
    let { sortOrder } = data.data;
    if (sortOrder === undefined) {
      const last = await prisma.menuItemVariant.findFirst({ where: { tenantId: tid, menuItemId: req.params.menuItemId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }
    const { ingredientOverrides: _ignored, ...variantData } = data.data;
    void _ignored;
    const variant = await prisma.menuItemVariant.create({
      data: { tenantId: tid, menuItemId: req.params.menuItemId, ...variantData, sortOrder, ingredientOverrides: { create: overrideRows } },
      select: variantFields,
    });
    res.status(201).json({ variant });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "This item already has a variant with that name" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

menuItemsRouter.patch("/:menuItemId/variants/:id", async (req, res, next) => {
  const data = variantUpdateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid variant", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const exists = await prisma.menuItemVariant.findFirst({ where: { id: req.params.id, tenantId: tid, menuItemId: req.params.menuItemId }, select: { id: true } });
    if (!exists) { res.status(404).json({ error: "Variant not found" }); return; }
    await assertVariantSkuFree(tid, data.data.sku, req.params.id);
    await assertProduct(tid, data.data.stockProductId);
    // The recipe a variant ends up with (the one sent, or the one it already has) decides whether overrides make sense.
    const current = await prisma.menuItemVariant.findUniqueOrThrow({ where: { id: req.params.id }, select: { recipeId: true, stockProductId: true } });
    const finalRecipeId = data.data.recipeId !== undefined ? data.data.recipeId : current.recipeId;
    const finalProductId = data.data.stockProductId !== undefined ? data.data.stockProductId : current.stockProductId;
    if (finalRecipeId && finalProductId) { res.status(400).json({ error: "Use a product or a recipe for a variant's stock, not both" }); return; }
    const overrideRows = await checkVariantRecipe(tid, finalRecipeId, data.data.ingredientOverrides);
    const { ingredientOverrides, ...variantData } = data.data;
    await prisma.$transaction(async (tx) => {
      await tx.menuItemVariant.update({ where: { id: req.params.id }, data: variantData });
      // Overrides are replaced as a set when sent, and dropped when the variant stops using a recipe.
      if (ingredientOverrides !== undefined || !finalRecipeId) {
        await tx.menuItemVariantIngredient.deleteMany({ where: { variantId: req.params.id } });
        if (finalRecipeId && overrideRows.length) await tx.menuItemVariantIngredient.createMany({ data: overrideRows.map((row) => ({ ...row, variantId: req.params.id })) });
      }
    });
    const variant = await prisma.menuItemVariant.findUniqueOrThrow({ where: { id: req.params.id }, select: variantFields });
    res.json({ variant });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "This item already has a variant with that name" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

menuItemsRouter.post("/:menuItemId/variants/reorder", async (req, res, next) => {
  const data = variantReorderSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid order", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const owned = await prisma.menuItemVariant.count({ where: { id: { in: data.data.orderedIds }, tenantId: tid, menuItemId: req.params.menuItemId } });
    if (owned !== new Set(data.data.orderedIds).size) { res.status(400).json({ error: "Every variant must belong to this item" }); return; }
    await prisma.$transaction(data.data.orderedIds.map((id, index) => prisma.menuItemVariant.update({ where: { id }, data: { sortOrder: index } })));
    const variants = await prisma.menuItemVariant.findMany({ where: { tenantId: tid, menuItemId: req.params.menuItemId }, select: variantFields, orderBy: variantOrderBy });
    res.json({ variants });
  } catch (error) {
    next(error);
  }
});

menuItemsRouter.delete("/:menuItemId/variants/:id", async (req, res, next) => {
  try {
    const deleted = await prisma.menuItemVariant.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req), menuItemId: req.params.menuItemId } });
    if (!deleted.count) { res.status(404).json({ error: "Variant not found" }); return; }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
