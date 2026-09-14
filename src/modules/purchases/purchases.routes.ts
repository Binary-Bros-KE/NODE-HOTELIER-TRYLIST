import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { nextPurchaseNo, nextGoodsReceiptNo, nextSupplierPaymentNo, nextTransactionNo } from "../../lib/sequence.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { recordStockMovement, InsufficientStockError } from "../../lib/stockLedger.js";
import { stockQuantityToCostUnits } from "../../lib/stockValuation.js";
import { recordSupplierBalanceEntry } from "../../lib/supplierBalance.js";

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
  sellingPrice: z.coerce.number().min(0).optional(),
  discountPerUnit: z.coerce.number().min(0).default(0),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  taxMode: z.enum(["INCLUSIVE", "EXCLUSIVE"]).default("INCLUSIVE"),
  taxTreatment: z.enum(["STANDARD", "ZERO_RATED", "EXEMPT"]).default("STANDARD"),
  menuPriceUpdates: z.array(z.object({ menuItemId: z.string().trim().min(1), sellingPrice: z.coerce.number().min(0) })).default([]),
  note: optionalText(255),
});

const createSchema = z.object({
  supplierId: z.string().trim().min(1),
  status: z.enum(["DRAFT", "ORDERED"]).default("DRAFT"),
  locationId: optionalText(60),
  orderDate: optionalDate,
  expectedDate: optionalDate,
  reference: optionalText(120),
  notes: optionalText(500),
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
  items: { include: { product: { select: { id: true, name: true, unit: true, packSize: true, packLabel: true, packUnit: { select: { id: true, name: true } } } }, menuPriceUpdates: { include: { menuItem: { select: { id: true, name: true, price: true } } } } }, orderBy: { createdAt: "asc" } },
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
  payments: {
    include: {
      paymentMethod: { select: { id: true, name: true, requiresReference: true } },
      createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { paidAt: "desc" },
  },
  supplierBalanceEntries: { orderBy: { createdAt: "desc" } },
} as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

function lineTaxAmount(amount: number, taxRate: number, taxMode: "INCLUSIVE" | "EXCLUSIVE", taxTreatment: "STANDARD" | "ZERO_RATED" | "EXEMPT") {
  if (taxTreatment !== "STANDARD" || taxRate <= 0) return 0;
  if (taxMode === "EXCLUSIVE") return round2(amount * (taxRate / 100));
  return round2(amount - amount / (1 + taxRate / 100));
}

function computeTotals<T extends { quantity: number; unitCost: number; packSize?: Prisma.Decimal | number | null; discountPerUnit?: number; taxRate?: number; taxMode?: "INCLUSIVE" | "EXCLUSIVE"; taxTreatment?: "STANDARD" | "ZERO_RATED" | "EXEMPT" }>(items: T[]) {
  const lines = items.map((i) => {
    const discountPerUnit = i.discountPerUnit ?? 0;
    const taxRate = i.taxRate ?? 0;
    const taxMode = i.taxMode ?? "INCLUSIVE";
    const taxTreatment = i.taxTreatment ?? "STANDARD";
    const netUnitCost = Math.max(0, i.unitCost - discountPerUnit);
    const baseAmount = round2(stockQuantityToCostUnits(i.quantity, i.packSize) * netUnitCost);
    const taxAmount = lineTaxAmount(baseAmount, taxRate, taxMode, taxTreatment);
    const lineTotal = taxMode === "EXCLUSIVE" ? round2(baseAmount + taxAmount) : baseAmount;
    return { ...i, discountPerUnit, taxRate, taxMode, taxTreatment, taxAmount, lineTotal };
  });
  const total = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
  const taxAmount = round2(lines.reduce((sum, l) => sum + l.taxAmount, 0));
  const subtotal = round2(total - taxAmount);
  return { lines, subtotal, taxAmount, total };
}

async function updateProductPricing(
  tx: Prisma.TransactionClient,
  tid: string,
  lines: { productId: string; unitCost: number; sellingPrice?: number; taxRate: number; taxMode: "INCLUSIVE" | "EXCLUSIVE"; taxTreatment: "STANDARD" | "ZERO_RATED" | "EXEMPT" }[],
) {
  for (const line of lines) {
    await tx.product.updateMany({
      where: { id: line.productId, tenantId: tid },
      data: {
        unitCost: line.unitCost,
        ...(line.sellingPrice != null ? { sellingPrice: line.sellingPrice } : {}),
        taxRate: line.taxRate,
        taxMode: line.taxMode,
        taxTreatment: line.taxTreatment,
      },
    });
  }
}

async function assertSupplier(tid: string, supplierId: string) {
  const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, tenantId: tid }, select: { id: true, isActive: true } });
  if (!supplier) throw new HttpError(400, "Supplier not found");
  if (!supplier.isActive) throw new HttpError(400, "That supplier is inactive");
}

