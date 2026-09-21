import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { mergeDuplicateOrderLines } from "../../lib/orderLines.js";
import { employeeLocationIds } from "../../lib/location.js";
import { DispatchError, createDispatchRequest, orderDispatchInfo } from "../../lib/dispatch.js";

export const kitchenRouter = Router();
kitchenRouter.use(requireModule("KITCHEN"));
const tenantId = (req: { tenantId?: string }) => { if (!req.tenantId) throw new Error("Tenant context is required"); return req.tenantId; };

const orderInclude = {
  table: true,
  location: { select: { id: true, name: true, serveMode: true, requireStoreDispatch: true, dispatchFromLocationId: true } },
  dispatchRequests: { orderBy: { requestedAt: "desc" }, take: 5, select: { id: true, requestNo: true, status: true, rejectReason: true, requestedAt: true, respondedAt: true } },
  items: { include: {
    menuItem: { include: { category: true, product: true, recipe: { include: { ingredients: { include: { product: true } } } } } },
    variant: { select: { id: true, name: true, stockProductId: true, stockQtyPerUnit: true, stockProduct: { select: { id: true, name: true } } } },
    addons: { include: { addon: { include: { stockProduct: { select: { id: true, name: true } } } } } },
    dispatchRequest: { select: { id: true, requestNo: true, status: true } },
  } },
} satisfies Prisma.PosOrderInclude;

type KitchenOrder = Prisma.PosOrderGetPayload<{ include: typeof orderInclude }>;
const withDispatch = (order: KitchenOrder) => ({ ...order, dispatch: orderDispatchInfo(order) });

// Same wrapper idea as housekeeping: handlers throw DispatchError, get a clean status.
const handle = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((error) => {
    if (error instanceof DispatchError) { res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) }); return; }
    next(error);
  });
};

/** A kitchen employee only sees (and can move) tickets from the locations they
 * are assigned to; an unrestricted one may narrow with ?locationId=. */
async function locationScope(req: Request): Promise<Prisma.PosOrderWhereInput> {
  const tid = tenantId(req);
  const pinned = await employeeLocationIds(tid, req.userId);
  const requested = typeof req.query.locationId === "string" && req.query.locationId ? req.query.locationId : undefined;
  if (requested && pinned.length > 0 && !pinned.includes(requested)) throw new DispatchError("You can only work tickets from your own locations", 403);
  if (requested) return { locationId: requested };
  if (pinned.length > 0) return { locationId: { in: pinned } };
  return {};
}

async function loadTicket(req: Request, status: string[]) {
  const order = await prisma.posOrder.findFirst({ where: { id: req.params.id as string, tenantId: tenantId(req), status: { in: status as never[] }, ...(await locationScope(req)) }, include: orderInclude });
  if (!order) throw new DispatchError("Kitchen order not found", 404);
  return order;
}

/** Live queue created by POS, enriched with menu and linked product recipes. */
kitchenRouter.get("/orders", handle(async (req, res) => {
  const orders = await prisma.posOrder.findMany({ where: { tenantId: tenantId(req), status: { in: ["OPEN", "PREPARING"] }, ...(await locationScope(req)) }, include: orderInclude, orderBy: { createdAt: "asc" } });
  res.json({ orders: orders.map(withDispatch) });
}));

/** Orders with at least one line added (or bumped) after kitchen/bar already
 * engaged with the ticket once — a round added to a ticket already in
 * PREPARING/READY, or even one already SERVED, which is otherwise silent to
 * kitchen/bar since it doesn't touch the order's own status. Independent of
 * the OPEN/PREPARING queue above: an order can be in both, or in this one
 * alone once it's moved past PREPARING. */
kitchenRouter.get("/orders/updated", handle(async (req, res) => {
  const orders = await prisma.posOrder.findMany({
    where: { tenantId: tenantId(req), status: { notIn: ["CANCELLED", "COMPLETED"] }, items: { some: { addedAfterSend: true } }, ...(await locationScope(req)) },
    include: orderInclude,
    orderBy: { updatedAt: "desc" },
  });
  res.json({ orders: orders.map(withDispatch) });
}));

/** Acknowledges every flagged line on this order — kitchen/bar has now seen
 * and prepared the addition. Drops the order out of the queue above; doesn't
 * touch the order's own status, which continues as normal. */
kitchenRouter.patch("/orders/:id/ack-updates", handle(async (req, res) => {
  const order = await loadTicket(req, ["OPEN", "PREPARING", "READY", "SERVED"]);
  await prisma.$transaction(async (tx) => {
    await tx.posOrderItem.updateMany({ where: { orderId: order.id, addedAfterSend: true }, data: { addedAfterSend: false } });
    // Acknowledged: the bar has seen the additions, so fold identical lines
    // together (5 x White Cap, not 1 + 1 + 1 + 2) to keep the bill short.
    await mergeDuplicateOrderLines(tx, order.id, { includeFlagged: false });
  });
  res.json({ order: withDispatch(await prisma.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude })) });
}));

const DISPATCH_FIRST = "Ask the store to dispatch the ingredients first";

/** Claims a new ticket for preparation, recording who started it and when.
 * Where the location requires store dispatch, the ingredients must have been
 * dispatched first. */
