import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { nextPurchaseNo, nextGoodsReceiptNo } from "../../lib/sequence.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { recordStockMovement, InsufficientStockError } from "../../lib/stockLedger.js";

// Mirrors the PurchaseStatus enum in schema.prisma — kept as a local literal
// list to match how every other module validates enums (never importing the
// Prisma enum into Zod).
const PURCHASE_STATUSES = ["DRAFT", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"] as const;
type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

// Purchase orders raised against a supplier. Stock only moves, and the
// supplier balance only grows, once a GoodsReceipt is posted against a PO
// (see POST /:id/goods-receipts below) — RECEIVED/PARTIALLY_RECEIVED are
// computed from those receipts, never set by hand. No requireModule gate,
// matching assets/expenses/suppliers.
export const purchasesRouter = Router();

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
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
  unitCost: z.coerce.number().min(0).default(0),
  note: optionalText(255),
});

const createSchema = z.object({
  supplierId: z.string().trim().min(1),
  locationId: optionalText(60),
  orderDate: optionalDate,
  expectedDate: optionalDate,
  reference: optionalText(120),
  notes: optionalText(500),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  items: z.array(lineSchema).min(1, "Add at least one item"),
});
// Header fields stay editable while DRAFT; items are replaced wholesale when
// provided. Status changes go through POST /:id/status, not here.
const updateSchema = partialNoDefaults(createSchema).extend({
  items: z.array(lineSchema).min(1).optional(),
});

// PARTIALLY_RECEIVED/RECEIVED are computed from real GoodsReceipt postings
// (see POST /:id/goods-receipts) — this endpoint can never set them by hand.
const MANUAL_STATUSES = ["ORDERED", "CANCELLED"] as const;
const statusSchema = z.object({
  status: z.enum(MANUAL_STATUSES),
  note: optionalText(500),
});

const purchaseInclude = {
  supplier: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  requisition: { select: { id: true, requisitionNo: true } },
  items: { include: { product: { select: { id: true, name: true, unit: true, packSize: true, packLabel: true, packUnit: { select: { id: true, name: true } } } } }, orderBy: { createdAt: "asc" } },
  createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
  updatedByEmployee: { select: { id: true, firstName: true, lastName: true } },
  goodsReceipts: {
    include: {
      location: { select: { id: true, name: true } },
      createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
      items: { select: { id: true, productId: true, quantity: true, unitCost: true, note: true } },
    },
    orderBy: { receivedAt: "desc" },
  },
} as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

function computeTotals<T extends { quantity: number; unitCost: number }>(items: T[], taxRate: number) {
  const lines = items.map((i) => ({ ...i, lineTotal: round2(i.quantity * i.unitCost) }));
  const subtotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
  const taxAmount = round2(subtotal * (taxRate / 100));
  const total = round2(subtotal + taxAmount);
  return { lines, subtotal, taxAmount, total };
}

async function assertSupplier(tid: string, supplierId: string) {
  const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, tenantId: tid }, select: { id: true, isActive: true } });
  if (!supplier) throw new HttpError(400, "Supplier not found");
  if (!supplier.isActive) throw new HttpError(400, "That supplier is inactive");
}

async function assertProducts(tid: string, items: { productId: string }[]) {
  const ids = [...new Set(items.map((i) => i.productId))];
  const found = await prisma.product.count({ where: { id: { in: ids }, tenantId: tid } });
  if (found !== ids.length) throw new HttpError(400, "One or more items reference a product that was not found");
}

async function assertLocation(tid: string, locationId: string) {
  const location = await prisma.location.findFirst({ where: { id: locationId, tenantId: tid }, select: { id: true, name: true } });
  if (!location) throw new HttpError(400, "Choose a location from this property");
  return location;
}

// Which statuses each status may move to via the manual /status endpoint.
// RECEIVED/PARTIALLY_RECEIVED are computed elsewhere and never appear here;
// RECEIVED and CANCELLED are terminal.
const ALLOWED_TRANSITIONS: Record<PurchaseStatus, (typeof MANUAL_STATUSES)[number][]> = {
  DRAFT: ["ORDERED", "CANCELLED"],
  ORDERED: ["CANCELLED"],
  PARTIALLY_RECEIVED: ["CANCELLED"],
  RECEIVED: [],
  CANCELLED: [],
};

