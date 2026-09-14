import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { nextPurchaseNo, nextRequisitionNo } from "../../lib/sequence.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { hasPermission, requirePermission } from "../../middleware/tenantContext.js";
import { stockQuantityToCostUnits } from "../../lib/stockValuation.js";

// Purchase requisitions — someone raises a request to buy items (product +
// quantity only — they never see or set cost), someone else reviews it
// (setting the estimated cost as part of that review) and either rejects it
// or approves and converts it into a Purchase (PO). A document only; no
// stock or ledger side effects. Line items must reference catalog Products.
// No requireModule gate, matching assets/expenses/suppliers/purchases.
//
// Who can do which half is REQUISITION_CREATE / REQUISITION_APPROVE
// (Role.permissions), not a hardcoded role name — a property might want its
// Storekeeper or Barman raising requests and its Accountant approving them,
// or a Storekeeper doing both; Roles & Permissions decides, not this file.
export const purchaseRequisitionsRouter = Router();

const REQUISITION_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "CONVERTED", "CANCELLED"] as const;
type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());
const optionalDate = z.preprocess(blankToUndefined, z.coerce.date().optional());

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

const lineSchema = z.object({
  productId: z.string().trim().min(1),
  quantity: z.coerce.number().positive(),
  estimatedUnitCost: z.coerce.number().min(0).default(0),
  note: optionalText(255),
});

const createSchema = z.object({
  requisitionDate: optionalDate,
  neededBy: optionalDate,
  purpose: optionalText(255),
  notes: optionalText(500),
  suggestedSupplierId: optionalId,
  items: z.array(lineSchema).min(1, "Add at least one item"),
});
const updateSchema = partialNoDefaults(createSchema).extend({
  items: z.array(lineSchema).min(1).optional(),
});

const statusSchema = z.object({
  status: z.enum(["SUBMITTED", "APPROVED", "REJECTED", "CANCELLED", "DRAFT"]),
  note: optionalText(500),
});

const convertSchema = z.object({
  supplierId: z.string().trim().min(1),
  expectedDate: optionalDate,
  reference: optionalText(120),
  notes: optionalText(500),
});

const requisitionInclude = {
  suggestedSupplier: { select: { id: true, name: true } },
  purchase: { select: { id: true, purchaseNo: true, status: true } },
  items: { include: { product: { select: { id: true, name: true, unit: true, packSize: true, packLabel: true, packUnit: { select: { id: true, name: true } } } } }, orderBy: { createdAt: "asc" } },
  reviewedByEmployee: { select: { id: true, firstName: true, lastName: true } },
  createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
  updatedByEmployee: { select: { id: true, firstName: true, lastName: true } },
} as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

function lineTaxAmount(lineTotal: number, taxRate: number, taxTreatment: "STANDARD" | "ZERO_RATED" | "EXEMPT") {
  if (taxTreatment !== "STANDARD" || taxRate <= 0) return 0;
  return round2(lineTotal - lineTotal / (1 + taxRate / 100));
}

function withLineTotals<T extends { quantity: number; estimatedUnitCost: number; packSize?: Prisma.Decimal | number | null }>(items: T[]) {
  const lines = items.map((i) => ({ ...i, lineTotal: round2(stockQuantityToCostUnits(i.quantity, i.packSize) * i.estimatedUnitCost) }));
  const estimatedTotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
  return { lines, estimatedTotal };
}

async function productsForLines(tid: string, items: { productId: string }[]) {
  const ids = [...new Set(items.map((i) => i.productId))];
  const products = await prisma.product.findMany({ where: { id: { in: ids }, tenantId: tid }, select: { id: true, packSize: true } });
  if (products.length !== ids.length) throw new HttpError(400, "One or more items reference a product that was not found");
  return new Map(products.map((product) => [product.id, product]));
}

async function assertSupplier(tid: string, supplierId: string) {
  const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, tenantId: tid }, select: { id: true, isActive: true } });
  if (!supplier) throw new HttpError(400, "Supplier not found");
  if (!supplier.isActive) throw new HttpError(400, "That supplier is inactive");
}

async function assertCanReview(req: { tenantId?: string; userId?: string }) {
  const tid = tenantId(req);
  const allowed = await hasPermission(tid, req.userId, "REQUISITION_APPROVE");
  if (!allowed) throw new HttpError(403, "You don't have permission to approve or reject a requisition");
}

