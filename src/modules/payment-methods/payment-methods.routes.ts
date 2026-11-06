import { Router } from "express";
import { logActivityAfter, changedFields } from "../../lib/activity.js";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { partialNoDefaults } from "../../lib/zod.js";

// Tenant-configurable ways a customer can pay — used wherever a payment is
// actually taken (Reception folio deposits/checkout, POS bill settlement).
// Cross-cutting config like locations/categories, not owned by one module.
export const paymentMethodsRouter = Router();

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  code: z.string().trim().min(2).max(30).transform((v) => v.toUpperCase().replace(/[^A-Z0-9]+/g, "_")),
  description: optionalText(255),
  requiresReference: z.boolean().default(false),
  sortOrder: z.coerce.number().int().default(0),
});
// code is a stable join key once created — never editable after the fact.
const updateSchema = partialNoDefaults(createSchema).omit({ code: true });

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const publicFields = {
  id: true,
  name: true,
  code: true,
  description: true,
  isSystem: true,
  isActive: true,
  requiresReference: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { folioPayments: true, posPayments: true, transactions: true } },
} as const;

paymentMethodsRouter.get("/", async (req, res) => {
  const activeOnly = req.query.activeOnly === "true";
  const methods = await prisma.paymentMethod.findMany({
    where: { tenantId: tenantId(req), ...(activeOnly ? { isActive: true } : {}) },
    select: publicFields,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  res.json({ methods });
});

paymentMethodsRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid payment method", details: data.error.flatten() }); return; }
  try {
    const method = await prisma.paymentMethod.create({ data: { tenantId: tenantId(req), ...data.data }, select: publicFields });
    await logActivityAfter(req, { area: "SETTINGS", action: "payment_method.create", target: { type: "PaymentMethod", id: method.id, label: method.name }, summary: `Added payment method ${method.name}` });
    res.status(201).json({ method });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A payment method with this name or code already exists" }); return; }
    next(error);
  }
});

paymentMethodsRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid payment method", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const before = await prisma.paymentMethod.findFirst({ where: { id: req.params.id, tenantId: tid } });
    const updated = await prisma.paymentMethod.updateMany({ where: { id: req.params.id, tenantId: tid }, data: data.data });
    if (!updated.count || !before) { res.status(404).json({ error: "Payment method not found" }); return; }
    const method = await prisma.paymentMethod.findUniqueOrThrow({ where: { id: req.params.id }, select: publicFields });
    const changes = changedFields(before as unknown as Record<string, unknown>, method as unknown as Record<string, unknown>, { name: "Name", code: "Code", isActive: "Active", requiresReference: "Needs a reference" });
    if (changes.length) await logActivityAfter(req, { area: "SETTINGS", action: "payment_method.edit", target: { type: "PaymentMethod", id: before.id, label: before.name }, changes, summary: `Changed payment method ${before.name}` });
    res.json({ method });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A payment method with this name already exists" }); return; }
    next(error);
  }
});

paymentMethodsRouter.delete("/:id", async (req, res) => {
  const tid = tenantId(req);
  const existing = await prisma.paymentMethod.findFirst({ where: { id: req.params.id, tenantId: tid }, select: publicFields });
  if (!existing) { res.status(404).json({ error: "Payment method not found" }); return; }
  if (existing.isSystem) { res.status(409).json({ error: "Built-in payment methods can be disabled but not deleted" }); return; }
  if (existing._count.folioPayments + existing._count.posPayments + existing._count.transactions > 0) {
    res.status(409).json({ error: "This payment method has recorded payments and can't be deleted — disable it instead" });
    return;
  }
  await prisma.paymentMethod.delete({ where: { id: existing.id } });
  await logActivityAfter(req, { area: "SETTINGS", action: "payment_method.delete", target: { type: "PaymentMethod", id: existing.id, label: existing.name }, summary: `Deleted payment method ${existing.name}` });
  res.status(204).send();
});