purchasesRouter.get("/", async (req, res, next) => {
  try {
    const query = z.object({
      search: optionalText(120),
      status: z.enum(PURCHASE_STATUSES).optional(),
      supplierId: z.string().trim().optional(),
    }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid purchase filters", details: query.error.flatten() }); return; }
    const { search, status, supplierId } = query.data;
    const tid = tenantId(req);
    const where: Prisma.PurchaseWhereInput = {
      tenantId: tid,
      ...(status ? { status } : {}),
      ...(supplierId ? { supplierId } : {}),
      ...(search ? { OR: [
        { purchaseNo: { contains: search, mode: "insensitive" } },
        { reference: { contains: search, mode: "insensitive" } },
        { supplier: { name: { contains: search, mode: "insensitive" } } },
      ] } : {}),
    };
    const purchases = await prisma.purchase.findMany({ where, include: purchaseInclude, orderBy: { createdAt: "desc" } });
    const byStatus = Object.fromEntries(PURCHASE_STATUSES.map((s) => [s, 0])) as Record<PurchaseStatus, number>;
    for (const p of purchases) byStatus[p.status] += 1;
    const openValue = purchases.filter((p) => p.status === "DRAFT" || p.status === "ORDERED").reduce((sum, p) => sum + Number(p.total), 0);
    res.json({ purchases, summary: { total: purchases.length, byStatus, openValue } });
  } catch (error) {
    next(error);
  }
});

purchasesRouter.get("/:id", async (req, res, next) => {
  try {
    const purchase = await prisma.purchase.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: purchaseInclude });
    if (!purchase) { res.status(404).json({ error: "Purchase not found" }); return; }
    res.json({ purchase });
  } catch (error) {
    next(error);
  }
});

purchasesRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid purchase", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const { supplierId, items, taxRate, orderDate, ...rest } = data.data;
  try {
    await assertSupplier(tid, supplierId);
    await assertProducts(tid, items);
    if (rest.locationId) await assertLocation(tid, rest.locationId);
    const { lines, subtotal, taxAmount, total } = computeTotals(items, taxRate);
    const purchaseNo = await nextPurchaseNo(tid);
    const purchase = await prisma.purchase.create({
      data: {
        tenantId: tid,
        purchaseNo,
        supplierId,
        taxRate,
        subtotal,
        taxAmount,
        total,
        createdBy: req.userId,
        ...(orderDate ? { orderDate } : {}),
        ...rest,
        items: { create: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost, lineTotal: l.lineTotal, note: l.note })) },
      },
      include: purchaseInclude,
    });
    res.status(201).json({ purchase });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "That purchase number is taken — try again" }); return; }
    next(error);
  }
});

purchasesRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid purchase", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const existing = await prisma.purchase.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { items: true } });
    if (!existing) { res.status(404).json({ error: "Purchase not found" }); return; }
    if (existing.status !== "DRAFT") { res.status(409).json({ error: `A ${existing.status.toLowerCase()} purchase can no longer be edited` }); return; }

    const { supplierId, items, taxRate, orderDate, ...rest } = data.data;
    if (supplierId) await assertSupplier(tid, supplierId);
    if (items) await assertProducts(tid, items);
    if (rest.locationId) await assertLocation(tid, rest.locationId);

    const effectiveTaxRate = taxRate ?? Number(existing.taxRate);
    const effectiveItems = (items ?? existing.items.map((i) => ({ productId: i.productId, quantity: Number(i.quantity), unitCost: Number(i.unitCost), note: i.note ?? undefined })));
    const { lines, subtotal, taxAmount, total } = computeTotals(effectiveItems, effectiveTaxRate);

    const purchase = await prisma.$transaction(async (tx) => {
      if (items) {
        await tx.purchaseItem.deleteMany({ where: { purchaseId: existing.id } });
        await tx.purchaseItem.createMany({ data: lines.map((l) => ({ purchaseId: existing.id, productId: l.productId, quantity: l.quantity, unitCost: l.unitCost, lineTotal: l.lineTotal, note: l.note })) });
      }
      return tx.purchase.update({
        where: { id: existing.id },
        data: {
          ...rest,
          ...(supplierId ? { supplierId } : {}),
          ...(orderDate ? { orderDate } : {}),
          taxRate: effectiveTaxRate,
          subtotal,
          taxAmount,
          total,
          updatedBy: req.userId,
        },
        include: purchaseInclude,
      });
    });
    res.json({ purchase });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  }
});

