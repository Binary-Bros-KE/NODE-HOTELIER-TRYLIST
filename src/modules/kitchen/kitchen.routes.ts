import { Router } from "express";

import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";

export const kitchenRouter = Router();
kitchenRouter.use(requireModule("KITCHEN"));
const tenantId = (req: { tenantId?: string }) => { if (!req.tenantId) throw new Error("Tenant context is required"); return req.tenantId; };

const orderInclude = {
  table: true,
  items: { include: {
    menuItem: { include: { category: true, product: true, recipe: { include: { ingredients: { include: { product: true } } } } } },
    variant: { select: { name: true } },
    addons: { include: { addon: true } },
  } },
} as const;

/** Live queue created by POS, enriched with menu and linked product recipes. */
kitchenRouter.get("/orders", async (req, res) => {
  const orders = await prisma.posOrder.findMany({ where: { tenantId: tenantId(req), status: { in: ["OPEN", "PREPARING"] } }, include: orderInclude, orderBy: { createdAt: "asc" } });
  res.json({ orders });
});

/** Orders with at least one line added (or bumped) after kitchen/bar already
 * engaged with the ticket once — a round added to a ticket already in
 * PREPARING/READY, or even one already SERVED, which is otherwise silent to
 * kitchen/bar since it doesn't touch the order's own status. Independent of
 * the OPEN/PREPARING queue above: an order can be in both, or in this one
 * alone once it's moved past PREPARING. */
kitchenRouter.get("/orders/updated", async (req, res) => {
  const orders = await prisma.posOrder.findMany({
    where: { tenantId: tenantId(req), status: { notIn: ["CANCELLED", "COMPLETED"] }, items: { some: { addedAfterSend: true } } },
    include: orderInclude,
    orderBy: { updatedAt: "desc" },
  });
  res.json({ orders });
});

/** Acknowledges every flagged line on this order — kitchen/bar has now seen
 * and prepared the addition. Drops the order out of the queue above; doesn't
 * touch the order's own status, which continues as normal. */
kitchenRouter.patch("/orders/:id/ack-updates", async (req, res) => {
  const tid = tenantId(req);
  const order = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  await prisma.posOrderItem.updateMany({ where: { orderId: order.id, addedAfterSend: true }, data: { addedAfterSend: false } });
  res.json({ order: await prisma.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude }) });
});

/** Claims a new ticket for preparation. */
kitchenRouter.patch("/orders/:id/start", async (req, res) => {
  const updated = await prisma.posOrder.updateMany({ where: { id: req.params.id, tenantId: tenantId(req), status: "OPEN" }, data: { status: "PREPARING" } });
  if (!updated.count) { res.status(404).json({ error: "New kitchen order not found" }); return; }
  res.json({ order: await prisma.posOrder.findUniqueOrThrow({ where: { id: req.params.id }, include: orderInclude }) });
});

/** Marks a prepared order ready for the waiter to collect. Stock is consumed
 * later, when the waiter actually serves it (see POST /pos/orders/:id/serve) —
 * that's the point the ingredients are truly gone, not before. */
kitchenRouter.patch("/orders/:id/ready", async (req, res) => {
  const updated = await prisma.posOrder.updateMany({ where: { id: req.params.id, tenantId: tenantId(req), status: "PREPARING" }, data: { status: "READY", readyAt: new Date() } });
  if (!updated.count) { res.status(404).json({ error: "Preparing kitchen order not found" }); return; }
  const order = await prisma.posOrder.findUniqueOrThrow({ where: { id: req.params.id }, include: orderInclude });
  res.json({ notification: { type: "ORDER_READY", message: `Order #${order.orderNumber} is ready to serve` }, order });
});

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
