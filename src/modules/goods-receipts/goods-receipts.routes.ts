import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { stockValue } from "../../lib/stockValuation.js";

// Read-only cross-PO history — the actual receiving action lives on the
// purchase itself (POST /purchases/:id/goods-receipts), since a receipt only
// ever makes sense in the context of the PO it's against. This module is
// just the "Goods Received" audit list/detail behind the Inventory nav tab.
export const goodsReceiptsRouter = Router();

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const receiptInclude = {
  purchase: { select: { id: true, purchaseNo: true, supplier: { select: { id: true, name: true } } } },
  location: { select: { id: true, name: true } },
  createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
  items: { include: { product: { select: { id: true, name: true, unit: true, packSize: true } } } },
} as const;

goodsReceiptsRouter.get("/", async (req, res, next) => {
  try {
    const query = z.object({
      search: z.string().trim().max(120).optional(),
      locationId: z.string().trim().optional(),
    }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid filters", details: query.error.flatten() }); return; }
    const { search, locationId } = query.data;
    const tid = tenantId(req);
    const where: Prisma.GoodsReceiptWhereInput = {
      tenantId: tid,
      ...(locationId ? { locationId } : {}),
      ...(search ? { OR: [
        { receiptNo: { contains: search, mode: "insensitive" } },
        { purchase: { purchaseNo: { contains: search, mode: "insensitive" } } },
        { purchase: { supplier: { name: { contains: search, mode: "insensitive" } } } },
      ] } : {}),
    };
    const receipts = await prisma.goodsReceipt.findMany({ where, include: receiptInclude, orderBy: { receivedAt: "desc" } });
    const value = (r: (typeof receipts)[number]) => r.items.reduce((sum, i) => sum + (stockValue(i.quantity, i.unitCost, i.product.packSize) ?? 0), 0);
    const summary = { total: receipts.length, totalValue: receipts.reduce((sum, r) => sum + value(r), 0) };
    res.json({ receipts: receipts.map((r) => ({ ...r, value: value(r) })), summary });
  } catch (error) {
    next(error);
  }
});

goodsReceiptsRouter.get("/:id", async (req, res, next) => {
  try {
    const receipt = await prisma.goodsReceipt.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: receiptInclude });
    if (!receipt) { res.status(404).json({ error: "Goods receipt not found" }); return; }
    res.json({ receipt });
  } catch (error) {
    next(error);
  }
});