purchasesRouter.post("/:id/status", async (req, res, next) => {
  const data = statusSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid status change", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const existing = await prisma.purchase.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!existing) { res.status(404).json({ error: "Purchase not found" }); return; }
    const { status, note } = data.data;
    if (status === existing.status) { res.status(409).json({ error: `This purchase is already ${status.toLowerCase()}` }); return; }
    if (!ALLOWED_TRANSITIONS[existing.status].includes(status)) {
      res.status(409).json({ error: `Cannot move a ${existing.status.toLowerCase()} purchase to ${status.toLowerCase()}` });
      return;
    }
    const purchase = await prisma.purchase.update({
      where: { id: existing.id },
      data: {
        status,
        updatedBy: req.userId,
        ...(note ? { notes: note } : {}),
        ...(status === "ORDERED" ? { orderedAt: new Date() } : {}),
      },
      include: purchaseInclude,
    });
    res.json({ purchase });
  } catch (error) {
    next(error);
  }
});

const receiptLineSchema = z.object({
  purchaseItemId: z.string().trim().min(1),
  quantity: z.coerce.number().positive(),
  // Defaults to the PO line's cost — override when the invoice differs
  // (this is the cost that lands in the stock ledger and the supplier bill).
  unitCost: z.coerce.number().min(0).optional(),
  note: optionalText(255),
});

const receiptSchema = z.object({
  locationId: z.string().trim().min(1),
  receivedAt: optionalDate,
  note: optionalText(500),
  items: z.array(receiptLineSchema).min(1, "Add at least one item"),
});

/** Lists the delivery events already posted against one PO — the receiving
 * history shown on its detail view. (GET /:id already nests these too;
 * this is a lighter-weight fetch for refreshing just the history panel.) */
purchasesRouter.get("/:id/goods-receipts", async (req, res, next) => {
  try {
    const tid = tenantId(req);
    const purchase = await prisma.purchase.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!purchase) { res.status(404).json({ error: "Purchase not found" }); return; }
    const receipts = await prisma.goodsReceipt.findMany({
      where: { purchaseId: purchase.id, tenantId: tid },
      include: {
        location: { select: { id: true, name: true } },
        createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
        items: { include: { product: { select: { id: true, name: true, unit: true, packSize: true, packLabel: true, packUnit: { select: { id: true, name: true } } } } } },
      },
      orderBy: { receivedAt: "desc" },
    });
    res.json({ receipts });
  } catch (error) {
    next(error);
  }
});

/** Posts one delivery against a PO — the only path by which a PO's stock
 * actually lands anywhere. Supports partial and repeated (multi-delivery)
 * receiving: each call only needs to cover what showed up this time, and
 * the PO's status (PARTIALLY_RECEIVED / RECEIVED) is recomputed from the
 * running totals afterward. Every line posts a real PURCHASE movement via
 * recordStockMovement and grows what's owed to the supplier. */
