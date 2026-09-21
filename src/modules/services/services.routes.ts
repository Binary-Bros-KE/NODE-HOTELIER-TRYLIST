import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { partialNoDefaults } from "../../lib/zod.js";

export const servicesRouter = Router();

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
// null = "not set": cost not costed, tax inherited from the business default.
const nullableCost = z.preprocess(blankToNull, z.coerce.number().min(0).max(9_999_999).nullable());
const nullableRate = z.preprocess(blankToNull, z.coerce.number().min(0).max(100).nullable());
const nullableEnum = <T extends readonly [string, ...string[]]>(values: T) => z.preprocess(blankToNull, z.enum(values).nullable());
const nullableId = z.preprocess(blankToNull, z.string().trim().min(1).nullable());
const nullableQty = z.preprocess(blankToNull, z.coerce.number().positive().max(9_999_999).nullable());
const nullableMinutes = z.preprocess(blankToNull, z.coerce.number().int().min(1).max(100_000).nullable());

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  categoryId: z.string().cuid(),
  unitId: z.string().cuid(),
  price: z.coerce.number().nonnegative(),
  cost: nullableCost.optional(),
  // Same tax model as menu items: all null = business default; else an override.
  taxRate: nullableRate.optional(),
  taxMode: nullableEnum(["INCLUSIVE", "EXCLUSIVE"] as const).optional(),
  taxTreatment: nullableEnum(["STANDARD", "ZERO_RATED", "EXEMPT"] as const).optional(),
  // How long one unit takes; drives the active-service timer.
  durationMinutes: nullableMinutes.optional(),
  // Stock consumed per unit: one product (+ quantity) or a recipe - never both.
  productId: nullableId.optional(),
  stockQtyPerUnit: nullableQty.optional(),
  recipeId: nullableId.optional(),
  description: optionalText(500),
  isActive: z.boolean().default(true),
  // Empty = unallocated = sellable at every location (the default) —
  // identical convention to MenuItem.locationIds.
  locationIds: z.array(z.string().cuid()).default([]),
}).refine((v) => !(v.productId && v.recipeId), { message: "Use a product or a recipe for a service's stock, not both", path: ["recipeId"] });
const updateSchema = partialNoDefaults(createSchema);

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const productRef = { select: { id: true, name: true, unit: true } } as const;
const recipeRef = { select: { id: true, name: true, ingredients: { select: { quantity: true, product: productRef } } } } as const;
const variantFields = {
  id: true,
  serviceId: true,
  name: true,
  sku: true,
  price: true,
  durationMinutes: true,
  cost: true,
  stockProductId: true,
  stockQtyPerUnit: true,
  stockProduct: productRef,
  recipeId: true,
  recipe: recipeRef,
  ingredientOverrides: { select: { productId: true, quantity: true, isRemoved: true, product: productRef } },
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const;
const variantOrderBy: Prisma.ServiceVariantOrderByWithRelationInput[] = [{ sortOrder: "asc" }, { name: "asc" }];
const serviceInclude = {
  category: { select: { id: true, name: true } },
  unit: { select: { id: true, name: true } },
  locations: { select: { id: true, name: true } },
  product: productRef,
  recipe: { select: { id: true, name: true } },
  variants: { select: variantFields, orderBy: variantOrderBy },
} as const;

async function assertLocationsInTenant(locationIds: string[], tid: string) {
  if (!locationIds.length) return;
  const count = await prisma.location.count({ where: { id: { in: locationIds }, tenantId: tid } });
  if (count !== new Set(locationIds).size) throw Object.assign(new Error("Every location must belong to this property"), { status: 400 });
}

async function assertCategoryInTenant(categoryId: string, tid: string) {
  const category = await prisma.serviceCategory.findFirst({ where: { id: categoryId, tenantId: tid }, select: { id: true } });
  if (!category) throw Object.assign(new Error("Choose a valid service category"), { status: 400 });
}

async function assertUnitInTenant(unitId: string, tid: string) {
  const unit = await prisma.unitOfMeasure.findFirst({ where: { id: unitId, tenantId: tid }, select: { id: true } });
  if (!unit) throw Object.assign(new Error("Choose a valid unit of measure"), { status: 400 });
}

async function assertProduct(tid: string, productId: string | null | undefined) {
  if (!productId) return;
  const found = await prisma.product.findFirst({ where: { id: productId, tenantId: tid }, select: { id: true } });
  if (!found) throw Object.assign(new Error("Selected product was not found"), { status: 400 });
}

async function assertRecipe(tid: string, recipeId: string | null | undefined) {
  if (!recipeId) return;
  const found = await prisma.recipe.findFirst({ where: { id: recipeId, tenantId: tid }, select: { id: true } });
  if (!found) throw Object.assign(new Error("Selected recipe was not found"), { status: 400 });
}

const fail = (res: import("express").Response, error: unknown, next: import("express").NextFunction) => {
  if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
  next(error);
};

servicesRouter.get("/", async (req, res) => {
  const services = await prisma.service.findMany({ where: { tenantId: tenantId(req) }, include: serviceInclude, orderBy: { name: "asc" } });
  res.json({ services });
});

servicesRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid service", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    await Promise.all([assertCategoryInTenant(data.data.categoryId, tid), assertUnitInTenant(data.data.unitId, tid), assertLocationsInTenant(data.data.locationIds, tid), assertProduct(tid, data.data.productId), assertRecipe(tid, data.data.recipeId)]);
    const { locationIds, ...fields } = data.data;
    const service = await prisma.service.create({ data: { tenantId: tid, ...fields, locations: { connect: locationIds.map((id) => ({ id })) } }, include: serviceInclude });
    res.status(201).json({ service });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A service with this name already exists" }); return; }
    fail(res, error, next);
  }
});

servicesRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid service", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    if (data.data.categoryId) await assertCategoryInTenant(data.data.categoryId, tid);
    if (data.data.unitId) await assertUnitInTenant(data.data.unitId, tid);
    if (data.data.locationIds) await assertLocationsInTenant(data.data.locationIds, tid);
    await assertProduct(tid, data.data.productId);
    await assertRecipe(tid, data.data.recipeId);
    const { locationIds, ...fields } = data.data;
    const existing = await prisma.service.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, productId: true, recipeId: true } });
    if (!existing) { res.status(404).json({ error: "Service not found" }); return; }
    const finalProduct = fields.productId !== undefined ? fields.productId : existing.productId;
    const finalRecipe = fields.recipeId !== undefined ? fields.recipeId : existing.recipeId;
    if (finalProduct && finalRecipe) { res.status(400).json({ error: "Use a product or a recipe for a service's stock, not both" }); return; }
    const service = await prisma.service.update({
      where: { id: existing.id },
      data: { ...fields, ...(locationIds ? { locations: { set: locationIds.map((id) => ({ id })) } } : {}) },
      include: serviceInclude,
    });
    res.json({ service });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A service with this name already exists" }); return; }
    fail(res, error, next);
  }
});

servicesRouter.delete("/:id", async (req, res, next) => {
  const tid = tenantId(req);
  try {
    // Sold services are part of receipts and reports - they can only be deactivated.
    // Checked up front: the driver adapter doesn't surface a foreign-key violation as a Prisma known error.
    const sold = await prisma.posOrderItem.count({ where: { serviceId: req.params.id, order: { tenantId: tid } } });
    if (sold > 0) { res.status(409).json({ error: "This service has been sold, so it can't be deleted. Deactivate it instead." }); return; }
    const deleted = await prisma.service.deleteMany({ where: { id: req.params.id, tenantId: tid } });
    if (!deleted.count) { res.status(404).json({ error: "Service not found" }); return; }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// ── Variants ───────────────────────────────────────────────────────────────
// Sizes/options of a service with their own price (Swedish massage 30 / 60 min,
// car wash Saloon / SUV / Van). Zero or many per service; with none, the
// service's own price applies. Not add-ons. Mirrors menu-item variants.

const variantCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  sku: optionalText(60),
  price: z.coerce.number().min(0, "Price cannot be negative").max(9_999_999),
  durationMinutes: nullableMinutes.optional(),
  cost: nullableCost.optional(),
  // Stock this option consumes instead of the service's own: one product + quantity,
  // or a recipe (with per-ingredient overrides) - never both.
  stockProductId: nullableId.optional(),
  stockQtyPerUnit: nullableQty.optional(),
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
const reorderSchema = z.object({ orderedIds: z.array(z.string().trim().min(1)).min(1) });

async function assertService(tid: string, serviceId: string) {
  const service = await prisma.service.findFirst({ where: { id: serviceId, tenantId: tid }, select: { id: true } });
  if (!service) throw Object.assign(new Error("Service not found"), { status: 404 });
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

// P2002.meta.target isn't reliably populated on this setup, so distinguish the SKU clash explicitly.
async function assertVariantSkuFree(tid: string, sku: string | undefined, exceptVariantId?: string) {
  if (!sku) return;
  const clash = await prisma.serviceVariant.findFirst({ where: { tenantId: tid, sku, ...(exceptVariantId ? { id: { not: exceptVariantId } } : {}) }, select: { id: true } });
  if (clash) throw Object.assign(new Error("A variant with this SKU already exists"), { status: 409 });
}

servicesRouter.get("/:serviceId/variants", async (req, res, next) => {
  try {
    const tid = tenantId(req);
    await assertService(tid, req.params.serviceId);
    res.json({ variants: await prisma.serviceVariant.findMany({ where: { tenantId: tid, serviceId: req.params.serviceId }, select: variantFields, orderBy: variantOrderBy }) });
  } catch (error) { fail(res, error, next); }
});

servicesRouter.post("/:serviceId/variants", async (req, res, next) => {
  const data = variantCreateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid variant", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    await assertService(tid, req.params.serviceId);
    await assertVariantSkuFree(tid, data.data.sku);
    await assertProduct(tid, data.data.stockProductId);
    const overrideRows = await checkVariantRecipe(tid, data.data.recipeId, data.data.ingredientOverrides);
    let { sortOrder } = data.data;
    if (sortOrder === undefined) {
      const last = await prisma.serviceVariant.findFirst({ where: { tenantId: tid, serviceId: req.params.serviceId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }
    const { ingredientOverrides: _ignored, ...variantData } = data.data;
    void _ignored;
    const variant = await prisma.serviceVariant.create({
      data: { tenantId: tid, serviceId: req.params.serviceId, ...variantData, sortOrder, ingredientOverrides: { create: overrideRows } },
      select: variantFields,
    });
    res.status(201).json({ variant });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "This service already has a variant with that name" }); return; }
    fail(res, error, next);
  }
});

servicesRouter.patch("/:serviceId/variants/:id", async (req, res, next) => {
  const data = variantUpdateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid variant", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const current = await prisma.serviceVariant.findFirst({ where: { id: req.params.id, tenantId: tid, serviceId: req.params.serviceId }, select: { id: true, recipeId: true, stockProductId: true } });
    if (!current) { res.status(404).json({ error: "Variant not found" }); return; }
    await assertVariantSkuFree(tid, data.data.sku, current.id);
    await assertProduct(tid, data.data.stockProductId);
    const finalRecipeId = data.data.recipeId !== undefined ? data.data.recipeId : current.recipeId;
    const finalProductId = data.data.stockProductId !== undefined ? data.data.stockProductId : current.stockProductId;
    if (finalRecipeId && finalProductId) { res.status(400).json({ error: "Use a product or a recipe for a variant's stock, not both" }); return; }
    const overrideRows = await checkVariantRecipe(tid, finalRecipeId, data.data.ingredientOverrides);
    const { ingredientOverrides, ...variantData } = data.data;
    await prisma.$transaction(async (tx) => {
      await tx.serviceVariant.update({ where: { id: current.id }, data: variantData });
      // Overrides are replaced as a set when sent, and dropped when the variant stops using a recipe.
      if (ingredientOverrides !== undefined || !finalRecipeId) {
        await tx.serviceVariantIngredient.deleteMany({ where: { variantId: current.id } });
        if (finalRecipeId && overrideRows.length) await tx.serviceVariantIngredient.createMany({ data: overrideRows.map((row) => ({ ...row, variantId: current.id })) });
      }
    });
    res.json({ variant: await prisma.serviceVariant.findUniqueOrThrow({ where: { id: current.id }, select: variantFields }) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "This service already has a variant with that name" }); return; }
    fail(res, error, next);
  }
});

servicesRouter.post("/:serviceId/variants/reorder", async (req, res, next) => {
  const data = reorderSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid order", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const owned = await prisma.serviceVariant.count({ where: { id: { in: data.data.orderedIds }, tenantId: tid, serviceId: req.params.serviceId } });
    if (owned !== new Set(data.data.orderedIds).size) { res.status(400).json({ error: "Every variant must belong to this service" }); return; }
    await prisma.$transaction(data.data.orderedIds.map((id, index) => prisma.serviceVariant.update({ where: { id }, data: { sortOrder: index } })));
    res.json({ variants: await prisma.serviceVariant.findMany({ where: { tenantId: tid, serviceId: req.params.serviceId }, select: variantFields, orderBy: variantOrderBy }) });
  } catch (error) { next(error); }
});

servicesRouter.delete("/:serviceId/variants/:id", async (req, res, next) => {
  const tid = tenantId(req);
  try {
    const sold = await prisma.posOrderItem.count({ where: { serviceVariantId: req.params.id, order: { tenantId: tid } } });
    if (sold > 0) { res.status(409).json({ error: "This variant has been sold, so it can't be deleted. Deactivate it instead." }); return; }
    const deleted = await prisma.serviceVariant.deleteMany({ where: { id: req.params.id, tenantId: tid, serviceId: req.params.serviceId } });
    if (!deleted.count) { res.status(404).json({ error: "Variant not found" }); return; }
    res.status(204).send();
  } catch (error) { next(error); }
});