/** Cost (estimated unit cost, line total, requisition total) is only for
 * whoever can approve — the raiser only ever deals in product + quantity.
 * Rather than trust the client to hide a field the API already sent, this
 * strips it server-side for anyone without REQUISITION_APPROVE. */
function redactCostIfNeeded<T extends { estimatedTotal: unknown; items: { estimatedUnitCost: unknown; lineTotal: unknown }[] }>(
  requisition: T,
  canSeeCost: boolean,
): T {
  if (canSeeCost) return requisition;
  return {
    ...requisition,
    estimatedTotal: null,
    items: requisition.items.map((i) => ({ ...i, estimatedUnitCost: null, lineTotal: null })),
  };
}

// Allowed status transitions. CONVERTED is set only by POST /:id/convert.
const ALLOWED_TRANSITIONS: Record<RequisitionStatus, RequisitionStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["CANCELLED"],
  REJECTED: ["DRAFT", "CANCELLED"],
  CONVERTED: [],
  CANCELLED: [],
};

purchaseRequisitionsRouter.get("/", async (req, res, next) => {
  try {
    const query = z.object({
      search: optionalText(120),
      status: z.enum(REQUISITION_STATUSES).optional(),
    }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid requisition filters", details: query.error.flatten() }); return; }
    const { search, status } = query.data;
    const tid = tenantId(req);
    const where: Prisma.PurchaseRequisitionWhereInput = {
      tenantId: tid,
      ...(status ? { status } : {}),
      ...(search ? { OR: [
        { requisitionNo: { contains: search, mode: "insensitive" } },
        { purpose: { contains: search, mode: "insensitive" } },
      ] } : {}),
    };
    const [requisitions, canSeeCost] = await Promise.all([
      prisma.purchaseRequisition.findMany({ where, include: requisitionInclude, orderBy: { createdAt: "desc" } }),
      hasPermission(tid, req.userId, "REQUISITION_APPROVE"),
    ]);
    const byStatus = Object.fromEntries(REQUISITION_STATUSES.map((s) => [s, 0])) as Record<RequisitionStatus, number>;
    for (const r of requisitions) byStatus[r.status] += 1;
    const awaitingReview = byStatus.SUBMITTED;
    res.json({ requisitions: requisitions.map((r) => redactCostIfNeeded(r, canSeeCost)), summary: { total: requisitions.length, byStatus, awaitingReview } });
  } catch (error) {
    next(error);
  }
});

purchaseRequisitionsRouter.get("/:id", async (req, res, next) => {
  try {
    const tid = tenantId(req);
    const [requisition, canSeeCost] = await Promise.all([
      prisma.purchaseRequisition.findFirst({ where: { id: req.params.id, tenantId: tid }, include: requisitionInclude }),
      hasPermission(tid, req.userId, "REQUISITION_APPROVE"),
    ]);
    if (!requisition) { res.status(404).json({ error: "Requisition not found" }); return; }
    res.json({ requisition: redactCostIfNeeded(requisition, canSeeCost) });
  } catch (error) {
    next(error);
  }
});

purchaseRequisitionsRouter.post("/", requirePermission("REQUISITION_CREATE"), async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid requisition", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const { items, requisitionDate, suggestedSupplierId, ...rest } = data.data;
  try {
    const productsById = await productsForLines(tid, items);
    if (suggestedSupplierId) await assertSupplier(tid, suggestedSupplierId);
    const { lines, estimatedTotal } = withLineTotals(items.map((item) => ({ ...item, packSize: productsById.get(item.productId)?.packSize ?? null })));
    const requisitionNo = await nextRequisitionNo(tid);
    const requisition = await prisma.purchaseRequisition.create({
      data: {
        tenantId: tid,
        requisitionNo,
        estimatedTotal,
        suggestedSupplierId,
        createdBy: req.userId,
        ...(requisitionDate ? { requisitionDate } : {}),
        ...rest,
        items: { create: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, estimatedUnitCost: l.estimatedUnitCost, lineTotal: l.lineTotal, note: l.note })) },
      },
      include: requisitionInclude,
    });
    const canSeeCost = await hasPermission(tid, req.userId, "REQUISITION_APPROVE");
    res.status(201).json({ requisition: redactCostIfNeeded(requisition, canSeeCost) });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "That requisition number is taken — try again" }); return; }
    next(error);
  }
});

