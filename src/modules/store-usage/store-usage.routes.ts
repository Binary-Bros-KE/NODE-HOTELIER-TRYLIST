import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { requirePermission } from "../../middleware/tenantContext.js";
import { nextStoreUsageNo } from "../../lib/sequence.js";
import { InsufficientStockError, recordStockMovement } from "../../lib/stockLedger.js";

// Store usage: stock the store hands out to be used up there and then - staff
// meals, a conference, a complimentary event - for any product, including ones
// also sold per dish (rice). Nothing is added to another location's stock. Each
// line is an ISSUE movement (sourceType STORE_USAGE, sourceRefId = the usage),
// which the expenses report counts as inventory consumption. Usage is grouped by
// its own categories (UsageCategory) so month-end totals line up.
export const storeUsageRouter = Router();

const tenantId = (req: { tenantId?: string }) => { if (!req.tenantId) throw new Error("Tenant context is required"); return req.tenantId; };
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
const handle = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((error) => {
    if (error instanceof InsufficientStockError) { res.status(409).json({ error: `Not enough ${error.label} in the store for this` }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A category with this name already exists" }); return; }
    next(error);
  });
};
const parse = <T extends z.ZodTypeAny>(schema: T, data: unknown, res: Response): z.infer<T> | null => {
  const result = schema.safeParse(data);
  if (!result.success) { res.status(400).json({ error: result.error.issues[0]?.message ?? "Invalid input", details: result.error.flatten() }); return null; }
  return result.data;
};
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());
const optionalDate = z.preprocess(blankToUndefined, z.coerce.date().optional());
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------- categories

const categorySchema = z.object({
  name: z.string().trim().min(1, "Give the category a name").max(80),
  description: optionalText(300),
  isActive: z.boolean().optional(),
});

storeUsageRouter.get("/categories", handle(async (req, res) => {
  const categories = await prisma.usageCategory.findMany({
    where: { tenantId: tenantId(req) },
    include: { _count: { select: { usages: true } } },
    orderBy: { name: "asc" },
  });
  res.json({ categories });
}));

storeUsageRouter.post("/categories", requirePermission("STORE_DISPATCH"), handle(async (req, res) => {
  const body = parse(categorySchema, req.body, res);
  if (!body) return;
  const category = await prisma.usageCategory.create({ data: { tenantId: tenantId(req), name: body.name, description: body.description ?? null, isActive: body.isActive ?? true } });
  res.status(201).json({ category });
}));

storeUsageRouter.patch("/categories/:id", requirePermission("STORE_DISPATCH"), handle(async (req, res) => {
  const body = parse(categorySchema.partial(), req.body, res);
  if (!body) return;
  const updated = await prisma.usageCategory.updateMany({
    where: { id: req.params.id as string, tenantId: tenantId(req) },
    data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description || null } : {}), ...(body.isActive !== undefined ? { isActive: body.isActive } : {}) },
  });
  if (!updated.count) throw httpError(404, "Category not found");
  res.json({ category: await prisma.usageCategory.findUniqueOrThrow({ where: { id: req.params.id as string } }) });
}));

/** A category that was ever used keeps its history; it can only be switched off. */
storeUsageRouter.delete("/categories/:id", requirePermission("STORE_DISPATCH"), handle(async (req, res) => {
  const category = await prisma.usageCategory.findFirst({ where: { id: req.params.id as string, tenantId: tenantId(req) }, include: { _count: { select: { usages: true } } } });
  if (!category) throw httpError(404, "Category not found");
  if (category._count.usages > 0) throw httpError(409, `"${category.name}" has been used ${category._count.usages} time${category._count.usages === 1 ? "" : "s"}, so it can't be deleted. Switch it off instead.`);
  await prisma.usageCategory.delete({ where: { id: category.id } });
  res.json({ deleted: true });
}));

// ---------------------------------------------------------------- usages

const usageInclude = {
  category: { select: { id: true, name: true } },
  fromLocation: { select: { id: true, name: true } },
  usedAtLocation: { select: { id: true, name: true } },
  items: { include: { product: { select: { id: true, unit: true, packSize: true, packLabel: true, packUnit: { select: { name: true } } } } }, orderBy: { productName: "asc" as const } },
} satisfies Prisma.StoreUsageInclude;

const listSchema = z.object({
  from: optionalDate,
  to: optionalDate,
  categoryId: optionalId,
  locationId: optionalId,
  status: z.preprocess(blankToUndefined, z.enum(["ACTIVE", "VOIDED"]).optional()),
  search: optionalText(120),
});

