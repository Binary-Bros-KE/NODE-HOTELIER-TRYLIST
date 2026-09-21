import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { requirePermission } from "../../middleware/tenantContext.js";
import { DispatchError, employeeName } from "../../lib/dispatch.js";
import { nextStockTransferNo } from "../../lib/sequence.js";
import { InsufficientStockError } from "../../lib/stockLedger.js";
import { performStockTransfer } from "../../lib/stockTransfer.js";

// The store's side of a kitchen's ingredient request: see what the chef asked
// for, dispatch it (a real store -> kitchen stock transfer) or reject it with a
// reason. Everything here needs STORE_DISPATCH; the chef's side lives in the
// kitchen router.
export const dispatchRouter = Router();
dispatchRouter.use(requirePermission("STORE_DISPATCH"));

const tenantId = (req: { tenantId?: string }) => { if (!req.tenantId) throw new Error("Tenant context is required"); return req.tenantId; };
const handle = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((error) => {
    if (error instanceof DispatchError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof InsufficientStockError) { res.status(409).json({ error: `Not enough ${error.label} in the store to dispatch this` }); return; }
    next(error);
  });
};

const requestInclude = {
  items: true,
  fromLocation: { select: { id: true, name: true } },
  toLocation: { select: { id: true, name: true } },
  order: { select: { id: true, orderNumber: true, status: true, table: { select: { label: true } } } },
} satisfies Prisma.StockDispatchRequestInclude;

/** Adds the store's live balance next to each requested line, so the storekeeper sees at a glance whether they can fill it. */
async function withStoreStock<T extends Prisma.StockDispatchRequestGetPayload<{ include: typeof requestInclude }>>(tid: string, requests: T[]) {
  const stocks = await prisma.productStock.findMany({
    where: { tenantId: tid, OR: requests.filter((r) => r.status === "REQUESTED").map((r) => ({ locationId: r.fromLocationId, productId: { in: r.items.map((i) => i.productId) } })) },
    select: { productId: true, locationId: true, quantity: true },
  });
  const balance = new Map(stocks.map((s) => [`${s.locationId}:${s.productId}`, Number(s.quantity)]));
  return requests.map((r) => ({ ...r, items: r.items.map((i) => ({ ...i, storeQty: balance.get(`${r.fromLocationId}:${i.productId}`) ?? 0 })) }));
}

dispatchRouter.get("/", handle(async (req, res) => {
  const tid = tenantId(req);
  const history = req.query.status === "history";
  const requests = await prisma.stockDispatchRequest.findMany({
    where: { tenantId: tid, status: history ? { in: ["DISPATCHED", "REJECTED", "CANCELLED"] } : "REQUESTED" },
    include: requestInclude,
    orderBy: history ? { respondedAt: "desc" } : { requestedAt: "asc" },
    take: history ? 100 : 200,
  });
  res.json({ requests: await withStoreStock(tid, requests) });
}));

/** Cheap poll target for a sidebar badge / tab count. */
dispatchRouter.get("/count", handle(async (req, res) => {
  res.json({ pending: await prisma.stockDispatchRequest.count({ where: { tenantId: tenantId(req), status: "REQUESTED" } }) });
}));

const dispatchSchema = z.object({
  // Optional per-line override (e.g. the store only has part of it). Omitted lines go out in full.
  items: z.array(z.object({ itemId: z.string().min(1), quantity: z.coerce.number().min(0) })).optional(),
});

dispatchRouter.post("/:id/dispatch", handle(async (req, res) => {
  const parsed = dispatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new DispatchError("Invalid dispatch quantities");
  const tid = tenantId(req);
  const request = await prisma.stockDispatchRequest.findFirst({ where: { id: req.params.id as string, tenantId: tid }, include: { items: true, fromLocation: { select: { name: true } }, toLocation: { select: { name: true } } } });
  if (!request) throw new DispatchError("Dispatch request not found", 404);
  if (request.status !== "REQUESTED") throw new DispatchError(`This request is already ${request.status.toLowerCase()}`, 409);

  const override = new Map((parsed.data.items ?? []).map((i) => [i.itemId, i.quantity]));
  const lines = request.items.map((item) => ({ item, quantity: override.get(item.id) ?? Number(item.requestedQty) }));
  const toSend = lines.filter((l) => l.quantity > 0);
  if (toSend.length === 0) throw new DispatchError("Dispatch at least one item, or reject the request instead");

  const [actorName, transferNo] = await Promise.all([employeeName(prisma, tid, req.userId), nextStockTransferNo(tid)]);
  await prisma.$transaction(async (tx) => {
    // Claim first: a conditional update so two storekeepers (or a chef cancelling) can't both act.
    const claimed = await tx.stockDispatchRequest.updateMany({ where: { id: request.id, status: "REQUESTED" }, data: { status: "DISPATCHED", respondedAt: new Date(), respondedBy: req.userId ?? null, respondedByName: actorName } });
    if (claimed.count === 0) throw new DispatchError("This request was just handled by someone else", 409);
    const transfer = await performStockTransfer(tx, {
      tenantId: tid, transferNo, fromLocationId: request.fromLocationId, toLocationId: request.toLocationId,
      items: toSend.map((l) => ({ productId: l.item.productId, quantity: l.quantity, name: l.item.productName })),
      note: `Kitchen dispatch ${request.requestNo} for order #${request.orderNumber}`,
      ledgerNote: `Kitchen dispatch ${request.requestNo} (order #${request.orderNumber}): ${request.fromLocation.name} → ${request.toLocation.name}`,
      performedBy: req.userId,
    });
    await tx.stockDispatchRequest.update({ where: { id: request.id }, data: { transferId: transfer.id } });
    for (const l of lines) await tx.stockDispatchItem.update({ where: { id: l.item.id }, data: { dispatchedQty: l.quantity } });
  });
  const fresh = await prisma.stockDispatchRequest.findUniqueOrThrow({ where: { id: request.id }, include: requestInclude });
  res.json({ request: fresh });
}));

dispatchRouter.post("/:id/reject", handle(async (req, res) => {
  const parsed = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(req.body);
  if (!parsed.success) throw new DispatchError("Give the kitchen a reason for rejecting this request");
  const tid = tenantId(req);
  const request = await prisma.stockDispatchRequest.findFirst({ where: { id: req.params.id as string, tenantId: tid }, select: { id: true, status: true } });
  if (!request) throw new DispatchError("Dispatch request not found", 404);
  const actorName = await employeeName(prisma, tid, req.userId);
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.stockDispatchRequest.updateMany({ where: { id: request.id, status: "REQUESTED" }, data: { status: "REJECTED", rejectReason: parsed.data.reason, respondedAt: new Date(), respondedBy: req.userId ?? null, respondedByName: actorName } });
    if (claimed.count === 0) throw new DispatchError(`This request is already ${request.status.toLowerCase()}`, 409);
    // Free the lines so the chef can request again (or the order can be cancelled).
    await tx.posOrderItem.updateMany({ where: { dispatchRequestId: request.id }, data: { dispatchRequestId: null } });
  });
  res.json({ request: await prisma.stockDispatchRequest.findUniqueOrThrow({ where: { id: request.id }, include: requestInclude }) });
}));
