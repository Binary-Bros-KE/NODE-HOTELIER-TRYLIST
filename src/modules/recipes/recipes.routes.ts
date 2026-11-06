import { Router } from "express";
import { logActivityAfter } from "../../lib/activity.js";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { partialNoDefaults } from "../../lib/zod.js";

export const recipesRouter = Router();
recipesRouter.use(requireModule("KITCHEN"));

const ingredientSchema = z.object({
  productId: z.string().trim().min(1),
  quantity: z.coerce.number().positive(),
});

const recipeSchema = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(500).optional(),
  estimatedMinutes: z.coerce.number().int().min(0).max(1440).optional(),
  steps: z.array(z.string().trim().min(1).max(500)).default([]),
  ingredients: z.array(ingredientSchema).default([]),
  isActive: z.boolean().default(true),
});
const updateSchema = partialNoDefaults(recipeSchema);

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const recipeInclude = {
  ingredients: { include: { product: { select: { id: true, name: true, unit: true } } }, orderBy: { createdAt: "asc" } },
  _count: { select: { menuItems: true } },
} as const;

async function assertIngredientsBelongToTenant(tid: string, ingredients: { productId: string }[]) {
  if (!ingredients.length) return;
  const ids = [...new Set(ingredients.map((i) => i.productId))];
  const found = await prisma.product.count({ where: { id: { in: ids }, tenantId: tid } });
  if (found !== ids.length) throw new HttpError(400, "One or more ingredients were not found");
}

recipesRouter.get("/", async (req, res) => {
  const recipes = await prisma.recipe.findMany({ where: { tenantId: tenantId(req) }, include: recipeInclude, orderBy: { name: "asc" } });
  res.json({ recipes });
});

recipesRouter.get("/:id", async (req, res) => {
  const recipe = await prisma.recipe.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: recipeInclude });
  if (!recipe) { res.status(404).json({ error: "Recipe not found" }); return; }
  res.json({ recipe });
});

recipesRouter.post("/", async (req, res, next) => {
  const data = recipeSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid recipe", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const { ingredients, ...rest } = data.data;
  try {
    await assertIngredientsBelongToTenant(tid, ingredients);
    const recipe = await prisma.recipe.create({
      data: { tenantId: tid, ...rest, ingredients: { create: ingredients.map((i) => ({ productId: i.productId, quantity: i.quantity })) } },
      include: recipeInclude,
    });
    res.status(201).json({ recipe });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A recipe with this name already exists" }); return; }
    next(error);
  }
});

recipesRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid recipe", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const { ingredients, ...rest } = data.data;
  try {
    const existing = await prisma.recipe.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { ingredients: { select: { productId: true, quantity: true, product: { select: { name: true, unit: true } } } } } });
    if (!existing) { res.status(404).json({ error: "Recipe not found" }); return; }
    if (ingredients) await assertIngredientsBelongToTenant(tid, ingredients);
    const recipe = await prisma.$transaction(async (tx) => {
      if (ingredients) {
        await tx.recipeIngredient.deleteMany({ where: { recipeId: existing.id } });
        if (ingredients.length) await tx.recipeIngredient.createMany({ data: ingredients.map((i) => ({ recipeId: existing.id, productId: i.productId, quantity: i.quantity })) });
      }
      return tx.recipe.update({ where: { id: existing.id }, data: rest, include: recipeInclude });
    });
    if (ingredients) {
      // What each sale uses changes stock and cost, so the ingredient list is shown before and after.
      const names = new Map((await prisma.product.findMany({ where: { tenantId: tid, id: { in: ingredients.map((i) => i.productId) } }, select: { id: true, name: true, unit: true } })).map((p) => [p.id, p]));
      const was = existing.ingredients.map((i) => `${i.product.name} ${Number(i.quantity)} ${i.product.unit}`).sort().join(", ");
      const now = ingredients.map((i) => `${names.get(i.productId)?.name ?? "?"} ${Number(i.quantity)} ${names.get(i.productId)?.unit ?? ""}`.trim()).sort().join(", ");
      if (was !== now) await logActivityAfter(req, { area: "MENU", action: "recipe.edit", target: { type: "Recipe", id: existing.id, label: existing.name }, changes: [{ field: "ingredients", label: "Ingredients", from: was || "none", to: now || "none" }], summary: `Changed the ingredients of recipe ${existing.name}` });
    }
    if (rest.name && rest.name !== existing.name) await logActivityAfter(req, { area: "MENU", action: "recipe.rename", target: { type: "Recipe", id: existing.id, label: rest.name }, changes: [{ field: "name", label: "Name", from: existing.name, to: rest.name }], summary: `Renamed recipe ${existing.name} to ${rest.name}` });
    res.json({ recipe });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A recipe with this name already exists" }); return; }
    next(error);
  }
});

recipesRouter.delete("/:id", async (req, res) => {
  const gone = await prisma.recipe.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: { id: true, name: true } });
  const deleted = await prisma.recipe.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!deleted.count || !gone) { res.status(404).json({ error: "Recipe not found" }); return; }
  await logActivityAfter(req, { area: "MENU", action: "recipe.delete", target: { type: "Recipe", id: gone.id, label: gone.name }, summary: `Deleted recipe ${gone.name}` });
  res.status(204).send();
});
