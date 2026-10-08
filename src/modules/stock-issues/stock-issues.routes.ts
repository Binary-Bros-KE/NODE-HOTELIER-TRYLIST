import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { requirePermission } from "../../middleware/tenantContext.js";
import { employeeName } from "../../lib/dispatch.js";
import { nextStockRequestNo, nextStockTransferNo } from "../../lib/sequence.js";
import { recordStockMovement, InsufficientStockError } from "../../lib/stockLedger.js";
import { performStockTransfer } from "../../lib/stockTransfer.js";

// Stock that isn't taken off per dish (sugar bowls, salt, frying oil) moves by
// hand. The storekeeper issues it to a kitchen, and the kitchen counts what is
// left when the batch is finished. Which products work this way is each
// product's own trackingMode setting, so nothing here names a product.
export const stockIssuesRouter = Router();

const tenantId = (req: { tenantId?: string }) => { if (!req.tenantId) throw new Error("Tenant context is required"); return req.tenantId; };
const handle = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((error) => {
    if (error instanceof InsufficientStockError) { res.status(409).json({ error: `Not enough ${error.label} at this location` }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  });
};
const parse = <T extends z.ZodTypeAny>(schema: T, data: unknown, res: Response): z.infer<T> | null => {
  const result = schema.safeParse(data);
  if (!result.success) { res.status(400).json({ error: "Invalid input", details: result.error.flatten() }); return null; }
  return result.data;
};
const notFound = (message: string) => Object.assign(new Error(message), { status: 404 });
const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

async function locationIn(tid: string, id: string) {
  const location = await prisma.location.findFirst({ where: { id, tenantId: tid }, select: { id: true, name: true } });
  if (!location) throw notFound("Location not found");
  return location;
}

async function onHandAt(tid: string, locationId: string, productIds: string[]) {
  const rows = await prisma.productStock.findMany({
    where: { tenantId: tid, locationId, productId: { in: productIds } },
    select: { productId: true, quantity: true },
  });
  return new Map(rows.map((row) => [row.productId, Number(row.quantity)]));
}

const stockRequestInclude = {
  fromLocation: { select: { id: true, name: true, type: true } },
  toLocation: { select: { id: true, name: true, type: true } },
  items: {
    include: {
      product: { select: { id: true, unit: true, trackingMode: true } },
    },
    orderBy: { productName: "asc" as const },
  },
} as const satisfies Prisma.StockRequestInclude;

type StockRequestWithItems = Prisma.StockRequestGetPayload<{ include: typeof stockRequestInclude }>;
const paramOne = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

async function stockRequestDto(tid: string, request: StockRequestWithItems) {
  const onHand = await onHandAt(tid, request.fromLocationId, request.items.map((i) => i.productId));
  return {
    id: request.id,
    requestNo: request.requestNo,
    status: request.status,
    note: request.note,
    requestedByName: request.requestedByName,
    requestedAt: request.requestedAt,
    respondedByName: request.respondedByName,
    respondedAt: request.respondedAt,
    rejectReason: request.rejectReason,
    fromLocation: request.fromLocation,
    toLocation: request.toLocation,
    items: request.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productName: item.productName,
      unit: item.product.unit,
      trackingMode: item.product.trackingMode,
      requestedQty: Number(item.requestedQty),
      dispatchedQty: item.dispatchedQty == null ? null : Number(item.dispatchedQty),
      available: onHand.get(item.productId) ?? 0,
    })),
  };
}

stockIssuesRouter.get("/request-sheet", handle(async (req, res) => {
  const tid = tenantId(req);
  const query = parse(z.object({ fromLocationId: z.string().min(1) }), req.query, res);
  if (!query) return;
  await locationIn(tid, query.fromLocationId);
  const products = await prisma.product.findMany({
    where: { tenantId: tid, isActive: true, isExpenseItem: false },
    select: { id: true, name: true, unit: true, trackingMode: true, category: { select: { name: true } } },
    orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
  });
  const onHand = await onHandAt(tid, query.fromLocationId, products.map((p) => p.id));
  res.json({ products: products.map((p) => ({ ...p, categoryName: p.category?.name ?? "Uncategorised", onHand: onHand.get(p.id) ?? 0 })) });
}));

const stockRequestSchema = z.object({
  fromLocationId: z.string().min(1),
  toLocationId: z.string().min(1),
  note: z.string().trim().max(500).optional(),
  lines: z.array(z.object({ productId: z.string().min(1), quantity: z.number().positive() })).min(1),
});

