import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { partialNoDefaults } from "../../lib/zod.js";

// Deliberately flat, cross-cutting tenant config (like service categories) —
// expense categories can't be predicted upfront and need full CRUD.
export const expenseCategoriesRouter = Router();

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: optionalText(255),
  isActive: z.boolean().default(true),
});
const updateSchema = partialNoDefaults(createSchema);

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

// A brand-new workspace starts with a handful of everyday categories so the
// first expense never hits an "add a category first" wall. Only seeded when the
// tenant has none at all, so anything they add or rename is never overwritten.
const DEFAULT_CATEGORIES = [
  { name: "Transport", description: "Fares, fuel, deliveries" },
  { name: "Supplies", description: "Cleaning, stationery, consumables" },
  { name: "Utilities", description: "Power, water, internet, airtime" },
  { name: "Repairs & Maintenance", description: "Fixes, spare parts, servicing" },
  { name: "Miscellaneous", description: "Anything that doesn't fit elsewhere" },
];

expenseCategoriesRouter.get("/", async (req, res) => {
  const tid = tenantId(req);
  if ((await prisma.expenseCategory.count({ where: { tenantId: tid } })) === 0) {
    await prisma.expenseCategory.createMany({ data: DEFAULT_CATEGORIES.map((c) => ({ tenantId: tid, ...c })), skipDuplicates: true });
  }
  const categories = await prisma.expenseCategory.findMany({
    where: { tenantId: tid },
    select: { id: true, name: true, description: true, isActive: true, createdAt: true, updatedAt: true, _count: { select: { expenses: true } } },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
  res.json({ categories });
});

expenseCategoriesRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid expense category", details: data.error.flatten() }); return; }
  try {
    const category = await prisma.expenseCategory.create({ data: { tenantId: tenantId(req), ...data.data } });
    res.status(201).json({ category });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "An expense category with this name already exists" }); return; }
    next(error);
  }
});

expenseCategoriesRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid expense category", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const updated = await prisma.expenseCategory.updateMany({ where: { id: req.params.id, tenantId: tid }, data: data.data });
    if (!updated.count) { res.status(404).json({ error: "Expense category not found" }); return; }
    const category = await prisma.expenseCategory.findUniqueOrThrow({ where: { id: req.params.id } });
    res.json({ category });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "An expense category with this name already exists" }); return; }
    next(error);
  }
});

expenseCategoriesRouter.delete("/:id", async (req, res) => {
  const tid = tenantId(req);
  const existing = await prisma.expenseCategory.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, _count: { select: { expenses: true } } } });
  if (!existing) { res.status(404).json({ error: "Expense category not found" }); return; }
  if (existing._count.expenses > 0) { res.status(409).json({ error: "Reassign or remove its expenses first" }); return; }
  await prisma.expenseCategory.delete({ where: { id: existing.id } });
  res.status(204).send();
});