// A DRAFT/REJECTED requisition is the raiser's own editable document (needs
// REQUISITION_CREATE). Once SUBMITTED, only a reviewer (REQUISITION_APPROVE)
// can still touch it — that's how cost gets set, since the raiser never
// enters it. Anything else (APPROVED/CONVERTED/CANCELLED) is final.
purchaseRequisitionsRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid requisition", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const existing = await prisma.purchaseRequisition.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { items: { include: { product: { select: { packSize: true } } } } } });
    if (!existing) { res.status(404).json({ error: "Requisition not found" }); return; }
    if (existing.status === "DRAFT" || existing.status === "REJECTED") {
      const allowed = await hasPermission(tid, req.userId, "REQUISITION_CREATE");
      if (!allowed) { res.status(403).json({ error: "You don't have permission to edit a requisition" }); return; }
    } else if (existing.status === "SUBMITTED") {
      await assertCanReview(req);
    } else {
      res.status(409).json({ error: `A ${existing.status.toLowerCase()} requisition can no longer be edited` });
      return;
    }
    const { items, requisitionDate, suggestedSupplierId, ...rest } = data.data;
    const productsById = items ? await productsForLines(tid, items) : null;
    if (suggestedSupplierId) await assertSupplier(tid, suggestedSupplierId);

    const effectiveItems = items
      ? items.map((item) => ({ ...item, packSize: productsById?.get(item.productId)?.packSize ?? null }))
      : existing.items.map((i) => ({
        productId: i.productId,
        quantity: Number(i.quantity),
        estimatedUnitCost: Number(i.estimatedUnitCost),
        note: i.note ?? undefined,
        packSize: i.product.packSize,
      }));
    const { lines, estimatedTotal } = withLineTotals(effectiveItems);

    const requisition = await prisma.$transaction(async (tx) => {
      if (items) {
        await tx.purchaseRequisitionItem.deleteMany({ where: { requisitionId: existing.id } });
        await tx.purchaseRequisitionItem.createMany({ data: lines.map((l) => ({ requisitionId: existing.id, productId: l.productId, quantity: l.quantity, estimatedUnitCost: l.estimatedUnitCost, lineTotal: l.lineTotal, note: l.note })) });
      }
      return tx.purchaseRequisition.update({
        where: { id: existing.id },
        data: {
          ...rest,
          ...(requisitionDate ? { requisitionDate } : {}),
          ...(suggestedSupplierId !== undefined ? { suggestedSupplierId } : {}),
          estimatedTotal,
          updatedBy: req.userId,
        },
        include: requisitionInclude,
      });
    });
    const canSeeCost = await hasPermission(tid, req.userId, "REQUISITION_APPROVE");
    res.json({ requisition: redactCostIfNeeded(requisition, canSeeCost) });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  }
});

purchaseRequisitionsRouter.post("/:id/status", async (req, res, next) => {
  const data = statusSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid status change", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const existing = await prisma.purchaseRequisition.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!existing) { res.status(404).json({ error: "Requisition not found" }); return; }
    const { status, note } = data.data;
    const from = existing.status as RequisitionStatus;
    if (status === from) { res.status(409).json({ error: `This requisition is already ${status.toLowerCase()}` }); return; }
    if (!ALLOWED_TRANSITIONS[from].includes(status)) {
      res.status(409).json({ error: `Cannot move a ${from.toLowerCase()} requisition to ${status.toLowerCase()}` });
      return;
    }

    const isReview = status === "APPROVED" || status === "REJECTED";
    if (isReview) {
      await assertCanReview(req);
      if (status === "REJECTED" && !note?.trim()) { res.status(400).json({ error: "Give a reason when rejecting a requisition" }); return; }
    } else {
      // SUBMITTED / CANCELLED / DRAFT (reopen) — the raiser's own action.
      const allowed = await hasPermission(tid, req.userId, "REQUISITION_CREATE");
      if (!allowed) { res.status(403).json({ error: "You don't have permission to change this requisition's status" }); return; }
    }

    const requisition = await prisma.purchaseRequisition.update({
      where: { id: existing.id },
      data: {
        status,
        updatedBy: req.userId,
        ...(status === "SUBMITTED" ? { submittedAt: new Date() } : {}),
        ...(isReview ? { reviewedBy: req.userId, reviewedAt: new Date(), reviewNote: note ?? null } : {}),
        ...(status === "DRAFT" ? { reviewedBy: null, reviewedAt: null, reviewNote: null, submittedAt: null } : {}),
      },
      include: requisitionInclude,
    });
    const canSeeCost = await hasPermission(tid, req.userId, "REQUISITION_APPROVE");
    res.json({ requisition: redactCostIfNeeded(requisition, canSeeCost) });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  }
});