async function productsForLines(tid: string, items: { productId: string }[]) {
  const ids = [...new Set(items.map((i) => i.productId))];
  const products = await prisma.product.findMany({ where: { id: { in: ids }, tenantId: tid }, select: { id: true, packSize: true } });
  if (products.length !== ids.length) throw new HttpError(400, "One or more items reference a product that was not found");
  return new Map(products.map((product) => [product.id, product]));
}

async function assertLocation(tid: string, locationId: string) {
  const location = await prisma.location.findFirst({ where: { id: locationId, tenantId: tid }, select: { id: true, name: true } });
  if (!location) throw new HttpError(400, "Choose a location from this property");
  return location;
}

async function assertMenuPriceUpdates(tid: string, items: { menuPriceUpdates?: { menuItemId: string }[] }[]) {
  const ids = [...new Set(items.flatMap((item) => item.menuPriceUpdates?.map((update) => update.menuItemId) ?? []))];
  if (!ids.length) return;
  const count = await prisma.menuItem.count({ where: { id: { in: ids }, tenantId: tid } });
  if (count !== ids.length) throw new HttpError(400, "One or more menu price updates reference a menu item that was not found");
}

async function resolvePaymentMethod(tid: string, paymentMethodId: string, reference: string | undefined) {
  const method = await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, tenantId: tid, isActive: true } });
  if (!method) throw new HttpError(400, "Choose a valid, active payment method");
  if (method.requiresReference && !reference) throw new HttpError(400, `${method.name} requires a reference number`);
  return method;
}

function paymentStatusFrom(paid: number, owed: number) {
  if (owed <= 0.0005 || paid <= 0.0005) return "UNPAID";
  if (paid >= owed - 0.0005) return "PAID";
  return "PARTIAL";
}

async function recomputePurchasePaymentStatus(tx: Prisma.TransactionClient, purchaseId: string) {
  const [owedAgg, paidAgg] = await Promise.all([
    tx.supplierBalanceEntry.aggregate({ where: { purchaseId, type: "GOODS_RECEIPT" }, _sum: { amount: true } }),
    tx.supplierPayment.aggregate({ where: { purchaseId }, _sum: { amount: true } }),
  ]);
  const owed = Number(owedAgg._sum.amount ?? 0);
  const paid = Number(paidAgg._sum.amount ?? 0);
  return tx.purchase.update({ where: { id: purchaseId }, data: { paymentStatus: paymentStatusFrom(paid, owed) } });
}