kitchenRouter.patch("/orders/:id/start", handle(async (req, res) => {
  const order = await loadTicket(req, ["OPEN"]);
  const dispatch = orderDispatchInfo(order);
  if (!dispatch.clear) throw new DispatchError(dispatch.state === "WAITING" ? "Waiting for the store to dispatch the ingredients" : DISPATCH_FIRST, 409, "DISPATCH_REQUIRED");
  const claimed = await prisma.posOrder.updateMany({ where: { id: order.id, tenantId: tenantId(req), status: "OPEN" }, data: { status: "PREPARING", preparingAt: new Date(), preparingBy: req.userId ?? null } });
  if (!claimed.count) throw new DispatchError("This ticket was already started", 409);
  res.json({ order: withDispatch(await prisma.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude })) });
}));

/** Marks a prepared order ready for the waiter to collect. Stock is consumed
 * later, when the waiter actually serves it (see POST /pos/orders/:id/serve) —
 * that's the point the ingredients are truly gone, not before. */
kitchenRouter.patch("/orders/:id/ready", handle(async (req, res) => {
  const order = await loadTicket(req, ["PREPARING"]);
  // A round added mid-prep needs its own dispatch before the ticket can finish.
  const dispatch = orderDispatchInfo(order);
  if (!dispatch.clear) throw new DispatchError(dispatch.state === "WAITING" ? "Waiting for the store to dispatch the added items" : "Request the added items from the store first", 409, "DISPATCH_REQUIRED");
  const claimed = await prisma.posOrder.updateMany({ where: { id: order.id, tenantId: tenantId(req), status: "PREPARING" }, data: { status: "READY", readyAt: new Date(), readyBy: req.userId ?? null } });
  if (!claimed.count) throw new DispatchError("This ticket is no longer being prepared", 409);
  const fresh = await prisma.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  res.json({ notification: { type: "ORDER_READY", message: `Order #${fresh.orderNumber} is ready to serve` }, order: withDispatch(fresh) });
}));

/** The chef asks the store for the ingredients of every line not yet covered. */
kitchenRouter.post("/orders/:id/request-dispatch", handle(async (req, res) => {
  const order = await loadTicket(req, ["OPEN", "PREPARING", "READY"]);
  const request = await createDispatchRequest({ ...order, tenantId: tenantId(req) }, req.userId, typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : undefined);
  res.status(201).json({ request, order: withDispatch(await prisma.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude })) });
}));

/** Withdraws a still-waiting request (asked by mistake); its lines become requestable again. */
kitchenRouter.post("/orders/:id/cancel-dispatch", handle(async (req, res) => {
  const order = await loadTicket(req, ["OPEN", "PREPARING", "READY"]);
  await prisma.$transaction(async (tx) => {
    const waiting = await tx.stockDispatchRequest.findMany({ where: { orderId: order.id, tenantId: tenantId(req), status: "REQUESTED" }, select: { id: true } });
    if (waiting.length === 0) throw new DispatchError("There is no waiting request to cancel", 409);
    const ids = waiting.map((w) => w.id);
    // Conditional on still REQUESTED: a store that dispatched in the meantime wins.
    const cancelled = await tx.stockDispatchRequest.updateMany({ where: { id: { in: ids }, status: "REQUESTED" }, data: { status: "CANCELLED", respondedAt: new Date(), respondedBy: req.userId ?? null } });
    if (cancelled.count !== ids.length) throw new DispatchError("The store already dispatched this request", 409);
    await tx.posOrderItem.updateMany({ where: { dispatchRequestId: { in: ids } }, data: { dispatchRequestId: null } });
  });
  res.json({ order: withDispatch(await prisma.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude })) });
}));

/** Product-backed menu and recipe snapshot used by the kitchen side panel. */
kitchenRouter.get("/menu-items", async (req, res) => {
  const productWithStock = { include: { stocks: { select: { quantity: true } } } } as const;
  const rows = await prisma.menuItem.findMany({ where: { tenantId: tenantId(req), isAvailable: true }, include: { menuCategory: true, product: productWithStock, recipe: { include: { ingredients: { include: { product: productWithStock } } } } }, orderBy: [{ menuCategory: { sortOrder: "asc" } }, { sortOrder: "asc" }, { name: "asc" }] });
  const items = rows.map(({ menuCategory, ...item }) => ({ ...item, category: menuCategory }));
  res.json({ items });
});

kitchenRouter.get("/drink-offerings", async (req, res) => {
  const productStockFields = { id: true, name: true, unit: true, stocks: { select: { quantity: true } } } as const;
  const rows = await prisma.menuItem.findMany({ where: { tenantId: tenantId(req), isAvailable: true }, select: { id: true, name: true, description: true, temperature: true, menuCategory: { select: { name: true } }, product: { select: productStockFields }, recipe: { include: { ingredients: { include: { product: { select: productStockFields } } } } } }, orderBy: [{ temperature: "asc" }, { name: "asc" }] });
  const drinks = rows.map(({ menuCategory, ...d }) => ({ ...d, category: menuCategory }));
  const offerings = { hot: drinks.filter((drink) => drink.temperature === "HOT"), cold: drinks.filter((drink) => drink.temperature === "COLD"), other: drinks.filter((drink) => drink.temperature === "OTHER") };
  res.json({ offerings, summary: { hot: offerings.hot.length, cold: offerings.cold.length, other: offerings.other.length } });
});