/** Raise a DRAFT Purchase (PO) from an APPROVED requisition, copying its
 * line items (estimated unit cost becomes the PO's starting unit cost) and
 * marking the requisition CONVERTED. One requisition -> at most one PO. */
purchaseRequisitionsRouter.post("/:id/convert", requirePermission("REQUISITION_APPROVE"), async (req, res, next) => {
  const data = convertSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid conversion", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const id = req.params.id as string;
  const { supplierId, expectedDate, reference, notes } = data.data;
  try {
    const existing = await prisma.purchaseRequisition.findFirst({
      where: { id, tenantId: tid },
      include: { items: { include: { product: { select: { packSize: true, taxRate: true, taxTreatment: true } } } } },
    });
    if (!existing) { res.status(404).json({ error: "Requisition not found" }); return; }
    if (existing.status !== "APPROVED") { res.status(409).json({ error: "Only an approved requisition can be converted to a purchase" }); return; }
    await assertSupplier(tid, supplierId);

    const lines = existing.items.map((i) => ({
      productId: i.productId,
      quantity: Number(i.quantity),
      unitCost: Number(i.estimatedUnitCost),
      taxRate: i.product.taxRate != null ? Number(i.product.taxRate) : 16,
      taxTreatment: i.product.taxTreatment ?? "STANDARD",
      lineTotal: round2(stockQuantityToCostUnits(i.quantity, i.product.packSize) * Number(i.estimatedUnitCost)),
      note: i.note ?? undefined,
    }));
    const linesWithTax = lines.map((line) => ({ ...line, taxAmount: lineTaxAmount(line.lineTotal, line.taxRate, line.taxTreatment) }));
    const total = round2(linesWithTax.reduce((sum, l) => sum + l.lineTotal, 0));
    const taxAmount = round2(linesWithTax.reduce((sum, l) => sum + l.taxAmount, 0));
    const subtotal = round2(total - taxAmount);
    const purchaseNo = await nextPurchaseNo(tid);

    const purchase = await prisma.$transaction(async (tx) => {
      const created = await tx.purchase.create({
        data: {
          tenantId: tid,
          purchaseNo,
          supplierId,
          status: "DRAFT",
          taxRate: 0,
          subtotal,
          taxAmount,
          total,
          expectedDate,
          reference,
          notes,
          requisitionId: existing.id,
          createdBy: req.userId,
          items: { create: linesWithTax.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost, taxRate: l.taxRate, taxTreatment: l.taxTreatment, taxAmount: l.taxAmount, lineTotal: l.lineTotal, note: l.note })) },
        },
        include: {
          supplier: { select: { id: true, name: true } },
          items: { include: { product: { select: { id: true, name: true, unit: true } } }, orderBy: { createdAt: "asc" } },
        },
      });
      await tx.purchaseRequisition.update({ where: { id: existing.id }, data: { status: "CONVERTED", updatedBy: req.userId } });
      return created;
    });
    res.status(201).json({ purchase });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "This requisition already has a purchase" }); return; }
    next(error);
  }
});

purchaseRequisitionsRouter.delete("/:id", requirePermission("REQUISITION_CREATE"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.purchaseRequisition.findFirst({ where: { id, tenantId: tenantId(req) }, select: { id: true, status: true } });
    if (!existing) { res.status(404).json({ error: "Requisition not found" }); return; }
    if (existing.status !== "DRAFT") { res.status(409).json({ error: "Only a draft requisition can be deleted — cancel it instead" }); return; }
    await prisma.purchaseRequisition.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