function usageWhere(tid: string, q: z.infer<typeof listSchema>): Prisma.StoreUsageWhereInput {
  // "to" is a day: include all of it.
  const to = q.to ? new Date(q.to.getTime() + 24 * 60 * 60 * 1000 - 1) : undefined;
  return {
    tenantId: tid,
    ...(q.status ? { status: q.status } : {}),
    ...(q.categoryId ? { categoryId: q.categoryId } : {}),
    ...(q.locationId ? { OR: [{ fromLocationId: q.locationId }, { usedAtLocationId: q.locationId }] } : {}),
    ...(q.from || to ? { usedAt: { ...(q.from ? { gte: q.from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(q.search ? { AND: [{ OR: [
      { usageNo: { contains: q.search, mode: "insensitive" } },
      { title: { contains: q.search, mode: "insensitive" } },
      { note: { contains: q.search, mode: "insensitive" } },
      { items: { some: { productName: { contains: q.search, mode: "insensitive" } } } },
    ] }] } : {}),
  };
}

storeUsageRouter.get("/", handle(async (req, res) => {
  const q = parse(listSchema, req.query, res);
  if (!q) return;
  const usages = await prisma.storeUsage.findMany({ where: usageWhere(tenantId(req), q), include: usageInclude, orderBy: [{ usedAt: "desc" }, { createdAt: "desc" }], take: 500 });
  const active = usages.filter((u) => u.status === "ACTIVE");
  res.json({ usages, summary: { count: active.length, value: round2(active.reduce((s, u) => s + Number(u.totalValue), 0)) } });
}));

/** Month-end view: value used per category, per product, per location it was used at, and every usage. */
storeUsageRouter.get("/report", handle(async (req, res) => {
  const q = parse(listSchema, req.query, res);
  if (!q) return;
  const usages = await prisma.storeUsage.findMany({ where: usageWhere(tenantId(req), { ...q, status: "ACTIVE" }), include: usageInclude, orderBy: { usedAt: "asc" } });
  const byCategory = new Map<string, { key: string; name: string; count: number; value: number }>();
  const byLocation = new Map<string, { key: string; name: string; count: number; value: number }>();
  const byProduct = new Map<string, { key: string; category: string; product: string; productId: string; quantity: number; value: number; unit: string; packSize: number; packLabel: string }>();
  for (const u of usages) {
    const value = Number(u.totalValue);
    const c = byCategory.get(u.categoryId) ?? { key: u.categoryId, name: u.category.name, count: 0, value: 0 };
    c.count += 1; c.value += value; byCategory.set(u.categoryId, c);
    const locKey = u.usedAtLocation?.id ?? "none";
    const l = byLocation.get(locKey) ?? { key: locKey, name: u.usedAtLocation?.name ?? "Not set", count: 0, value: 0 };
    l.count += 1; l.value += value; byLocation.set(locKey, l);
    for (const item of u.items) {
      const key = `${u.categoryId}:${item.productId}`;
      const p = byProduct.get(key) ?? {
        key, category: u.category.name, product: item.productName, productId: item.productId, quantity: 0, value: 0,
        unit: item.product.packUnit?.name ?? item.product.unit, packSize: Number(item.product.packSize) || 0, packLabel: item.product.packLabel ?? "",
      };
      p.quantity += Number(item.quantity); p.value += Number(item.value); byProduct.set(key, p);
    }
  }
  const money = <T extends { value: number }>(rows: T[]) => rows.map((r) => ({ ...r, value: round2(r.value) })).sort((a, b) => b.value - a.value);
  res.json({
    totals: { count: usages.length, value: round2(usages.reduce((s, u) => s + Number(u.totalValue), 0)) },
    byCategory: money([...byCategory.values()]),
    byLocation: money([...byLocation.values()]),
    byProduct: money([...byProduct.values()]).sort((a, b) => a.category.localeCompare(b.category) || b.value - a.value),
    usages,
  });
}));

const createSchema = z.object({
  categoryId: z.string().trim().min(1, "Choose what it was used for"),
  fromLocationId: z.string().trim().min(1, "Choose the store it comes from"),
  usedAtLocationId: optionalId,
  title: optionalText(140),
  note: optionalText(500),
  usedAt: optionalDate,
  lines: z.array(z.object({ productId: z.string().trim().min(1), quantity: z.coerce.number().positive() })).min(1, "Add at least one product"),
});

storeUsageRouter.post("/", requirePermission("STORE_DISPATCH"), handle(async (req, res) => {
  const body = parse(createSchema, req.body, res);
  if (!body) return;
  const tid = tenantId(req);
  const category = await prisma.usageCategory.findFirst({ where: { id: body.categoryId, tenantId: tid, isActive: true } });
  if (!category) throw httpError(400, "Choose an active usage category");
  const from = await prisma.location.findFirst({ where: { id: body.fromLocationId, tenantId: tid }, select: { id: true, name: true } });
  if (!from) throw httpError(400, "Choose the store it comes from");
  if (body.usedAtLocationId && !(await prisma.location.findFirst({ where: { id: body.usedAtLocationId, tenantId: tid }, select: { id: true } }))) throw httpError(400, "Choose where it was used");
  // One line per product.
  const merged = new Map<string, number>();
  for (const line of body.lines) merged.set(line.productId, (merged.get(line.productId) ?? 0) + line.quantity);
  const products = await prisma.product.findMany({ where: { tenantId: tid, id: { in: [...merged.keys()] } }, select: { id: true, name: true } });
  if (products.length !== merged.size) throw httpError(400, "One of the products was not found");
  const names = new Map(products.map((p) => [p.id, p.name]));

  const usageNo = await nextStoreUsageNo(tid);
  const usage = await prisma.$transaction(async (tx) => {
    const created = await tx.storeUsage.create({
      data: {
        tenantId: tid, usageNo, categoryId: category.id, fromLocationId: from.id, usedAtLocationId: body.usedAtLocationId ?? null,
        title: body.title ?? null, note: body.note ?? null, usedAt: body.usedAt ?? new Date(), createdBy: req.userId ?? null,
      },
    });
    let total = 0;
    for (const [productId, quantity] of merged) {
      const movement = await recordStockMovement(tx, {
        tenantId: tid, productId, locationId: from.id, type: "ISSUE", quantity: -quantity,
        note: `${usageNo} - ${category.name}${body.title ? `: ${body.title}` : ""}`,
        sourceType: "STORE_USAGE", sourceRefId: created.id, performedBy: req.userId ?? null,
        occurredAt: body.usedAt, label: names.get(productId) ?? "this product",
      });
      const value = round2(Number(movement.value ?? 0));
      total += value;
      await tx.storeUsageItem.create({
        data: { usageId: created.id, productId, productName: names.get(productId) ?? "", quantity, unitCost: movement.unitCost ?? null, value },
      });
    }
    await tx.storeUsage.update({ where: { id: created.id }, data: { totalValue: round2(total) } });
    return tx.storeUsage.findUniqueOrThrow({ where: { id: created.id }, include: usageInclude });
  });
  res.status(201).json({ usage });
}));

/** Puts the stock back in the store it came from. The usage stays, marked voided. */
storeUsageRouter.post("/:id/void", requirePermission("STORE_DISPATCH"), handle(async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().min(1, "Give a reason for voiding").max(500) }), req.body, res);
  if (!body) return;
  const tid = tenantId(req);
  const usage = await prisma.storeUsage.findFirst({ where: { id: req.params.id as string, tenantId: tid }, include: { items: true } });
  if (!usage) throw httpError(404, "Usage not found");
  if (usage.status === "VOIDED") throw httpError(409, "This usage is already voided");
  const voided = await prisma.$transaction(async (tx) => {
    const claimed = await tx.storeUsage.updateMany({ where: { id: usage.id, status: "ACTIVE" }, data: { status: "VOIDED", voidReason: body.reason, voidedBy: req.userId ?? null, voidedAt: new Date() } });
    if (!claimed.count) throw httpError(409, "This usage is already voided");
    for (const item of usage.items) {
      await recordStockMovement(tx, {
        tenantId: tid, productId: item.productId, locationId: usage.fromLocationId, type: "RETURN", quantity: Number(item.quantity),
        unitCost: item.unitCost != null ? Number(item.unitCost) : null,
        note: `${usage.usageNo} voided: ${body.reason}`, sourceType: "STORE_USAGE_VOID", sourceRefId: usage.id, performedBy: req.userId ?? null,
      });
    }
    return tx.storeUsage.findUniqueOrThrow({ where: { id: usage.id }, include: usageInclude });
  });
  res.json({ usage: voided });
}));