purchasesRouter.post("/:id/goods-receipts", async (req, res, next) => {
  const data = receiptSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid goods receipt", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const purchase = await prisma.purchase.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { items: { include: { product: { select: { id: true, name: true } } } } } });
    if (!purchase) { res.status(404).json({ error: "Purchase not found" }); return; }
    if (purchase.status !== "ORDERED" && purchase.status !== "PARTIALLY_RECEIVED") {
      res.status(409).json({ error: `A ${purchase.status.toLowerCase().replace("_", " ")} purchase can't receive goods` });
      return;
    }
    const location = await assertLocation(tid, data.data.locationId);

    const itemsById = new Map(purchase.items.map((i) => [i.id, i]));
    for (const line of data.data.items) {
      const item = itemsById.get(line.purchaseItemId);
      if (!item) throw new HttpError(400, "One or more lines don't belong to this purchase");
      const remaining = Number(item.quantity) - Number(item.receivedQuantity);
      if (line.quantity > remaining + 0.0005) {
        throw new HttpError(400, `Cannot receive ${line.quantity} ${item.product.name} — only ${remaining} left on this order`);
      }
    }

    const receiptNo = await nextGoodsReceiptNo(tid);
    const receipt = await prisma.$transaction(async (tx) => {
      const created = await tx.goodsReceipt.create({
        data: {
          tenantId: tid,
          receiptNo,
          purchaseId: purchase.id,
          locationId: location.id,
          note: data.data.note ?? null,
          createdBy: req.userId,
          ...(data.data.receivedAt ? { receivedAt: data.data.receivedAt } : {}),
          items: {
            create: data.data.items.map((line) => {
              const item = itemsById.get(line.purchaseItemId)!;
              return {
                purchaseItemId: item.id,
                productId: item.productId,
                quantity: line.quantity,
                unitCost: line.unitCost ?? Number(item.unitCost),
                note: line.note ?? null,
              };
            }),
          },
        },
        include: { items: { include: { product: { select: { id: true, name: true, unit: true, packSize: true, packLabel: true, packUnit: { select: { id: true, name: true } } } } } } },
      });

      let owed = 0;
      for (const receiptItem of created.items) {
        const item = itemsById.get(receiptItem.purchaseItemId)!;
        const qty = Number(receiptItem.quantity);
        const cost = Number(receiptItem.unitCost);
        owed += qty * cost;
        try {
          await recordStockMovement(tx, {
            tenantId: tid, productId: item.productId, locationId: location.id, type: "PURCHASE",
            quantity: qty, unitCost: cost, note: data.data.note ?? `Goods receipt ${receiptNo}`,
            sourceType: "GOODS_RECEIVED", sourceRefId: created.id, performedBy: req.userId ?? null,
            label: item.product.name, occurredAt: data.data.receivedAt,
          });
        } catch (error) {
          if (error instanceof InsufficientStockError) throw error;
          throw error;
        }
        await tx.purchaseItem.update({ where: { id: item.id }, data: { receivedQuantity: { increment: qty } } });
      }

      if (owed > 0) {
        await tx.supplier.update({ where: { id: purchase.supplierId }, data: { balance: { increment: round2(owed) } } });
      }

      const freshItems = await tx.purchaseItem.findMany({ where: { purchaseId: purchase.id }, select: { quantity: true, receivedQuantity: true } });
      const fullyReceived = freshItems.every((i) => Number(i.receivedQuantity) >= Number(i.quantity) - 0.0005);
      const anyReceived = freshItems.some((i) => Number(i.receivedQuantity) > 0);
      await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          status: fullyReceived ? "RECEIVED" : anyReceived ? "PARTIALLY_RECEIVED" : purchase.status,
          ...(fullyReceived ? { receivedAt: new Date() } : {}),
          ...(purchase.locationId ? {} : { locationId: location.id }),
        },
      });

      return created;
    });
    const updatedPurchase = await prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id }, include: purchaseInclude });
    res.status(201).json({ receipt, purchase: updatedPurchase });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof InsufficientStockError) { res.status(400).json({ error: error.message }); return; }
    next(error);
  }
});

purchasesRouter.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.purchase.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: { id: true, status: true } });
    if (!existing) { res.status(404).json({ error: "Purchase not found" }); return; }
    if (existing.status !== "DRAFT") { res.status(409).json({ error: "Only a draft purchase can be deleted — cancel it instead" }); return; }
    await prisma.purchase.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
