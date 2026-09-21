import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { partialNoDefaults } from "../../lib/zod.js";

// Menu ▸ Add-ons. A flat, tenant-wide catalog of individual add-ons, each
// optionally tagged with a menu category so the POS picker can filter on it.
// No groups, no per-item links, no selection rules.
export const addonsRouter = Router();
addonsRouter.use(requireModule("POS"));

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const blankToNull = (v: unknown) => (v === "" || v == null ? null : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
// null clears the link / quantity — same convention as MenuItem/MenuItemVariant.
const nullableId = z.preprocess(blankToNull, z.string().trim().min(1).nullable());
const nullableQty = z.preprocess(blankToNull, z.coerce.number().positive().max(9_999_999).nullable());

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: optionalText(280),
  price: z.coerce.number().min(0, "Price cannot be negative").max(9_999_999),
  sku: optionalText(60),
  imageUrl: optionalText(2000),
  // null = uncategorised (shows only under "All" in the POS picker).
  menuCategoryId: z.preprocess(blankToNull, z.string().cuid().nullable()).optional(),
  // Optional stock link: selling one unit of this add-on consumes
  // stockQtyPerUnit of stockProductId — e.g. "Extra Red Bull" consuming 1
  // can. Both null = no stock impact (a free garnish, a service charge).
  stockProductId: nullableId.optional(),
  stockQtyPerUnit: nullableQty.optional(),
  // Or a recipe, like a menu item: one unit consumes that recipe's ingredients.
  recipeId: nullableId.optional(),
  isActive: z.boolean().default(true),
}).refine((v) => !(v.recipeId && v.stockProductId), { message: "Use a product or a recipe for an add-on's stock, not both", path: ["recipeId"] });
const updateSchema = partialNoDefaults(createSchema);

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const addonFields = {
  id: true,
  name: true,
  description: true,
  price: true,
  sku: true,
  imageUrl: true,
  menuCategoryId: true,
  menuCategory: { select: { id: true, name: true } },
  stockProductId: true,
  stockQtyPerUnit: true,
  stockProduct: { select: { id: true, name: true } },
  recipeId: true,
  recipe: { select: { id: true, name: true } },
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { orderItems: true } },
} as const;
const orderBy: Prisma.AddonOrderByWithRelationInput[] = [{ isActive: "desc" }, { menuCategory: { name: "asc" } }, { name: "asc" }];

async function assertSkuFree(tid: string, sku: string | undefined, exceptId?: string) {
  if (!sku) return;
  const clash = await prisma.addon.findFirst({ where: { tenantId: tid, sku, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
  if (clash) throw Object.assign(new Error("An add-on with this SKU already exists"), { status: 409 });
}

async function assertCategory(tid: string, menuCategoryId: string | null | undefined) {
  if (!menuCategoryId) return;
  const found = await prisma.menuCategory.findFirst({ where: { id: menuCategoryId, tenantId: tid }, select: { id: true } });
  if (!found) throw Object.assign(new Error("Selected category was not found"), { status: 400 });
}

async function assertRecipe(tid: string, recipeId: string | null | undefined) {
  if (!recipeId) return;
  const found = await prisma.recipe.findFirst({ where: { id: recipeId, tenantId: tid }, select: { id: true } });
  if (!found) throw Object.assign(new Error("Selected recipe was not found"), { status: 400 });
}

async function assertProduct(tid: string, productId: string | null | undefined) {
  if (!productId) return;
  const found = await prisma.product.findFirst({ where: { id: productId, tenantId: tid }, select: { id: true } });
  if (!found) throw Object.assign(new Error("Selected product was not found"), { status: 400 });
}

addonsRouter.get("/", async (req, res, next) => {
  try {
    const query = z.object({
      search: optionalText(80),
      active: z.enum(["true", "false"]).optional(),
      categoryId: z.string().trim().optional(),
    }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid filters", details: query.error.flatten() }); return; }
    const { search, active, categoryId } = query.data;
    const addons = await prisma.addon.findMany({
      where: {
        tenantId: tenantId(req),
        ...(active ? { isActive: active === "true" } : {}),
        ...(categoryId ? { menuCategoryId: categoryId } : {}),
        ...(search ? { OR: [
          { name: { contains: search, mode: "insensitive" } },
          { sku: { contains: search, mode: "insensitive" } },
        ] } : {}),
      },
      select: addonFields,
      orderBy,
    });
    res.json({ addons });
  } catch (error) {
    next(error);
  }
});

addonsRouter.get("/:id", async (req, res, next) => {
  try {
    const addon = await prisma.addon.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: addonFields });
    if (!addon) { res.status(404).json({ error: "Add-on not found" }); return; }
    res.json({ addon });
  } catch (error) {
    next(error);
  }
});

addonsRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid add-on", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    await assertSkuFree(tid, data.data.sku);
    await assertCategory(tid, data.data.menuCategoryId);
    await assertProduct(tid, data.data.stockProductId);
    await assertRecipe(tid, data.data.recipeId);
    const addon = await prisma.addon.create({ data: { tenantId: tid, ...data.data }, select: addonFields });
    res.status(201).json({ addon });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "An add-on with this name already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

addonsRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid add-on", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const existing = await prisma.addon.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Add-on not found" }); return; }
    await assertSkuFree(tid, data.data.sku, existing.id);
    await assertCategory(tid, data.data.menuCategoryId);
    await assertProduct(tid, data.data.stockProductId);
    await assertRecipe(tid, data.data.recipeId);
    const current = await prisma.addon.findUniqueOrThrow({ where: { id: existing.id }, select: { recipeId: true, stockProductId: true } });
    const finalRecipe = data.data.recipeId !== undefined ? data.data.recipeId : current.recipeId;
    const finalProduct = data.data.stockProductId !== undefined ? data.data.stockProductId : current.stockProductId;
    if (finalRecipe && finalProduct) { res.status(400).json({ error: "Use a product or a recipe for an add-on's stock, not both" }); return; }
    const addon = await prisma.addon.update({ where: { id: existing.id }, data: data.data, select: addonFields });
    res.json({ addon });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "An add-on with this name already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

addonsRouter.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.addon.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: { id: true, _count: { select: { orderItems: true } } } });
    if (!existing) { res.status(404).json({ error: "Add-on not found" }); return; }
    if (existing._count.orderItems > 0) {
      res.status(409).json({ error: `This add-on is on ${existing._count.orderItems} order${existing._count.orderItems === 1 ? "" : "s"} — deactivate it instead` });
      return;
    }
    await prisma.addon.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