stockIssuesRouter.post("/requests", handle(async (req, res) => {
  const tid = tenantId(req);
  const body = parse(stockRequestSchema, req.body, res);
  if (!body) return;
  if (body.fromLocationId === body.toLocationId) throw badRequest("Pick a different store and destination");
  await locationIn(tid, body.fromLocationId);
  await locationIn(tid, body.toLocationId);

  const products = await prisma.product.findMany({
    where: { tenantId: tid, id: { in: body.lines.map((l) => l.productId) }, isActive: true, isExpenseItem: false },
    select: { id: true, name: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const line of body.lines) if (!byId.has(line.productId)) throw notFound("Product not found");

  const requestNo = await nextStockRequestNo(tid);
  const requesterName = await employeeName(prisma, tid, req.userId);
  const created = await prisma.stockRequest.create({
    data: {
      tenantId: tid,
      requestNo,
      fromLocationId: body.fromLocationId,
      toLocationId: body.toLocationId,
      note: body.note ?? null,
      requestedBy: req.userId ?? null,
      requestedByName: requesterName,
      items: { create: body.lines.map((line) => ({ productId: line.productId, productName: byId.get(line.productId)!.name, requestedQty: line.quantity })) },
    },
    include: stockRequestInclude,
  });
  res.status(201).json({ request: await stockRequestDto(tid, created as StockRequestWithItems) });
}));

stockIssuesRouter.get("/requests", handle(async (req, res) => {
  const tid = tenantId(req);
  const query = parse(z.object({
    status: z.enum(["REQUESTED", "DISPATCHED", "REJECTED", "CANCELLED"]).optional(),
    fromLocationId: z.string().min(1).optional(),
    toLocationId: z.string().min(1).optional(),
  }), req.query, res);
  if (!query) return;
  const requests = await prisma.stockRequest.findMany({
    where: {
      tenantId: tid,
      ...(query.status ? { status: query.status } : {}),
      ...(query.fromLocationId ? { fromLocationId: query.fromLocationId } : {}),
      ...(query.toLocationId ? { toLocationId: query.toLocationId } : {}),
    },
    include: stockRequestInclude,
    orderBy: { requestedAt: "desc" },
    take: 80,
  });
  res.json({ requests: await Promise.all(requests.map((r) => stockRequestDto(tid, r as StockRequestWithItems))) });
}));

const dispatchRequestSchema = z.object({
  note: z.string().trim().max(500).optional(),
  lines: z.array(z.object({ itemId: z.string().min(1), quantity: z.number().min(0) })).min(1),
});

stockIssuesRouter.post("/requests/:id/dispatch", requirePermission("STORE_DISPATCH"), handle(async (req, res) => {
  const tid = tenantId(req);
  const body = parse(dispatchRequestSchema, req.body, res);
  if (!body) return;
  const requestId = paramOne(req.params.id);
  if (!requestId) throw notFound("Stock request not found");

  const request = await prisma.stockRequest.findFirst({
    where: { id: requestId, tenantId: tid },
    include: stockRequestInclude,
  });
  if (!request) throw notFound("Stock request not found");
  if (request.status !== "REQUESTED") throw badRequest("This request has already been answered");

  const quantityByItem = new Map(body.lines.map((line) => [line.itemId, line.quantity]));
  const chosen = (request.items as StockRequestWithItems["items"])
    .map((item) => ({ item, quantity: quantityByItem.get(item.id) ?? Number(item.requestedQty) }))
    .filter((line) => line.quantity > 0);
  if (chosen.length === 0) throw badRequest("Enter a dispatch quantity for at least one item");
  for (const line of chosen) {
    const requested = Number(line.item.requestedQty);
    if (line.quantity > requested) throw badRequest(`You cannot dispatch more ${line.item.productName} than requested`);
  }

  const transferNo = await nextStockTransferNo(tid);
  const actorName = await employeeName(prisma, tid, req.userId);
  const note = body.note ?? request.note ?? null;
  const issuedOnly = chosen.filter((line) => line.item.product.trackingMode === "ISSUE_ONLY");
  const kept = chosen.filter((line) => line.item.product.trackingMode !== "ISSUE_ONLY");

  const transferId = await prisma.$transaction(async (tx) => {
    const claimed = await tx.stockRequest.updateMany({
      where: { id: request.id, status: "REQUESTED" },
      data: { status: "DISPATCHED", respondedAt: new Date(), respondedBy: req.userId ?? null, respondedByName: actorName },
    });
    if (!claimed.count) throw badRequest("This request has just been answered by someone else");

    for (const line of issuedOnly) {
      await recordStockMovement(tx, {
        tenantId: tid,
        productId: line.item.productId,
        locationId: request.fromLocationId,
        type: "ISSUE",
        quantity: -line.quantity,
        note: note ?? `Issued to ${request.toLocation.name}`,
        sourceType: "STOCK_REQUEST",
        sourceRefId: request.id,
        performedBy: req.userId ?? null,
        label: line.item.productName,
      });
    }

    let createdTransferId: string | null = null;
    if (kept.length > 0) {
      const transfer = await performStockTransfer(tx, {
        tenantId: tid,
        transferNo,
        fromLocationId: request.fromLocationId,
        toLocationId: request.toLocationId,
        items: kept.map((line) => ({ productId: line.item.productId, quantity: line.quantity, name: line.item.productName })),
        note,
        ledgerNote: note ?? `Stock request ${request.requestNo}`,
        performedBy: req.userId,
      });
      createdTransferId = transfer.id;
    }

    await Promise.all((request.items as StockRequestWithItems["items"]).map((item) => tx.stockRequestItem.update({
      where: { id: item.id },
      data: { dispatchedQty: quantityByItem.get(item.id) ?? Number(item.requestedQty) },
    })));
    if (createdTransferId) await tx.stockRequest.update({ where: { id: request.id }, data: { transferId: createdTransferId } });
    return createdTransferId;
  });

  const fresh = await prisma.stockRequest.findUniqueOrThrow({ where: { id: request.id }, include: stockRequestInclude });
  res.json({ request: await stockRequestDto(tid, fresh as StockRequestWithItems), transferNo: transferId ? transferNo : null });
}));

stockIssuesRouter.post("/requests/:id/reject", requirePermission("STORE_DISPATCH"), handle(async (req, res) => {
  const tid = tenantId(req);
  const body = parse(z.object({ reason: z.string().trim().min(1).max(500) }), req.body, res);
  if (!body) return;
  const requestId = paramOne(req.params.id);
  if (!requestId) throw notFound("Pending stock request not found");
  const actorName = await employeeName(prisma, tid, req.userId);
  const updated = await prisma.stockRequest.updateMany({
    where: { id: requestId, tenantId: tid, status: "REQUESTED" },
    data: { status: "REJECTED", rejectReason: body.reason, respondedAt: new Date(), respondedBy: req.userId ?? null, respondedByName: actorName },
  });
  if (!updated.count) throw notFound("Pending stock request not found");
  const fresh = await prisma.stockRequest.findUniqueOrThrow({ where: { id: requestId }, include: stockRequestInclude });
  res.json({ request: await stockRequestDto(tid, fresh as StockRequestWithItems) });
}));

// Products the storekeeper can hand out by hand: anything not tracked per sale.
stockIssuesRouter.get("/issue-sheet", requirePermission("STORE_DISPATCH"), handle(async (req, res) => {
  const tid = tenantId(req);
  const query = parse(z.object({ fromLocationId: z.string().min(1) }), req.query, res);
  if (!query) return;
  await locationIn(tid, query.fromLocationId);
  const products = await prisma.product.findMany({
    where: { tenantId: tid, isActive: true, trackingMode: { not: "PER_SALE" } },
    select: { id: true, name: true, unit: true, trackingMode: true },
    orderBy: { name: "asc" },
  });
  const onHand = await onHandAt(tid, query.fromLocationId, products.map((p) => p.id));
  res.json({ products: products.map((p) => ({ ...p, onHand: onHand.get(p.id) ?? 0 })) });
}));

const issueSchema = z.object({
  fromLocationId: z.string().min(1),
  toLocationId: z.string().min(1),
  note: z.string().trim().max(500).optional(),
  lines: z.array(z.object({ productId: z.string().min(1), quantity: z.number().positive() })).min(1),
});

// ISSUE_ONLY lines are used up the moment they're handed over (ISSUE movement,
// no kitchen balance). PERIODIC_COUNT lines go to the kitchen's shelf as a
// normal stock transfer, to be counted when the batch is finished.
stockIssuesRouter.post("/issue", requirePermission("STORE_DISPATCH"), handle(async (req, res) => {
  const tid = tenantId(req);
  const body = parse(issueSchema, req.body, res);
  if (!body) return;
  if (body.fromLocationId === body.toLocationId) throw badRequest("Pick a different location to issue to");
  const from = await locationIn(tid, body.fromLocationId);
  const to = await locationIn(tid, body.toLocationId);

  const products = await prisma.product.findMany({
    where: { tenantId: tid, id: { in: body.lines.map((l) => l.productId) } },
    select: { id: true, name: true, trackingMode: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const line of body.lines) {
    const product = byId.get(line.productId);
    if (!product) throw notFound("Product not found");
    if (product.trackingMode === "PER_SALE") throw badRequest(`${product.name} is sold per dish. Move it with a stock transfer instead.`);
  }

  const transferNo = await nextStockTransferNo(tid);
  const performedBy = req.userId ?? null;
  const note = body.note ?? null;
  // ISSUE_ONLY is consumed the moment it leaves the issuing shelf: no
  // destination stock is created. PERIODIC_COUNT is still stocked at the
  // destination so the user can later count what remains and post USAGE.
  const issuedOnly = body.lines.filter((line) => byId.get(line.productId)?.trackingMode === "ISSUE_ONLY");
  const kept = body.lines.filter((line) => byId.get(line.productId)?.trackingMode === "PERIODIC_COUNT");

  await prisma.$transaction(async (tx) => {
    for (const line of issuedOnly) {
      const product = byId.get(line.productId)!;
      await recordStockMovement(tx, {
        tenantId: tid, productId: line.productId, locationId: from.id, type: "ISSUE", quantity: -line.quantity,
        note: note ?? `Issued to ${to.name}`, sourceType: "STOCK_ISSUE", sourceRefId: to.id,
        performedBy, label: product.name,
      });
    }
    if (kept.length > 0) {
      await performStockTransfer(tx, {
        tenantId: tid, transferNo, fromLocationId: from.id, toLocationId: to.id,
        items: kept.map((l) => ({ productId: l.productId, quantity: l.quantity, name: byId.get(l.productId)?.name })),
        note, ledgerNote: note ?? `Issued to ${to.name}`, performedBy,
      });
    }
  });
  res.status(201).json({ issued: issuedOnly.length, transferred: kept.length, transferNo: kept.length > 0 ? transferNo : null });
}));

// What the kitchen has on its shelf to count: products tracked by count.
stockIssuesRouter.get("/count-sheet", handle(async (req, res) => {
  const tid = tenantId(req);
  const query = parse(z.object({ locationId: z.string().min(1) }), req.query, res);
  if (!query) return;
  await locationIn(tid, query.locationId);
  const products = await prisma.product.findMany({
    where: { tenantId: tid, isActive: true, trackingMode: "PERIODIC_COUNT" },
    select: { id: true, name: true, unit: true },
    orderBy: { name: "asc" },
  });
  const onHand = await onHandAt(tid, query.locationId, products.map((p) => p.id));
  res.json({ products: products.map((p) => ({ ...p, onHand: onHand.get(p.id) ?? 0 })) });
}));

const countSchema = z.object({
  locationId: z.string().min(1),
  note: z.string().trim().max(500).optional(),
  lines: z.array(z.object({ productId: z.string().min(1), counted: z.number().min(0) })).min(1),
});

// The closing count. What's counted is compared with the books: less than
// expected is usage since the last count (USAGE), more is found stock
// (ADJUSTMENT). The books already include everything issued, so no period
// bookkeeping is needed.
stockIssuesRouter.post("/count", handle(async (req, res) => {
  const tid = tenantId(req);
  const body = parse(countSchema, req.body, res);
  if (!body) return;
  const location = await locationIn(tid, body.locationId);
  const products = await prisma.product.findMany({
    where: { tenantId: tid, id: { in: body.lines.map((l) => l.productId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(products.map((p) => [p.id, p.name]));
  const onHand = await onHandAt(tid, location.id, body.lines.map((l) => l.productId));
  const performedBy = req.userId ?? null;
  const note = body.note ?? null;

  const results = await prisma.$transaction(async (tx) => {
    const out: { productId: string; name: string; expected: number; counted: number; used: number; found: number }[] = [];
    for (const line of body.lines) {
      const name = nameById.get(line.productId);
      if (!name) throw notFound("Product not found");
      const expected = onHand.get(line.productId) ?? 0;
      const diff = line.counted - expected;
      if (diff < 0) {
        await recordStockMovement(tx, {
          tenantId: tid, productId: line.productId, locationId: location.id, type: "USAGE", quantity: diff,
          note: note ?? "Used since the last count", sourceType: "STOCK_COUNT", performedBy, label: name,
        });
      } else if (diff > 0) {
        await recordStockMovement(tx, {
          tenantId: tid, productId: line.productId, locationId: location.id, type: "ADJUSTMENT", quantity: diff,
          note: note ?? "Count found more than the books show", sourceType: "STOCK_COUNT", performedBy,
        });
      }
      out.push({ productId: line.productId, name, expected, counted: line.counted, used: diff < 0 ? -diff : 0, found: diff > 0 ? diff : 0 });
    }
    return out;
  });
  res.status(201).json({ lines: results });
}));
