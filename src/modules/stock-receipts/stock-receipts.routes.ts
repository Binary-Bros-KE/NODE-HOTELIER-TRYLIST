import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { nextStockReceiptNo } from "../../lib/sequence.js";
import { recordStockMovement } from "../../lib/stockLedger.js";

export const stockReceiptsRouter = Router();

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const createSchema = z.object({
  locationId: z.string().trim().min(1),
  note: optionalText(500),
  items: z.array(z.object({
    productId: z.string().trim().min(1),
    quantity: z.coerce.number().positive(),
  })).min(1, "Add at least one product"),
});

const listQuerySchema = z.object({
  search: optionalText(120),
  locationId: z.string().trim().optional(),
});

const productSelect = {
  id: true,
  name: true,
  unit: true,
  sku: true,
  packSize: true,
  packLabel: true,
  packUnit: { select: { id: true, name: true } },
} as const;

const receiptInclude = {
  location: { select: { id: true, name: true } },
  createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
  items: { include: { product: { select: productSelect } } },
} as const;

async function assertLocation(tid: string, locationId: string) {
  const location = await prisma.location.findFirst({ where: { id: locationId, tenantId: tid }, select: { id: true, name: true } });
  if (!location) throw Object.assign(new Error("Choose a location from this property"), { status: 400 });
  return location;
}

stockReceiptsRouter.get("/", async (req, res, next) => {
  try {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid filters", details: query.error.flatten() }); return; }
    const { search, locationId } = query.data;
    const tid = tenantId(req);
    const where: Prisma.StockReceiptWhereInput = {
      tenantId: tid,
      ...(locationId ? { locationId } : {}),
      ...(search ? { OR: [
        { receiptNo: { contains: search, mode: "insensitive" } },
        { location: { name: { contains: search, mode: "insensitive" } } },
        { items: { some: { product: { name: { contains: search, mode: "insensitive" } } } } },
        { items: { some: { product: { sku: { contains: search, mode: "insensitive" } } } } },
      ] } : {}),
    };
    const receipts = await prisma.stockReceipt.findMany({ where, include: receiptInclude, orderBy: { createdAt: "desc" } });
    const summary = {
      total: receipts.length,
      lineItems: receipts.reduce((s, r) => s + r.items.length, 0),
      unitsReceived: receipts.reduce((s, r) => s + r.items.reduce((s2, i) => s2 + Number(i.quantity), 0), 0),
    };
    res.json({ receipts, summary });
  } catch (error) {
    next(error);
  }
});

stockReceiptsRouter.get("/:id", async (req, res, next) => {
  try {
    const receipt = await prisma.stockReceipt.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: receiptInclude });
    if (!receipt) { res.status(404).json({ error: "Stock receipt not found" }); return; }
    res.json({ receipt });
  } catch (error) {
    next(error);
  }
});

stockReceiptsRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid goods received", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const { locationId, items, note } = data.data;
    const location = await assertLocation(tid, locationId);
    const productIds = [...new Set(items.map((i) => i.productId))];
    if (productIds.length !== items.length) { res.status(400).json({ error: "Each product can only appear once" }); return; }
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, tenantId: tid }, select: { id: true, name: true } });
    if (products.length !== productIds.length) { res.status(400).json({ error: "One or more items reference a product that was not found" }); return; }

    const receiptNo = await nextStockReceiptNo(tid);
    const receiptNote = note ?? `Goods received into ${location.name}`;

    const receipt = await prisma.$transaction(async (tx) => {
      const created = await tx.stockReceipt.create({
        data: { tenantId: tid, receiptNo, locationId, note: note ?? null, createdBy: req.userId },
      });
      for (const item of items) {
        const movement = await recordStockMovement(tx, {
          tenantId: tid,
          productId: item.productId,
          locationId,
          type: "PURCHASE",
          quantity: item.quantity,
          note: receiptNote,
          sourceType: "STOCK_RECEIPT",
          sourceRefId: created.id,
          performedBy: req.userId ?? null,
        });
        await tx.stockReceiptItem.create({
          data: {
            receiptId: created.id,
            productId: item.productId,
            quantity: item.quantity,
            qtyBefore: movement.balanceBefore ?? 0,
            qtyAfter: movement.balanceAfter ?? 0,
          },
        });
      }
      return tx.stockReceipt.findUniqueOrThrow({ where: { id: created.id }, include: receiptInclude });
    });
    res.status(201).json({ receipt });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});
