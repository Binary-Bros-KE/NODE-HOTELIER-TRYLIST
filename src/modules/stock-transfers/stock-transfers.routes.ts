import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { nextStockTransferNo } from "../../lib/sequence.js";
import { InsufficientStockError } from "../../lib/stockLedger.js";
import { performStockTransfer } from "../../lib/stockTransfer.js";

// An internal move of stock between two locations — the Store page's
// "Distribute Stock" flow. Every line freezes the balance at both ends the
// instant it's recorded (via recordStockMovement's own balanceBefore/After),
// so the printed receipt always shows what was true then, not the live
// balance now. No cost/value dimension — that's what Goods Received is for.
export const stockTransfersRouter = Router();

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const createSchema = z.object({
  fromLocationId: z.string().trim().min(1),
  toLocationId: z.string().trim().min(1),
  note: optionalText(500),
  items: z.array(z.object({
    productId: z.string().trim().min(1),
    quantity: z.coerce.number().positive(),
  })).min(1, "Add at least one product"),
}).refine((v) => v.fromLocationId !== v.toLocationId, { message: "Choose two different locations", path: ["toLocationId"] });

const listQuerySchema = z.object({
  search: optionalText(120),
  locationId: z.string().trim().optional(),
});

async function assertLocation(tid: string, locationId: string) {
  const location = await prisma.location.findFirst({ where: { id: locationId, tenantId: tid }, select: { id: true, name: true } });
  if (!location) throw Object.assign(new Error("Choose a location from this property"), { status: 400 });
  return location;
}

const transferInclude = {
  fromLocation: { select: { id: true, name: true } },
  toLocation: { select: { id: true, name: true } },
  createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
  items: { include: { product: { select: { id: true, name: true, unit: true, sku: true, packSize: true, packLabel: true, packUnit: { select: { id: true, name: true } } } } } },
} as const;

stockTransfersRouter.get("/", async (req, res, next) => {
  try {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid filters", details: query.error.flatten() }); return; }
    const { search, locationId } = query.data;
    const tid = tenantId(req);
    const where: Prisma.StockTransferWhereInput = {
      tenantId: tid,
      ...(locationId ? { OR: [{ fromLocationId: locationId }, { toLocationId: locationId }] } : {}),
      ...(search ? { OR: [
        { transferNo: { contains: search, mode: "insensitive" } },
        { fromLocation: { name: { contains: search, mode: "insensitive" } } },
        { toLocation: { name: { contains: search, mode: "insensitive" } } },
      ] } : {}),
    };
    const transfers = await prisma.stockTransfer.findMany({ where, include: transferInclude, orderBy: { createdAt: "desc" } });
    const summary = {
      total: transfers.length,
      lineItems: transfers.reduce((s, t) => s + t.items.length, 0),
      unitsTransferred: transfers.reduce((s, t) => s + t.items.reduce((s2, i) => s2 + Number(i.quantity), 0), 0),
    };
    res.json({ transfers, summary });
  } catch (error) {
    next(error);
  }
});

stockTransfersRouter.get("/:id", async (req, res, next) => {
  try {
    const transfer = await prisma.stockTransfer.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: transferInclude });
    if (!transfer) { res.status(404).json({ error: "Stock transfer not found" }); return; }
    res.json({ transfer });
  } catch (error) {
    next(error);
  }
});

/** Moves several products from one location to another in a single
 * all-or-nothing transaction, recording one printable receipt with the
 * frozen before/after balance at both ends of every line. */
stockTransfersRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid stock transfer", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const { fromLocationId, toLocationId, items, note } = data.data;
    const [fromLocation, toLocation] = await Promise.all([
      assertLocation(tid, fromLocationId),
      assertLocation(tid, toLocationId),
    ]);
    const productIds = [...new Set(items.map((i) => i.productId))];
    if (productIds.length !== items.length) { res.status(400).json({ error: "Each product can only appear once" }); return; }
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, tenantId: tid }, select: { id: true, name: true } });
    if (products.length !== productIds.length) { res.status(400).json({ error: "One or more items reference a product that was not found" }); return; }
    const productName = new Map(products.map((p) => [p.id, p.name]));

    const transferNo = await nextStockTransferNo(tid);
    const transferNote = note ?? `Transfer ${fromLocation.name} → ${toLocation.name}`;

    const transfer = await prisma.$transaction(async (tx) => {
      const created = await performStockTransfer(tx, {
        tenantId: tid, transferNo, fromLocationId, toLocationId, note: note ?? null, ledgerNote: transferNote,
        performedBy: req.userId,
        items: items.map((item) => ({ productId: item.productId, quantity: item.quantity, name: productName.get(item.productId) })),
      });
      return tx.stockTransfer.findUniqueOrThrow({ where: { id: created.id }, include: transferInclude });
    });
    res.status(201).json({ transfer });
  } catch (error) {
    if (error instanceof InsufficientStockError) { res.status(error.status).json({ error: `Not enough ${error.label} at the source location` }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});