function receiptLineTotal(
  item: {
    quantity: Prisma.Decimal;
    discountPerUnit: Prisma.Decimal;
    taxRate: Prisma.Decimal;
    taxMode: "INCLUSIVE" | "EXCLUSIVE";
    taxTreatment: "STANDARD" | "ZERO_RATED" | "EXEMPT";
    product: { packSize: Prisma.Decimal | null };
  },
  quantity: number,
  unitCost: number,
) {
  const netUnitCost = Math.max(0, unitCost - Number(item.discountPerUnit));
  const baseAmount = round2(stockQuantityToCostUnits(quantity, item.product.packSize) * netUnitCost);
  const taxAmount = lineTaxAmount(baseAmount, Number(item.taxRate), item.taxMode, item.taxTreatment);
  return item.taxMode === "EXCLUSIVE" ? round2(baseAmount + taxAmount) : baseAmount;
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
  const { supplierId, items, orderDate, status, ...rest } = data.data;
  try {
    await assertSupplier(tid, supplierId);
    const productsById = await productsForLines(tid, items);
    await assertMenuPriceUpdates(tid, items);
    if (rest.locationId) await assertLocation(tid, rest.locationId);
    const { lines, subtotal, taxAmount, total } = computeTotals(items.map((item) => ({ ...item, packSize: productsById.get(item.productId)?.packSize ?? null })));
    const purchaseNo = await nextPurchaseNo(tid);
    const purchase = await prisma.$transaction(async (tx) => {
      const created = await tx.purchase.create({
        data: {
          tenantId: tid,
          purchaseNo,
          supplierId,
          status,
          taxRate: 0,
          subtotal,
          taxAmount,
          total,
          createdBy: req.userId,
          ...(orderDate ? { orderDate } : {}),
          ...rest,
          items: {
            create: lines.map((l) => ({
              productId: l.productId,
              quantity: l.quantity,
              unitCost: l.unitCost,
              sellingPrice: l.sellingPrice ?? null,
              discountPerUnit: l.discountPerUnit,
              taxRate: l.taxRate,
              taxMode: l.taxMode,
              taxTreatment: l.taxTreatment,
              taxAmount: l.taxAmount,
              lineTotal: l.lineTotal,
              menuPriceUpdates: l.menuPriceUpdates.length ? { create: l.menuPriceUpdates } : undefined,
              note: l.note,
            })),
          },
        },
        include: purchaseInclude,
      });
      return created;
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
    const existing = await prisma.purchase.findFirst({
      where: { id: req.params.id, tenantId: tid },
      include: {
        payments: { select: { id: true } },
        items: { include: { product: { select: { packSize: true } } } },
      },
    });
    if (!existing) { res.status(404).json({ error: "Purchase not found" }); return; }
    if (existing.status !== "DRAFT" && existing.status !== "ORDERED") { res.status(409).json({ error: `A ${existing.status.toLowerCase()} purchase can no longer be edited` }); return; }
    if (existing.items.some((i) => Number(i.receivedQuantity) > 0)) {
      res.status(409).json({ error: "This purchase already has received goods and can no longer be edited" });
      return;
    }
    if (existing.payments.length > 0) {
      res.status(409).json({ error: "This purchase already has payments and can no longer be edited" });
      return;
    }

    const { supplierId, items, orderDate, ...rest } = data.data;
    if (supplierId) await assertSupplier(tid, supplierId);
    const productsById = items ? await productsForLines(tid, items) : null;
    if (items) await assertMenuPriceUpdates(tid, items);
    if (rest.locationId) await assertLocation(tid, rest.locationId);

    const effectiveItems = items
      ? items.map((item) => ({ ...item, packSize: productsById?.get(item.productId)?.packSize ?? null }))
      : existing.items.map((i) => ({
        productId: i.productId,
        quantity: Number(i.quantity),
        unitCost: Number(i.unitCost),
        sellingPrice: i.sellingPrice == null ? undefined : Number(i.sellingPrice),
        discountPerUnit: Number(i.discountPerUnit),
        taxRate: Number(i.taxRate),
        taxMode: i.taxMode,
        taxTreatment: i.taxTreatment,
        menuPriceUpdates: [],
        note: i.note ?? undefined,
        packSize: i.product.packSize,
      }));
    const { lines, subtotal, taxAmount, total } = computeTotals(effectiveItems);

    const purchase = await prisma.$transaction(async (tx) => {
      if (items) {
        await tx.purchaseItem.deleteMany({ where: { purchaseId: existing.id } });
        await tx.purchaseItem.createMany({
          data: lines.map((l) => ({
            purchaseId: existing.id,
            productId: l.productId,
            quantity: l.quantity,
            unitCost: l.unitCost,
            sellingPrice: l.sellingPrice ?? null,
            discountPerUnit: l.discountPerUnit,
            taxRate: l.taxRate,
            taxMode: l.taxMode,
            taxTreatment: l.taxTreatment,
            taxAmount: l.taxAmount,
            lineTotal: l.lineTotal,
            note: l.note,
          })),
        });
        for (const line of lines) {
          if (!line.menuPriceUpdates.length) continue;
          const purchaseItem = await tx.purchaseItem.findFirst({ where: { purchaseId: existing.id, productId: line.productId }, select: { id: true } });
          if (purchaseItem) await tx.purchaseItemMenuPriceUpdate.createMany({ data: line.menuPriceUpdates.map((update) => ({ purchaseItemId: purchaseItem.id, ...update })) });
        }
      }
      return tx.purchase.update({
        where: { id: existing.id },
        data: {
          ...rest,
          ...(supplierId ? { supplierId } : {}),
          ...(orderDate ? { orderDate } : {}),
          taxRate: 0,
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

const paymentSchema = z.object({
  amount: z.coerce.number().positive(),
  paymentMethodId: z.string().trim().min(1),
  reference: optionalText(120),
  note: optionalText(500),
  paidAt: optionalDate,
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
    const purchase = await prisma.purchase.findFirst({
      where: { id: req.params.id, tenantId: tid },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true, packSize: true } },
            menuPriceUpdates: true,
          },
        },
      },
    });
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
      const receivedPurchaseItems = new Map<string, { item: typeof purchase.items[number]; unitCost: number }>();
      for (const receiptItem of created.items) {
        const item = itemsById.get(receiptItem.purchaseItemId)!;
        const qty = Number(receiptItem.quantity);
        const cost = Number(receiptItem.unitCost);
        owed += receiptLineTotal(item, qty, cost);
        receivedPurchaseItems.set(item.id, { item, unitCost: cost });
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

      await updateProductPricing(tx, tid, [...receivedPurchaseItems.values()].map(({ item, unitCost }) => ({
        productId: item.productId,
        unitCost,
        sellingPrice: item.sellingPrice == null ? undefined : Number(item.sellingPrice),
        taxRate: Number(item.taxRate),
        taxMode: item.taxMode,
        taxTreatment: item.taxTreatment,
      })));
      for (const { item } of receivedPurchaseItems.values()) {
        for (const update of item.menuPriceUpdates) {
          await tx.menuItem.updateMany({ where: { id: update.menuItemId, tenantId: tid }, data: { price: update.sellingPrice } });
        }
      }

      if (owed > 0) {
        await recordSupplierBalanceEntry(tx, {
          tenantId: tid,
          supplierId: purchase.supplierId,
          type: "GOODS_RECEIPT",
          amount: round2(owed),
          note: data.data.note ?? `Goods receipt ${receiptNo}`,
          purchaseId: purchase.id,
          goodsReceiptId: created.id,
          createdBy: req.userId ?? null,
        });
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
      await recomputePurchasePaymentStatus(tx, purchase.id);

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

purchasesRouter.post("/:id/payments", async (req, res, next) => {
  const data = paymentSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid payment", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const purchase = await prisma.purchase.findFirst({
      where: { id: req.params.id, tenantId: tid },
      include: { supplier: { select: { id: true, name: true, balance: true } } },
    });
    if (!purchase) { res.status(404).json({ error: "Purchase not found" }); return; }
    if (purchase.status === "DRAFT" || purchase.status === "ORDERED" || purchase.status === "CANCELLED") {
      res.status(409).json({ error: "Receive goods before recording a payment for this purchase" });
      return;
    }
    await resolvePaymentMethod(tid, data.data.paymentMethodId, data.data.reference);

    const [owedAgg, paidAgg] = await Promise.all([
      prisma.supplierBalanceEntry.aggregate({ where: { purchaseId: purchase.id, type: "GOODS_RECEIPT" }, _sum: { amount: true } }),
      prisma.supplierPayment.aggregate({ where: { purchaseId: purchase.id }, _sum: { amount: true } }),
    ]);
    const owed = Number(owedAgg._sum.amount ?? 0);
    const paid = Number(paidAgg._sum.amount ?? 0);
    const outstanding = round2(owed - paid);
    if (outstanding <= 0.0005) {
      res.status(409).json({ error: "This purchase has no outstanding received balance" });
      return;
    }
    if (data.data.amount > outstanding + 0.0005) {
      res.status(400).json({ error: "This payment is more than the outstanding purchase balance" });
      return;
    }
    if (data.data.amount > Number(purchase.supplier.balance) + 0.0005) {
      res.status(400).json({ error: "This payment is more than the supplier balance" });
      return;
    }

    const paymentNo = await nextSupplierPaymentNo(tid);
    const transactionNo = await nextTransactionNo(tid);
    const result = await prisma.$transaction(async (tx) => {
      const payment = await tx.supplierPayment.create({
        data: {
          tenantId: tid,
          paymentNo,
          supplierId: purchase.supplierId,
          purchaseId: purchase.id,
          amount: data.data.amount,
          paymentMethodId: data.data.paymentMethodId,
          reference: data.data.reference,
          note: data.data.note,
          createdBy: req.userId,
          ...(data.data.paidAt ? { paidAt: data.data.paidAt } : {}),
        },
        include: {
          paymentMethod: { select: { id: true, name: true, requiresReference: true } },
          createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
        },
      });
      await recordSupplierBalanceEntry(tx, {
        tenantId: tid,
        supplierId: purchase.supplierId,
        type: "PAYMENT",
        amount: -data.data.amount,
        note: data.data.note ?? `Payment ${paymentNo}`,
        purchaseId: purchase.id,
        paymentId: payment.id,
        createdBy: req.userId ?? null,
      });
      await tx.transaction.create({
        data: {
          tenantId: tid,
          transactionNo,
          direction: "OUT",
          source: "SUPPLIER_PAYMENT",
          amount: data.data.amount,
          paymentMethodId: data.data.paymentMethodId,
          reference: data.data.reference,
          supplierId: purchase.supplierId,
          employeeId: req.userId,
          description: `Payment for ${purchase.purchaseNo}`,
          sourceRefId: payment.id,
        },
      });
      await recomputePurchasePaymentStatus(tx, purchase.id);
      return payment;
    });
    const updatedPurchase = await prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id }, include: purchaseInclude });
    res.status(201).json({ payment: result, purchase: updatedPurchase });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
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
