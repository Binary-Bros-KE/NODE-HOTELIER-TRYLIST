import { Router } from "express";
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { requireModule, requirePermission, hasPermission } from "../../middleware/tenantContext.js";
import { prisma } from "../../lib/prisma.js";
import { computeOrderFinancials } from "../../lib/orderTotals.js";
import { nextTransactionNo } from "../../lib/sequence.js";
import { resolveEffectiveLocation, employeeLocationId } from "../../lib/location.js";
import { recordStockMovement, InsufficientStockError } from "../../lib/stockLedger.js";
import { recordMenuLedger, menuLedgerLinesFromItems } from "../../lib/menuLedger.js";
import { mergeDuplicateOrderLines } from "../../lib/orderLines.js";
import { computeStockRequirements, addonStockInclude, addonStockSelect, serviceStockSelect, serviceVariantStockSelect, variantStockInclude, variantStockSelect, type OrderItemForStock } from "../../lib/stockRequirements.js";
import { DispatchError, dispatchRequired, orderDispatchInfo, supplyingStoreId } from "../../lib/dispatch.js";
import { autoRequestDispatch, dispatchSlipFor, refreshOpenRequest } from "../../lib/dispatchAuto.js";
import { deductStockForOrder, hasPendingAdditions, isUndeductedAddition, settleServedAdditions } from "../../lib/orderStock.js";

// POS configuration, stores, and stock all remain scoped to the tenant supplied
// by the authenticated request context (currently x-tenant-id during scaffolding).
export const posRouter = Router();

posRouter.use(requireModule("POS"));

const settingsSchema = z.object({
  cafeName: z.string().trim().min(2).max(120),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  inventoryEnabled: z.boolean(),
  lowStockAlerts: z.boolean(),
});

type SaleProductSnapshot = Prisma.ProductGetPayload<{
  select: { id: true; name: true; sellingPrice: true; taxRate: true; taxMode: true; taxTreatment: true; packSize: true };
}>;

// reservationId is optional "remember this bar tab is for Room 12" — it
// stamps the checked-in stay onto the order so settlement can default to
// charging the folio, but it does NOT charge the folio now (a tab isn't
// paid until the guest is done, and they may still settle in cash).
// A single line the cashier is ringing up: a menu item, optionally a specific
// variant (size/option), and any chosen add-ons. Variant choice and add-on
// group rules are validated against the live menu in resolveMenuLines().
const orderLineSchema = z.object({
  menuItemId: z.string().cuid(),
  variantId: z.string().cuid().optional(),
  quantity: z.coerce.number().int().min(1).max(50),
  addons: z.array(z.object({ addonId: z.string().cuid(), quantity: z.coerce.number().int().min(1).max(20).default(1) })).default([]),
});
const optionalDate = z.preprocess((value) => value === "" || value == null ? undefined : value, z.coerce.date().optional());
const complimentarySessionSchema = z.object({
  title: z.string().trim().min(1).max(150),
  hostName: z.string().trim().min(1).max(120),
  hostPhone: z.string().trim().max(40).optional(),
  eventDate: z.coerce.date().optional(),
  startsAt: optionalDate,
  endsAt: optionalDate,
  notes: z.string().trim().max(500).optional(),
}).refine((value) => !value.endsAt || !value.startsAt || value.endsAt > value.startsAt, { path: ["endsAt"], message: "End time must be after start time" });
const orderSchema = z.object({
  tableId: z.string().cuid().optional(),
  locationId: z.string().cuid().optional(),
  customerId: z.string().trim().min(1).optional(),
  reservationId: z.string().trim().min(1).optional(),
  notes: z.string().trim().max(500).optional(),
  discount: z.coerce.number().min(0).default(0),
  saleType: z.enum(["SALE", "COMPLIMENTARY"]).default("SALE"),
  complimentarySessionId: z.string().cuid().optional(),
  complimentaryOrderRole: z.enum(["HOST_COMP", "GUEST_SPEND"]).optional(),
  complimentaryReason: z.string().trim().max(255).optional(),
  complimentaryRecipientName: z.string().trim().max(120).optional(),
  items: z.array(orderLineSchema).min(1),
});
const addItemsSchema = z.object({ items: z.array(orderLineSchema).min(1) });
const settleSchema = z.object({
  creditReason: z.string().trim().min(3).max(255).optional(),
  creditExpectedAt: optionalDate,
});
const returnRequestSchema = z.object({
  quantity: z.coerce.number().int().min(1).max(50),
  reason: z.string().trim().min(3).max(255),
});
const orderReturnRequestSchema = z.object({
  reason: z.string().trim().min(3).max(255),
  items: z.array(z.object({
    orderItemId: z.string().cuid(),
    quantity: z.coerce.number().int().min(1).max(50),
  })).min(1),
});
const returnDecisionSchema = z.object({
  note: z.string().trim().max(300).optional(),
});

// Editing one existing line: any facet omitted keeps its current value.
const editItemSchema = z.object({
  variantId: z.string().cuid().nullable().optional(),
  quantity: z.coerce.number().int().min(1).max(50).optional(),
  addons: z.array(z.object({ addonId: z.string().cuid(), quantity: z.coerce.number().int().min(1).max(20).default(1) })).optional(),
});

type OrderLineInput = z.infer<typeof orderLineSchema>;

// What resolveMenuLines needs to price a line: the item's active variants
// and the product/recipe used later for stock deduction. Add-ons are a flat
// tenant catalog now — validated separately, not per item.
const menuLineInclude = {
  variants: { where: { isActive: true }, include: variantStockInclude },
  product: true,
  recipe: { include: { ingredients: { include: { product: true } } } },
} satisfies Prisma.MenuItemInclude;

type LineTaxSnapshot = {
  taxRate: Prisma.Decimal | null;
  taxMode: "INCLUSIVE" | "EXCLUSIVE" | null;
  taxTreatment: "STANDARD" | "ZERO_RATED" | "EXEMPT" | null;
};

type ResolvedLine = {
  menuItemId: string;
  variantId: string | undefined;
  quantity: number;
  unitPrice: Prisma.Decimal;
  addons: { addonId: string; quantity: number; unitPrice: Prisma.Decimal }[];
} & LineTaxSnapshot;

/** Validates a set of POS order lines against the current menu — item
 * availability, variant choice (required once an item has variants), and
 * that every chosen add-on is an active add-on for this tenant — and returns
 * each line with its resolved prices and tax snapshot, plus the menu items
 * (with product/recipe) for downstream stock maths. Throws { status: 400 }
 * on the first problem. */
async function resolveMenuLines(tid: string, lines: OrderLineInput[], taxDefaults: TaxDefaults | null) {
  const menuItemIds = [...new Set(lines.map((line) => line.menuItemId))];
  const addonIds = [...new Set(lines.flatMap((line) => line.addons.map((a) => a.addonId)))];
  const [menuItems, addons] = await Promise.all([
    prisma.menuItem.findMany({ where: { id: { in: menuItemIds }, tenantId: tid, isAvailable: true }, include: menuLineInclude }),
    addonIds.length
      ? prisma.addon.findMany({
          where: { id: { in: addonIds }, tenantId: tid, isActive: true, scope: "MENU" },
          select: addonStockSelect,
        })
      : Promise.resolve([]),
  ]);
  const byId = new Map(menuItems.map((item) => [item.id, item]));
  if (byId.size !== menuItemIds.length) {
    throw Object.assign(new Error("Every order item must be an available menu item from this café"), { status: 400 });
  }
  const priceByAddon = new Map(addons.map((a) => [a.id, a.price]));
  if (priceByAddon.size !== addonIds.length) {
    throw Object.assign(new Error("Every add-on must be an active add-on from this café"), { status: 400 });
  }

  const resolved: ResolvedLine[] = lines.map((line) => {
    const item = byId.get(line.menuItemId)!;

    // Variant — mandatory once the item defines any, and it must be one of
    // this item's own active variants. Its price replaces the base price.
    let variantId: string | undefined;
    let unitPrice = item.price;
    if (line.variantId) {
      const variant = item.variants.find((v) => v.id === line.variantId);
      if (!variant) throw Object.assign(new Error(`Choose a valid option for ${item.name}`), { status: 400 });
      variantId = variant.id;
      unitPrice = variant.price;
    } else if (item.variants.length > 0) {
      throw Object.assign(new Error(`Choose an option for ${item.name}`), { status: 400 });
    }

    if (line.addons.length > 0 && !item.allowsAddons) {
      throw Object.assign(new Error(`${item.name} doesn't take add-ons`), { status: 400 });
    }

    return {
      menuItemId: line.menuItemId,
      variantId,
      quantity: line.quantity,
      unitPrice,
      addons: line.addons.map((sel) => ({ addonId: sel.addonId, quantity: sel.quantity, unitPrice: priceByAddon.get(sel.addonId)! })),
      ...resolveLineTax(item, taxDefaults),
    };
  });

  return { lines: resolved, menuItemsById: byId, addonsById: new Map(addons.map((a) => [a.id, a])) };
}

/** Turns resolved lines into a Prisma `items.create` payload. */
function lineCreatePayload(lines: ResolvedLine[]): Prisma.PosOrderItemCreateWithoutOrderInput[] {
  return lines.map((line) => ({
    menuItemId: line.menuItemId,
    variantId: line.variantId,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    taxRate: line.taxRate,
    taxMode: line.taxMode,
    taxTreatment: line.taxTreatment,
    addons: { create: line.addons.map((addon) => ({ addonId: addon.addonId, quantity: addon.quantity, unitPrice: addon.unitPrice })) },
  }));
}

// Bill-to-room is decided at settlement, not order creation — a tab isn't
// paid until the customer is done, and they may not know or may change
// their mind about cash vs. room until then. "ROOM" resolves which
// checked-in stay to charge at that moment, same as a PAY resolves which
// payment method.
const paymentSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("PAY"), paymentMethodId: z.string().trim().min(1), amount: z.coerce.number().positive(), reference: z.string().trim().max(120).optional() }),
  z.object({ method: z.literal("ROOM"), reservationId: z.string().trim().min(1), amount: z.coerce.number().positive() }),
]);

const retailOrderSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("PRODUCTS"),
    locationId: z.string().trim().min(1).optional(),
    customerId: z.string().trim().min(1).optional(),
    notes: z.string().trim().max(500).optional(),
    discount: z.coerce.number().min(0).default(0),
    items: z.array(z.object({ productId: z.string().trim().min(1), quantity: z.coerce.number().int().min(1).max(999) })).min(1),
  }),
  z.object({
    channel: z.literal("SERVICES"),
    locationId: z.string().trim().min(1).optional(),
    customerId: z.string().trim().min(1).optional(),
    notes: z.string().trim().max(500).optional(),
    discount: z.coerce.number().min(0).default(0),
    items: z.array(z.object({
      serviceId: z.string().trim().min(1),
      variantId: z.string().trim().min(1).optional(),
      quantity: z.coerce.number().int().min(1).max(999),
      addons: z.array(z.object({ addonId: z.string().trim().min(1), quantity: z.coerce.number().int().min(1).max(20).default(1) })).default([]),
      // Price override at the till: the price to charge instead of the list price, with why.
      unitPrice: z.coerce.number().min(0).max(9_999_999).optional(),
      overrideReason: z.string().trim().max(200).optional(),
    })).min(1),
  }),
]);

async function resolvePaymentMethod(tid: string, paymentMethodId: string, reference: string | undefined) {
  const method = await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, tenantId: tid, isActive: true } });
  if (!method) throw Object.assign(new Error("Choose a valid, active payment method"), { status: 400 });
  if (method.requiresReference && !reference) throw Object.assign(new Error(`${method.name} requires a reference number`), { status: 400 });
  return method;
}

function tenantIdFor(request: { tenantId?: string }): string {
  if (!request.tenantId) throw new Error("Tenant context is required");
  return request.tenantId;
}

export const orderInclude = {
  items: { include: {
    menuItem: { include: { product: true, recipe: { include: { ingredients: { include: { product: true } } } } } },
    variant: { select: variantStockSelect },
    product: { select: { id: true, name: true, unit: true } },
    // A service line carries what it consumes (its own product/recipe, like a menu item) and its variant.
    service: { select: { ...serviceStockSelect, unit: { select: { name: true } } } },
    serviceVariant: { select: serviceVariantStockSelect },
    addons: { include: { addon: { include: addonStockInclude } } },
    returnRequests: { orderBy: { requestedAt: "desc" } },
    dispatchRequest: { select: { status: true } },
  } },
  payments: { include: { paymentMethod: { select: { id: true, name: true, requiresReference: true } } } },
  table: true,
  location: true,
  complimentarySession: true,
  customer: { select: { id: true, firstName: true, lastName: true, phone: true, balance: true } },
  reservation: { select: { id: true, reservationNo: true, customerId: true, customer: { select: { firstName: true, lastName: true } }, room: { select: { number: true } } } },
  returnRequests: {
    include: {
      orderItem: { include: { menuItem: { select: { name: true } }, variant: { select: { name: true } } } },
    },
    orderBy: { requestedAt: "desc" },
  },
} as const;

posRouter.get("/complimentary-sessions", async (req, res) => {
  const tid = tenantIdFor(req);
  const activeOnly = req.query.activeOnly === "true";
  const sessions = await prisma.complimentarySession.findMany({
    where: { tenantId: tid, ...(activeOnly ? { status: "OPEN" } : {}) },
    include: { _count: { select: { orders: true } } },
    orderBy: [{ status: "asc" }, { startsAt: "desc" }, { eventDate: "desc" }],
    take: 100,
  });
  res.status(200).json({ sessions });
});

posRouter.post("/complimentary-sessions", async (req, res, next) => {
  const parsed = complimentarySessionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid complimentary session", details: parsed.error.flatten() }); return; }
  try {
    const startsAt = parsed.data.startsAt ?? parsed.data.eventDate ?? new Date();
    const session = await prisma.complimentarySession.create({
      data: { ...parsed.data, tenantId: tenantIdFor(req), createdBy: req.userId, eventDate: parsed.data.eventDate ?? startsAt, startsAt },
      include: { _count: { select: { orders: true } } },
    });
    res.status(201).json({ session });
  } catch (error) {
    next(error);
  }
});

/** Validates an explicitly-chosen customerId belongs to this tenant — who a
 * sale is for is always optional (a quick anonymous cash sale shouldn't have
 * to stop and create a customer record), but when given it must be real. */
async function resolveCustomerId(tid: string, customerId: string | undefined): Promise<string | undefined> {
  if (!customerId) return undefined;
  const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: tid }, select: { id: true } });
  if (!customer) throw Object.assign(new Error("Choose a customer from this property"), { status: 400 });
  return customer.id;
}

/** Resolves a reservation this order can be billed to: must belong to this
 * tenant, be checked in, and have an open folio to receive the charge.
 * Returns null when no reservationId was given (the normal case — most
 * sales are paid for directly, not billed to a room). */
async function resolveBillableReservation(tid: string, reservationId: string | undefined) {
  if (!reservationId) return null;
  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, tenantId: tid, status: "CHECKED_IN" },
    include: { folio: true },
  });
  if (!reservation || !reservation.folio || reservation.folio.status !== "OPEN") {
    throw Object.assign(new Error("Choose a checked-in stay with an open folio to bill this to"), { status: 400 });
  }
  return reservation;
}

/** Charges a finalized sale to a guest's folio instead of collecting payment
 * directly — settled later alongside the room bill at checkout, the same
 * way a SERVICE or AD_HOC charge already is. No Transaction is written here:
 * a charge isn't a payment, the guest hasn't handed over money yet. */
async function chargeOrderToFolio(
  tx: Prisma.TransactionClient,
  tid: string,
  folioId: string,
  order: { id: string; orderNumber: number; channel: string },
  amount: number,
  req: { userId?: string },
) {
  if (amount <= 0) return;
  const channelLabel = order.channel === "FOOD" ? "Order" : order.channel === "PRODUCTS" ? "Retail sale" : "Service sale";
  await tx.folioLineItem.create({
    data: { tenantId: tid, folioId, source: "POS_ORDER", label: `${channelLabel} #${order.orderNumber}`, amount, quantity: 1, sourceRefId: order.id, createdBy: req.userId },
  });
}

export async function taxSettingsFor(tid: string) {
  const profile = await prisma.businessProfile.findUnique({ where: { tenantId: tid }, select: { taxRate: true, taxMode: true, taxTreatment: true } });
  return profile ?? null;
}

type TaxDefaults = NonNullable<Awaited<ReturnType<typeof taxSettingsFor>>>;

/** The tax a POS line is sold under: the menu item's own override for any
 * facet it sets, else the tenant default. Snapshotted onto PosOrderItem so a
 * later change to either never re-taxes a historical order. */
function resolveLineTax(
  item: { taxRate: Prisma.Decimal | null; taxMode: "INCLUSIVE" | "EXCLUSIVE" | null; taxTreatment: "STANDARD" | "ZERO_RATED" | "EXEMPT" | null },
  fallback: TaxDefaults | null,
) {
  return {
    taxRate: item.taxRate ?? fallback?.taxRate ?? null,
    taxMode: item.taxMode ?? fallback?.taxMode ?? null,
    taxTreatment: item.taxTreatment ?? fallback?.taxTreatment ?? null,
  };
}

type FinancialOrder = Parameters<typeof computeOrderFinancials>[0] & { payments: { amount: Prisma.Decimal }[] };

/** Attaches the money breakdown (subtotal/discount/tax/total) plus the flat
 * total/paid fields older frontend callers already read. */
export function withFinancials<T extends FinancialOrder>(order: T, tax: Awaited<ReturnType<typeof taxSettingsFor>>) {
  const financials = computeOrderFinancials(order, tax);
  const paid = order.payments.reduce((s, p) => s + Number(p.amount), 0);
  return { ...order, financials, total: financials.total, paid };
}

function hasPendingReturnRequests(order: { returnRequests?: { status: string }[]; items?: { returnRequests?: { status: string }[] }[] }) {
  return Boolean(
    order.returnRequests?.some((request) => request.status === "PENDING")
    || order.items?.some((item) => item.returnRequests?.some((request) => request.status === "PENDING")),
  );
}

/** Resolves createdBy (the employee who rang the order up — "served by" on
 * the receipt) to a name. Plain id, no Prisma relation (see the field's own
 * comment), so it's one extra lookup rather than an include. Used only where
 * a receipt actually renders — GET /orders/:id and the public share route. */
export async function withServedBy<T extends { createdBy: string | null }>(
  order: T,
): Promise<T & { servedBy: { firstName: string; lastName: string } | null }> {
  if (!order.createdBy) return { ...order, servedBy: null };
  const employee = await prisma.employee.findUnique({ where: { id: order.createdBy }, select: { firstName: true, lastName: true } });
  return { ...order, servedBy: employee ? { firstName: employee.firstName, lastName: employee.lastName } : null };
}

/** Frees a table back to AVAILABLE if it has no other active order. Call from inside the same transaction that finalized the order. */
async function releaseTableIfIdle(tx: Prisma.TransactionClient, tableId: string) {
  const stillActive = await tx.posOrder.findFirst({ where: { tableId, status: { in: ["OPEN", "PREPARING", "READY", "SERVED"] } } });
  if (!stillActive) await tx.table.updateMany({ where: { id: tableId }, data: { status: "AVAILABLE" } });
}

const money2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** UNPAID / PARTIAL / PAID from what's been paid against the order total. */
function paymentStatusFor(paid: number, total: number): "UNPAID" | "PARTIAL" | "PAID" {
  if (paid >= total - 0.01) return "PAID";
  return paid > 0.01 ? "PARTIAL" : "UNPAID";
}

/** What a completed order still owes — its contribution to the customer's
 * balance. Zero for anything not completed, or already covered. */
function orderOutstanding(status: string, paid: number, total: number): number {
  return status === "COMPLETED" ? Math.max(0, money2(total - paid)) : 0;
}

/** Moves a customer's balance by a signed delta and writes the matching
 * ledger row with the running balance after. No-op for a zero delta. */
async function applyCustomerBalance(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; customerId: string; orderId: string | null; delta: number; type: "CREDIT" | "REPAYMENT" | "ADJUSTMENT"; note?: string | null; by?: string | null },
) {
  const delta = money2(args.delta);
  if (delta === 0) return;
  const c = await tx.customer.update({ where: { id: args.customerId }, data: { balance: { increment: delta } }, select: { balance: true } });
  await tx.customerCreditEntry.create({
    data: {
      tenantId: args.tenantId, customerId: args.customerId, orderId: args.orderId ?? undefined,
      type: args.type, amount: delta, balanceAfter: c.balance, note: args.note ?? undefined, createdBy: args.by ?? undefined,
    },
  });
}

/** Keeps the customer's balance in step with what one order still owes.
 * Idempotent: compares the order's current outstanding against what it has
 * already pushed onto the balance (its own ledger rows) and moves the
 * balance by the difference. Call inside the tx after any change to an
 * order's paid amount or status; `paid`/`total` are the post-change values. */
async function reconcileOrderCredit(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; orderId: string; orderNumber: number; customerId: string | null; status: string; paid: number; total: number; by?: string | null },
) {
  if (!args.customerId) return;
  const desired = orderOutstanding(args.status, args.paid, args.total);
  const prior = await tx.customerCreditEntry.aggregate({
    where: { orderId: args.orderId, type: { in: ["CREDIT", "REPAYMENT"] } },
    _sum: { amount: true },
  });
  const recorded = money2(Number(prior._sum.amount ?? 0));
  const delta = money2(desired - recorded);
  if (delta === 0) return;
  await applyCustomerBalance(tx, {
    tenantId: args.tenantId, customerId: args.customerId, orderId: args.orderId, delta,
    type: delta > 0 ? "CREDIT" : "REPAYMENT",
    note: delta > 0 ? `Order #${args.orderNumber} completed on credit` : `Repayment against order #${args.orderNumber}`,
    by: args.by,
  });
}

/** Whether this employee should see every order, not just the ones they
 * rang up themselves — either explicitly granted, or implied by holding an
 * approval capability (approving counter orders/cancellations for everyone
 * else obviously requires being able to see everyone else's orders too). */
async function canSeeAllOrders(tid: string, userId: string | undefined): Promise<boolean> {
  const [viewAll, approveCounter, approveCancellation] = await Promise.all([
    hasPermission(tid, userId, "POS_VIEW_ALL_ORDERS"),
    hasPermission(tid, userId, "POS_APPROVE_COUNTER"),
    hasPermission(tid, userId, "POS_APPROVE_CANCELLATION"),
  ]);
  return viewAll || approveCounter || approveCancellation;
}

/** Whether this bill is this employee's own — the one check that has NO
 * manager override, unlike canSeeAllOrders above. Editing an order's items,
 * attaching a customer, requesting a return/cancellation, taking a payment,
 * or completing the order are all things you do to your own tab only; a
 * supervisor with POS_VIEW_ALL_ORDERS can *see* everyone's orders but can't
 * touch someone else's bill through these actions. The only cross-employee
 * action left is printing/sharing a receipt, which has no ownership check at
 * all. An order from before createdBy existed (null) has no owner to
 * restrict to, so it's left open rather than permanently unmanageable.
 */
function ownsOrder(order: { createdBy: string | null }, req: { userId?: string }): boolean {
  return !order.createdBy || order.createdBy === req.userId;
}

/** Super Admin is the one role that may reverse a bill it didn't ring up, or
 * one past the waiters' return window — for the genuine mistake nobody else
 * can fix. Used only by the cancel/return-request paths; it still goes
 * through normal approval, so stock and payments are unwound the same way. */
async function isSuperAdminUser(tid: string, userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const employee = await prisma.employee.findFirst({ where: { id: userId, tenantId: tid, status: "ACTIVE" }, select: { role: { select: { name: true } } } });
  return employee?.role?.name === "Super Admin";
}

// A fixed-location employee only ever sees their own location's orders; a
// floating one (a manager) sees everything by default — unlike ringing up a
// live sale, browsing order history isn't blocked by an unclear location, so
// an optional ?locationId= is offered instead of forcing a pick. Orders
// record where they actually happened, so this is an exact match — not the
// "unallocated = everywhere" convention used for menu items/tables.
// On top of location, an employee without canSeeAllOrders only sees orders
// they themselves rang up — a waiter's list, a counter/manager's everyone's.
posRouter.get("/orders", async (req, res) => {
  const query = z.object({
    status: z.enum(["OPEN", "PREPARING", "READY", "SERVED", "COMPLETED", "CANCELLED", "PENDING_CANCELLATION"]).optional(),
    channel: z.enum(["FOOD", "PRODUCTS", "SERVICES"]).optional(),
    locationId: z.string().cuid().optional(),
    // Only meaningful for someone with canSeeAllOrders — see below, an
    // employee restricted to their own orders can't use this to browse
    // someone else's regardless of what they pass here.
    employeeId: z.string().cuid().optional(),
    // Only sales where a line was sold at a price other than its list price (till override audit).
    overridden: z.enum(["true"]).optional(),
    // Cap the rows returned (most recent first) so a long-lived POS screen
    // doesn't drag in thousands of historical orders. Omitted = no cap.
    limit: z.coerce.number().int().min(1).max(500).optional(),
    // Same from/to convention as GET /transactions — date-only strings,
    // inclusive on both ends (the day named by `to` is fully included, not
    // cut off at its midnight).
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid filters" }); return; }
  const tid = tenantIdFor(req);
  const [fixedLocationId, canSeeAll] = await Promise.all([employeeLocationId(tid, req.userId), canSeeAllOrders(tid, req.userId)]);
  const effectiveLocationId = fixedLocationId ?? query.data.locationId ?? null;
  const [orders, tax] = await Promise.all([
    prisma.posOrder.findMany({
      where: {
        tenantId: tid,
        ...(query.data.status ? { status: query.data.status } : {}),
        ...(query.data.channel ? { channel: query.data.channel } : {}),
        ...(query.data.overridden ? { items: { some: { listPrice: { not: null } } } } : {}),
        ...(effectiveLocationId ? { locationId: effectiveLocationId } : {}),
        ...(canSeeAll
          ? (query.data.employeeId ? { createdBy: query.data.employeeId } : {})
          : { createdBy: req.userId ?? "__unauthenticated__" }),
        ...(query.data.from || query.data.to ? {
          createdAt: {
            ...(query.data.from ? { gte: query.data.from } : {}),
            ...(query.data.to ? { lt: new Date(query.data.to.getTime() + 24 * 60 * 60 * 1000) } : {}),
          },
        } : {}),
      },
      include: orderInclude,
      orderBy: { createdAt: "desc" },
      ...(query.data.limit ? { take: query.data.limit } : {}),
    }),
    taxSettingsFor(tid),
  ]);
  res.status(200).json({ orders: orders.map((order) => withFinancials(order, tax)) });
});

/** POS notification queue: Kitchen places finished orders here for serving.
 * Same ownership scoping as the list above — a waiter is only pinged for
 * their own tickets going READY, not the whole property's. */
posRouter.get("/orders/ready", async (req, res) => {
  const tid = tenantIdFor(req);
  const canSeeAll = await canSeeAllOrders(tid, req.userId);
  const [orders, tax] = await Promise.all([
    prisma.posOrder.findMany({
      where: { tenantId: tid, status: "READY", ...(canSeeAll ? {} : { createdBy: req.userId ?? "__unauthenticated__" }) },
      include: orderInclude,
      orderBy: { readyAt: "asc" },
    }),
    taxSettingsFor(tid),
  ]);
  res.status(200).json({ notifications: orders.map((order) => ({ type: "ORDER_READY", message: `Order #${order.orderNumber} is ready to serve`, order: withFinancials(order, tax) })) });
});

posRouter.post("/orders", async (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid order", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const tax = await taxSettingsFor(tid);
  let resolvedLines: ResolvedLine[];
  let menuItemsById: Awaited<ReturnType<typeof resolveMenuLines>>["menuItemsById"];
  let addonsById: Awaited<ReturnType<typeof resolveMenuLines>>["addonsById"];
  try {
    ({ lines: resolvedLines, menuItemsById, addonsById } = await resolveMenuLines(tid, parsed.data.items, tax));
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
  if (parsed.data.tableId) {
    const table = await prisma.table.findFirst({ where: { id: parsed.data.tableId, tenantId: tid, isActive: true } });
    if (!table) { res.status(400).json({ error: "Choose an active table from this property" }); return; }
    // A table can carry several separate, independently-billed orders at
    // once (a 6-seat table might have two couples each running their own
    // tab) — only a table that's actually out of service blocks a new one.
    if (table.status === "OUT_OF_SERVICE") { res.status(409).json({ error: "This table is out of service" }); return; }
  }

  const locationResult = await resolveEffectiveLocation(tid, req.userId, parsed.data.locationId);
  if ("error" in locationResult) { res.status(400).json({ error: locationResult.error }); return; }
  const { location } = locationResult;
  if (location && !location.canSellMenu) { res.status(409).json({ error: `${location.name} isn't set up to sell menu items` }); return; }
  const effectiveLocationId = location?.id ?? null;
  // Owner-controlled per location (Location.serveMode). DIRECT: skips
  // OPEN/PREPARING/READY entirely and goes straight to SERVED, exactly like
  // a retail (Products/Services) sale already does. COUNTER: no kitchen
  // prep either, but a human still has to hand it over — the order is born
  // straight at READY, same as if a kitchen had just finished it, and
  // whoever's staffing the counter marks it served via the existing
  // PATCH .../serve (gated to POS_APPROVE_COUNTER for this mode).
  const serveMode = location?.serveMode ?? "KITCHEN";
  const instantServe = serveMode === "DIRECT";
  const startsAtCounter = serveMode === "COUNTER";
  const orderStockItems = resolvedLinesForStock(resolvedLines, menuItemsById, addonsById);
  const orderStockRequirements = computeStockRequirements(orderStockItems);
  const orderStockLocationId = orderStockRequirements.size > 0 ? await resolveStockLocationId(tid, effectiveLocationId) : null;
  if (orderStockRequirements.size > 0 && !orderStockLocationId) {
    res.status(400).json({ error: "No location is configured to hold stock for this order" });
    return;
  }
  // Where the kitchen must request its ingredients from the store, its own
  // shelves are empty until the storekeeper dispatches - availability is
  // checked against the store at dispatch time instead.
  if (!instantServe && orderStockLocationId && !dispatchRequired(location)) {
    try {
      await prisma.$transaction((tx) => assertStockAvailable(tx, tid, orderStockRequirements, orderStockLocationId));
    } catch (error) {
      if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
      throw error;
    }
  }

  let customerId: string | undefined;
  let billToReservationId: string | undefined;
  let complimentarySessionId: string | undefined;
  try {
    customerId = await resolveCustomerId(tid, parsed.data.customerId);
    if (parsed.data.reservationId) {
      const reservation = await resolveBillableReservation(tid, parsed.data.reservationId);
      billToReservationId = reservation!.id;
      // A tab picked to a room adopts that guest as its customer unless one
      // was explicitly chosen — same rule the settlement ROOM branch uses.
      customerId = customerId ?? reservation!.customerId;
    }
    if (parsed.data.complimentarySessionId) {
      const session = await prisma.complimentarySession.findFirst({ where: { id: parsed.data.complimentarySessionId, tenantId: tid, status: "OPEN" }, select: { id: true } });
      if (!session) throw Object.assign(new Error("Choose an open complimentary session"), { status: 400 });
      complimentarySessionId = session.id;
    }
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }

  try {
    const order = await prisma.$transaction(async (tx) => {
      const last = await tx.posOrder.findFirst({ where: { tenantId: tid }, orderBy: { orderNumber: "desc" }, select: { orderNumber: true } });
      const created = await tx.posOrder.create({
        data: {
          tenantId: tid,
          orderNumber: (last?.orderNumber ?? 0) + 1,
          tableId: parsed.data.tableId,
          locationId: effectiveLocationId,
          customerId,
          reservationId: billToReservationId,
          saleType: parsed.data.saleType,
          complimentarySessionId,
          complimentaryOrderRole: parsed.data.saleType === "COMPLIMENTARY" ? "HOST_COMP" : parsed.data.complimentarySessionId ? (parsed.data.complimentaryOrderRole ?? "GUEST_SPEND") : undefined,
          complimentaryReason: parsed.data.complimentaryReason,
          complimentaryRecipientName: parsed.data.complimentaryRecipientName,
          createdBy: req.userId,
          notes: parsed.data.notes,
          discount: parsed.data.saleType === "COMPLIMENTARY" ? 0 : parsed.data.discount,
          paymentStatus: parsed.data.saleType === "COMPLIMENTARY" ? "PAID" : "UNPAID",
          status: instantServe ? "SERVED" : startsAtCounter ? "READY" : "OPEN",
          servedAt: instantServe ? new Date() : undefined,
          readyAt: startsAtCounter ? new Date() : undefined,
          items: { create: lineCreatePayload(resolvedLines) },
        },
        include: orderInclude,
      });
      if (parsed.data.tableId) {
        await tx.table.updateMany({ where: { id: parsed.data.tableId }, data: { status: "OCCUPIED" } });
      }
      if (instantServe) {
        if (orderStockLocationId) await deductStockForOrder(tx, tid, orderStockRequirements, orderStockLocationId, created.orderNumber, req);
        await recordMenuLedger(tx, { tenantId: tid, type: created.saleType === "COMPLIMENTARY" ? "COMPLIMENTARY" : "SALE", order: created, lines: menuLedgerLinesFromItems(created.items), by: req.userId });
      }
      return created;
    });
    // Store-dispatch locations: the ingredients are requested from the store right now,
    // so the chef just sees "waiting for store approval".
    await autoRequestDispatch(tid, order.id, req.userId);
    res.status(201).json({ order: withFinancials(order, tax) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

/** Adds more items to a still-open FOOD order — another round, more food —
 * before it's finally settled. Food/Bar only: Products/Services sales are
 * one-shot, created and settled together, with no "keep adding" moment. */
posRouter.post("/orders/:id/items", async (req, res) => {
  const parsed = addItemsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid items", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, include: orderInclude });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (!ownsOrder(order, req)) { res.status(403).json({ error: "You can only add items to your own orders" }); return; }
  if (order.channel !== "FOOD") { res.status(409).json({ error: "Only food/bar orders can have items added after the fact" }); return; }
  if (["COMPLETED", "CANCELLED"].includes(order.status)) { res.status(409).json({ error: "This order is already finalized — start a new one instead" }); return; }

  const tax = await taxSettingsFor(tid);
  let resolvedLines: ResolvedLine[];
  let menuItemsById: Awaited<ReturnType<typeof resolveMenuLines>>["menuItemsById"];
  let addonsById: Awaited<ReturnType<typeof resolveMenuLines>>["addonsById"];
  try {
    ({ lines: resolvedLines, menuItemsById, addonsById } = await resolveMenuLines(tid, parsed.data.items, tax));
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }

  // Same menu item, same variant, same set of add-ons is the *same line* —
  // bump its quantity instead of stacking a duplicate row on the bill. A
  // different variant or add-on selection stays a separate line.
  const lineKey = (variantId: string | null | undefined, addons: { addonId: string }[]) =>
    `${variantId ?? ""}::${addons.map((a) => a.addonId).sort().join("|")}`;

  // Once an order has moved past OPEN, kitchen/bar has already engaged with
  // it once — adding more from here on is silent to them otherwise. Rather
  // than merge into an already-prepared line (which would blur "how many are
  // actually new"), each addition here becomes its own flagged row so the
  // "Updated orders" queue shows exactly what's new, nothing more.
  const flagAsUpdate = order.status !== "OPEN";

  // Catch a stock shortfall now, while the waiter can still swap the item -
  // not at Serve, after the kitchen has already cooked it. (A SERVED order
  // deducts immediately below, guarded; a store-dispatch location is checked
  // against the store when the kitchen requests the ingredients.)
  if (order.status !== "SERVED" && !dispatchRequired(order.location)) {
    const addedRequirements = computeStockRequirements(resolvedLinesForStock(resolvedLines, menuItemsById, addonsById));
    const addedStockLocationId = addedRequirements.size > 0 ? await resolveStockLocationId(tid, order.locationId) : null;
    if (addedStockLocationId) {
      try {
        await prisma.$transaction((tx) => assertStockAvailable(tx, tid, addedRequirements, addedStockLocationId));
      } catch (error) {
        if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
        throw error;
      }
    }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      for (const line of resolvedLines) {
        const key = lineKey(line.variantId, line.addons);
        // A line the store already dispatched for is never bumped in place - the extra would look covered.
        const existing = !flagAsUpdate ? order.items.find((row) => !row.dispatchRequestId && row.menuItemId === line.menuItemId && lineKey(row.variantId, row.addons) === key) : undefined;
        if (existing) {
          await tx.posOrderItem.update({ where: { id: existing.id }, data: { quantity: { increment: line.quantity } } });
          continue;
        }
        await tx.posOrderItem.create({
          data: {
            orderId: order.id,
            menuItemId: line.menuItemId,
            variantId: line.variantId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            taxRate: line.taxRate,
            taxMode: line.taxMode,
            taxTreatment: line.taxTreatment,
            addedAfterSend: flagAsUpdate,
            addons: { create: line.addons.map((addon) => ({ addonId: addon.addonId, quantity: addon.quantity, unitPrice: addon.unitPrice })) },
          },
        });
      }
      if (order.status === "SERVED") {
        // At a store-dispatch location the kitchen shelf is empty until the store
        // dispatches, so this round follows the normal flow: the chef sees it,
        // requests it, the store sends only what it needs, and the stock is taken
        // when the chef marks it prepared (settleServedAdditions).
        const deferStock = dispatchRequired(order.location);
        const stockLocationId = deferStock ? null : await resolveStockLocationId(tid, order.locationId);
        if (!deferStock && !stockLocationId) throw Object.assign(new Error("No location is configured to hold stock for this order"), { status: 400 });
        // Only the newly added items need deducting — the rest were already
        // committed when the order was first served. Reuses menuItemsById's
        // full variant list (with its own stockProduct) rather than just a
        // variantId, and addonsById for each add-on's own stock link — a
        // bare { quantity, menuItem } here (no variant/addons) previously
        // fell through to the parent item's own recipe/product, silently
        // deducting the wrong thing (or nothing) for every "another round"
        // added to an already-SERVED tab.
        const newItems: OrderItemForStock[] = resolvedLines.map((line) => {
          const mi = menuItemsById.get(line.menuItemId)!;
          const variant = line.variantId ? mi.variants.find((v) => v.id === line.variantId) ?? null : null;
          return {
            quantity: line.quantity,
            menuItem: mi,
            variant,
            addons: line.addons.map((a) => ({ quantity: a.quantity, addon: addonsById.get(a.addonId)! })),
          };
        });
        if (stockLocationId) await deductStockForOrder(tx, tid, computeStockRequirements(newItems), stockLocationId, order.orderNumber, req);
        // Only the newly added round is a new sale — the rest was recorded when the order was served.
        await recordMenuLedger(tx, {
          tenantId: tid,
          type: order.saleType === "COMPLIMENTARY" ? "COMPLIMENTARY" : "SALE",
          order,
          by: req.userId,
          lines: resolvedLines.map((line) => {
            const mi = menuItemsById.get(line.menuItemId)!;
            const variant = line.variantId ? mi.variants.find((v) => v.id === line.variantId) ?? null : null;
            const addons = line.addons.map((a) => ({ quantity: a.quantity, unitPrice: a.unitPrice, name: addonsById.get(a.addonId)?.name ?? "Add-on" }));
            return {
              menuItemId: line.menuItemId,
              itemName: mi.name,
              variantName: variant?.name ?? null,
              addonsNote: addons.length ? addons.map((a) => `${a.name}${a.quantity > 1 ? ` x${a.quantity}` : ""}`).join(", ") : null,
              quantity: line.quantity,
              unitPrice: Number(line.unitPrice) + addons.reduce((s, a) => s + Number(a.unitPrice) * a.quantity, 0),
            };
          }),
        });
      }
      return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
    });
    await autoRequestDispatch(tid, order.id, req.userId);
    res.status(201).json({ order: withFinancials(updated, tax) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

/** Reconciles stock when a line on an already-SERVED order changes: pushes
 * out the extra where consumption went up, returns stock where it went down.
 * Only quantity affects this — a variant or add-on swap doesn't change the
 * recipe. Throws "Not enough X" (→ 409) if a top-up can't be covered. */
async function applyStockDelta(
  tx: Prisma.TransactionClient,
  tid: string,
  locationId: string,
  before: Map<string, { quantity: number; name: string }>,
  after: Map<string, { quantity: number; name: string }>,
  orderNumber: number,
  req: { userId?: string },
) {
  const productIds = new Set([...before.keys(), ...after.keys()]);
  for (const productId of productIds) {
    const b = before.get(productId);
    const a = after.get(productId);
    const name = a?.name ?? b?.name ?? "stock";
    const delta = (a?.quantity ?? 0) - (b?.quantity ?? 0);
    if (delta === 0) continue;
    try {
      await recordStockMovement(tx, {
        tenantId: tid, productId, locationId,
        type: delta > 0 ? "SALE" : "RETURN",
        quantity: -delta,
        note: `POS order #${orderNumber} line ${delta > 0 ? "increased" : "reduced"}`,
        sourceType: "POS_ORDER", sourceRefId: String(orderNumber),
        performedBy: req.userId ?? null, label: name,
      });
    } catch (error) {
      if (error instanceof InsufficientStockError) throw new Error(`Not enough ${name} at this location`);
      throw error;
    }
  }
}

/** Edits one line on a still-open order — swap the size/variant, add or drop
 * add-ons, change the quantity. Menu-item lines only. Re-validates and
 * re-prices against the current menu (and re-snapshots its tax), and on a
 * serve-now order reconciles the stock difference. */
posRouter.patch("/orders/:id/items/:itemId", async (req, res) => {
  const parsed = editItemSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid change", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, include: orderInclude });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (!ownsOrder(order, req)) { res.status(403).json({ error: "You can only edit your own orders" }); return; }
  if (order.channel !== "FOOD") { res.status(409).json({ error: "Only food/bar order lines can be edited here" }); return; }
  if (["COMPLETED", "CANCELLED"].includes(order.status)) { res.status(409).json({ error: "This order is finalized — it can't be changed" }); return; }
  if (order.servedAt || order.status === "SERVED") {
    res.status(409).json({ error: "Served order lines are locked. Add a new round, or request a return for served items." });
    return;
  }
  const existing = order.items.find((row) => row.id === req.params.itemId);
  if (!existing) { res.status(404).json({ error: "That line isn't on this order" }); return; }
  if (!existing.menuItemId) { res.status(409).json({ error: "Only menu-item lines can be edited" }); return; }

  // Once the kitchen has asked the store for a line's ingredients, changing what
  // it needs would leave the dispatch out of step. Fewer of the same thing is fine;
  // anything else is a new round (or remove the line).
  if (existing.dispatchRequestId && existing.dispatchRequest?.status !== "REQUESTED") {
    const sameShape = ("variantId" in parsed.data ? (parsed.data.variantId ?? null) : existing.variantId) === existing.variantId
      && (parsed.data.addons === undefined || JSON.stringify(parsed.data.addons.map((a) => [a.addonId, a.quantity]).sort()) === JSON.stringify(existing.addons.map((a) => [a.addonId, a.quantity]).sort()));
    if (!sameShape || (parsed.data.quantity ?? existing.quantity) > existing.quantity) {
      res.status(409).json({ error: "The store already handled the ingredients for this line. Add the extra as a new item instead." });
      return;
    }
  }

  const desired: OrderLineInput = {
    menuItemId: existing.menuItemId,
    variantId: ("variantId" in parsed.data ? parsed.data.variantId : existing.variantId) ?? undefined,
    quantity: parsed.data.quantity ?? existing.quantity,
    addons: parsed.data.addons ?? existing.addons.map((a) => ({ addonId: a.addonId, quantity: a.quantity })),
  };

  const tax = await taxSettingsFor(tid);
  let resolved: ResolvedLine;
  let menuItemsById: Awaited<ReturnType<typeof resolveMenuLines>>["menuItemsById"];
  let addonsById: Awaited<ReturnType<typeof resolveMenuLines>>["addonsById"];
  try {
    const out = await resolveMenuLines(tid, [desired], tax);
    resolved = out.lines[0];
    menuItemsById = out.menuItemsById;
    addonsById = out.addonsById;
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (order.status === "SERVED") {
        const stockLocationId = await resolveStockLocationId(tid, order.locationId);
        if (!stockLocationId) throw Object.assign(new Error("No location is configured to hold stock for this order"), { status: 400 });
        const mi = menuItemsById.get(existing.menuItemId!)!;
        const beforeVariant = existing.variantId ? mi.variants.find((v) => v.id === existing.variantId) ?? null : null;
        const afterVariant = resolved.variantId ? mi.variants.find((v) => v.id === resolved.variantId) ?? null : null;
        const before = computeStockRequirements([{ quantity: existing.quantity, menuItem: mi, variant: beforeVariant, addons: existing.addons }]);
        const after = computeStockRequirements([{
          quantity: resolved.quantity, menuItem: mi, variant: afterVariant,
          addons: resolved.addons.map((a) => ({ quantity: a.quantity, addon: addonsById.get(a.addonId)! })),
        }]);
        await applyStockDelta(tx, tid, stockLocationId, before, after, order.orderNumber, req);
      }
      await tx.posOrderItemAddon.deleteMany({ where: { orderItemId: existing.id } });
      await tx.posOrderItem.update({
        where: { id: existing.id },
        data: {
          variantId: resolved.variantId ?? null,
          quantity: resolved.quantity,
          unitPrice: resolved.unitPrice,
          taxRate: resolved.taxRate,
          taxMode: resolved.taxMode,
          taxTreatment: resolved.taxTreatment,
          // A bumped quantity on a ticket kitchen/bar already started is the
          // same "silent change" as adding a new line — flag it so it shows
          // in the "Updated orders" queue too. A same-or-lower quantity, or
          // an order still OPEN, needs no flag: kitchen hasn't touched it, or
          // there's nothing extra to prepare.
          ...(order.status !== "OPEN" && resolved.quantity > existing.quantity ? { addedAfterSend: true } : {}),
          addons: { create: resolved.addons.map((addon) => ({ addonId: addon.addonId, quantity: addon.quantity, unitPrice: addon.unitPrice })) },
        },
      });
      // The store hasn't answered yet: keep its request in step with the edited line.
      if (existing.dispatchRequestId && existing.dispatchRequest?.status === "REQUESTED") await refreshOpenRequest(tx, tid, existing.dispatchRequestId);
      return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
    });
    res.status(200).json({ order: withFinancials(updated, tax) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

/** Removes one line from a still-open order. Returns its stock on a serve-now
 * order. An order can't be emptied this way — cancel it instead. */
posRouter.delete("/orders/:id/items/:itemId", async (req, res) => {
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, include: orderInclude });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (!ownsOrder(order, req)) { res.status(403).json({ error: "You can only edit your own orders" }); return; }
  if (order.channel !== "FOOD") { res.status(409).json({ error: "Only food/bar order lines can be edited here" }); return; }
  if (["COMPLETED", "CANCELLED"].includes(order.status)) { res.status(409).json({ error: "This order is finalized — it can't be changed" }); return; }
  if (order.servedAt || order.status === "SERVED") {
    res.status(409).json({ error: "Served order lines are locked. Request a return instead." });
    return;
  }
  const existing = order.items.find((row) => row.id === req.params.itemId);
  if (!existing) { res.status(404).json({ error: "That line isn't on this order" }); return; }
  if (order.items.length <= 1) { res.status(409).json({ error: "Cancel the order instead of removing its only line" }); return; }

  const tax = await taxSettingsFor(tid);
  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (order.status === "SERVED" && existing.menuItem) {
        const stockLocationId = await resolveStockLocationId(tid, order.locationId);
        if (!stockLocationId) throw Object.assign(new Error("No location is configured to hold stock for this order"), { status: 400 });
        const before = computeStockRequirements([{ quantity: existing.quantity, menuItem: existing.menuItem, variant: existing.variant, addons: existing.addons }]);
        await applyStockDelta(tx, tid, stockLocationId, before, new Map(), order.orderNumber, req);
      }
      await tx.posOrderItem.delete({ where: { id: existing.id } });
      if (existing.dispatchRequestId && existing.dispatchRequest?.status === "REQUESTED") await refreshOpenRequest(tx, tid, existing.dispatchRequestId);
      return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
    });
    res.status(200).json({ order: withFinancials(updated, tax) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

/** Falls back to the tenant's warehouse (type STORE) when an order has no
 * location of its own — e.g. a property that isn't using locations at all. */
async function resolveStockLocationId(tid: string, orderLocationId: string | null): Promise<string | null> {
  if (orderLocationId) return orderLocationId;
  const store = await prisma.location.findFirst({ where: { tenantId: tid, type: "STORE" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return store?.id ?? null;
}

function resolvedLinesForStock(
  lines: ResolvedLine[],
  menuItemsById: Map<string, Prisma.MenuItemGetPayload<{ include: typeof menuLineInclude }>>,
  addonsById: Map<string, Prisma.AddonGetPayload<{ select: typeof addonStockSelect }>>,
): OrderItemForStock[] {
  return lines.map((line) => {
    const mi = menuItemsById.get(line.menuItemId)!;
    const variant = line.variantId ? mi.variants.find((v) => v.id === line.variantId) ?? null : null;
    return {
      quantity: line.quantity,
      menuItem: mi,
      variant,
      addons: line.addons.map((a) => ({ quantity: a.quantity, addon: addonsById.get(a.addonId)! })),
    };
  });
}

/** Marks a READY order served — the point the ingredients are actually gone,
 * consumed from the order's own location's stock. Order stays open on the
 * table's tab until it's paid. For a KITCHEN-mode order this is just the
 * waiter picking food up from the pass — anyone can do it. For a
 * COUNTER-mode order (no kitchen prep, born straight at READY) this IS the
 * counter's approval step, so it's gated to whoever holds
 * POS_APPROVE_COUNTER that shift — not tied to a fixed account, since who's
 * on counter duty changes day to day. */
async function assertStockAvailable(
  tx: Prisma.TransactionClient,
  tid: string,
  requirements: Map<string, { quantity: number; name: string }>,
  locationId: string,
) {
  for (const [productId, requirement] of requirements) {
    const row = await tx.productStock.findUnique({
      where: { tenantId_productId_locationId: { tenantId: tid, productId, locationId } },
      select: { quantity: true },
    });
    if (Number(row?.quantity ?? 0) < requirement.quantity) {
      throw Object.assign(new Error(`Not enough ${requirement.name} at this location — transfer more stock in`), { status: 409 });
    }
  }
}

posRouter.patch("/orders/:id/serve", async (req, res) => {
  const tid = tenantIdFor(req);
  const activeOrder = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid, status: "READY" }, include: orderInclude });
  if (!activeOrder) { res.status(404).json({ error: "Ready order not found" }); return; }

  if (activeOrder.location?.serveMode === "COUNTER") {
    const allowed = await hasPermission(tid, req.userId, "POS_APPROVE_COUNTER");
    if (!allowed) { res.status(403).json({ error: "You don't have permission to approve counter orders" }); return; }
  }

  const dispatch = orderDispatchInfo(activeOrder);
  if (!dispatch.clear) {
    res.status(409).json({ error: dispatch.state === "WAITING" ? "The kitchen is still waiting for the store to dispatch the added items" : "The added items haven't been requested from the store yet", code: "DISPATCH_REQUIRED" });
    return;
  }

  const stockLocationId = await resolveStockLocationId(tid, activeOrder.locationId);
  if (!stockLocationId) { res.status(400).json({ error: "No location is configured to hold stock for this order" }); return; }

  const tax = await taxSettingsFor(tid);
  const requirements = computeStockRequirements(activeOrder.items);

  try {
    await prisma.$transaction(async (tx) => {
      // Claims the row before touching stock — a conditional update, not a
      // plain one, so a second concurrent tap (slow connection, an eager
      // waiter and counter both hitting Serve) finds 0 rows still READY and
      // aborts here instead of both requests deducting stock for the same
      // order.
      const claimed = await tx.posOrder.updateMany({ where: { id: activeOrder.id, status: "READY" }, data: { status: "SERVED", servedAt: new Date() } });
      if (claimed.count === 0) throw Object.assign(new Error("This order was already served"), { status: 409 });
      await deductStockForOrder(tx, tid, requirements, stockLocationId, activeOrder.orderNumber, req);
      await recordMenuLedger(tx, { tenantId: tid, type: activeOrder.saleType === "COMPLIMENTARY" ? "COMPLIMENTARY" : "SALE", order: activeOrder, lines: menuLedgerLinesFromItems(activeOrder.items), by: req.userId });
      // Serving hands over every line, including any round added after the
      // order was sent — so the "updated" flags are done with. Then tidy
      // identical rounds into one line.
      await tx.posOrderItem.updateMany({ where: { orderId: activeOrder.id, addedAfterSend: true }, data: { addedAfterSend: false } });
      await mergeDuplicateOrderLines(tx, activeOrder.id, { includeFlagged: false });
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }

  res.status(200).json({ order: withFinancials(await prisma.posOrder.findUniqueOrThrow({ where: { id: activeOrder.id }, include: orderInclude }), tax) });
});

/** The counter/bar (or kitchen, or whoever hands things over) confirms the
 * lines added after the order was sent have been prepared and handed over —
 * clears the "updated" flags and folds identical lines together. This is the
 * POS-side twin of PATCH /kitchen/orders/:id/ack-updates, which needs the
 * Kitchen module a bar-only tenant doesn't have. At a Counter-mode location
 * it's gated to POS_APPROVE_COUNTER, same as serving there. */
posRouter.patch("/orders/:id/ack-updates", async (req, res) => {
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid, status: { notIn: ["COMPLETED", "CANCELLED"] } }, include: orderInclude });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (order.location?.serveMode === "COUNTER" && !(await hasPermission(tid, req.userId, "POS_APPROVE_COUNTER"))) {
    res.status(403).json({ error: "You don't have permission to confirm counter orders" });
    return;
  }
  try {
    await prisma.$transaction(async (tx) => {
      await settleServedAdditions(tx, tid, order, req);
      await tx.posOrderItem.updateMany({ where: { orderId: order.id, addedAfterSend: true }, data: { addedAfterSend: false } });
      await mergeDuplicateOrderLines(tx, order.id, { includeFlagged: false });
    });
  } catch (error) {
    if (error instanceof DispatchError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    throw error;
  }
  const [updated, tax] = await Promise.all([
    prisma.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude }),
    taxSettingsFor(tid),
  ]);
  res.status(200).json({ order: withFinancials(updated, tax) });
});

posRouter.delete("/orders/:id/revert", async (req, res) => {
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, include: orderInclude });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  // A service sale is created already SERVED and paid in a second step; if that step fails the
  // till withdraws it (no payment yet) and puts back whatever stock it consumed.
  const unpaidServiceSale = order.channel === "SERVICES" && order.status === "SERVED" && order.payments.length === 0;
  if (!unpaidServiceSale && (!["OPEN", "PREPARING", "READY"].includes(order.status) || order.servedAt)) {
    res.status(409).json({ error: "Only orders that have not been served can be reverted" });
    return;
  }
  if (order.payments.length > 0) {
    res.status(409).json({ error: "This order already has payments recorded and cannot be reverted" });
    return;
  }
  const canRevert = order.createdBy === req.userId || await canSeeAllOrders(tid, req.userId);
  if (!canRevert) { res.status(403).json({ error: "You can only revert your own undeducted orders" }); return; }
  try {
    await prisma.$transaction(async (tx) => {
      if (unpaidServiceSale) {
        const consumed = computeStockRequirements(order.items);
        const stockLocationId = consumed.size > 0 ? await resolveStockLocationId(tid, order.locationId) : null;
        if (stockLocationId) await applyStockDelta(tx, tid, stockLocationId, consumed, new Map(), order.orderNumber, req);
      }
      await tx.posOrder.delete({ where: { id: order.id } });
      if (order.tableId) await releaseTableIfIdle(tx, order.tableId);
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    throw error;
  }
  res.status(204).send();
});

const cancelRequestSchema = z.object({ reason: z.string().trim().min(3, "Give a reason").max(500) });
const rejectCancelSchema = z.object({ note: z.string().trim().max(500).optional() });

// A "return" is a cancellation of an order that's already been served (or
// paid) rather than one still being prepared — same request/approve/reject
// machinery, but only within this window of servedAt. An order that hasn't
// been served yet (no servedAt) has no such limit; it's a plain pre-service
// cancellation.
const RETURN_WINDOW_MS = 60 * 60 * 1000;

/** A waiter requests a cancellation or return — every one needs approval, so
 * this just parks the order in PENDING_CANCELLATION with a reason. The table
 * stays held and the order stays off the Active tab until a decision is
 * made. Allowed from any non-final status; once an order has been served,
 * it's only allowed within RETURN_WINDOW_MS of servedAt (this is what makes
 * a COMPLETED order — otherwise finalized — still reachable here). */
posRouter.patch("/orders/:id/cancel", async (req, res) => {
  const parsed = cancelRequestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const existing = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!existing) { res.status(404).json({ error: "Order not found" }); return; }
  const superAdmin = await isSuperAdminUser(tid, req.userId);
  if (!superAdmin && !ownsOrder(existing, req)) { res.status(403).json({ error: "You can only cancel your own orders" }); return; }
  if (existing.status === "PENDING_CANCELLATION") { res.status(409).json({ error: "This order is already waiting for a cancellation decision" }); return; }
  if (existing.status === "CANCELLED") { res.status(409).json({ error: "This order is already cancelled" }); return; }
  if (!superAdmin && existing.servedAt && Date.now() - existing.servedAt.getTime() > RETURN_WINDOW_MS) {
    res.status(409).json({ error: "Returns are only allowed within 1 hour of an order being served" });
    return;
  }
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    // A whole-order return replaces any item-level returns still waiting —
    // otherwise the approvers would see the same order twice, deciding two
    // overlapping requests.
    await tx.posOrderReturnRequest.updateMany({
      where: { orderId: existing.id, status: "PENDING" },
      data: { status: "REJECTED", decidedBy: req.userId ?? null, decidedAt: now, decisionNote: "Replaced by a request to return the whole order" },
    });
    return tx.posOrder.update({
      where: { id: existing.id },
      data: {
        status: "PENDING_CANCELLATION",
        statusBeforeCancel: existing.status,
        cancelReason: parsed.data.reason,
        cancelRequestedBy: req.userId ?? null,
        cancelRequestedAt: now,
        cancelDecidedBy: null,
        cancelDecidedAt: null,
        cancelDecisionNote: null,
      },
      include: orderInclude,
    });
  });
  const tax = await taxSettingsFor(tid);
  res.status(200).json({ order: withFinancials(updated, tax) });
});

/** Admin approves a pending cancellation/return → CANCELLED. Frees the
 * table; if the order had already been served (checked via servedAt, not
 * statusBeforeCancel — a COMPLETED order was served too), returns its
 * stock. Any payments taken are voided in the Transaction ledger (so they
 * drop out of revenue) rather than blocking the approval — the physical
 * cash/M-Pesa handback is a manual step outside the app, this just keeps
 * the books honest. Same for a credit sale: reconcileOrderCredit unwinds
 * whatever balance this order had pushed onto the customer. */
posRouter.post("/orders/:id/cancel/approve", requirePermission("POS_APPROVE_CANCELLATION"), async (req, res) => {
  const id = req.params.id as string;
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id, tenantId: tid }, include: orderInclude });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (order.status !== "PENDING_CANCELLATION") { res.status(409).json({ error: "This order isn't waiting for a cancellation decision" }); return; }
  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (order.servedAt) {
        const stockLocationId = await resolveStockLocationId(tid, order.locationId);
        if (stockLocationId) {
          const req0 = computeStockRequirements(order.items.filter((item) => !isUndeductedAddition(order, item)));
          await applyStockDelta(tx, tid, stockLocationId, req0, new Map(), order.orderNumber, req);
        }
        await recordMenuLedger(tx, { tenantId: tid, type: "RETURN", order, lines: menuLedgerLinesFromItems(order.items), note: order.cancelReason ? `Order cancelled: ${order.cancelReason}` : "Order cancelled", by: req.userId });
      }
      if (order.payments.length > 0) {
        await tx.transaction.updateMany({
          where: { tenantId: tid, sourceRefId: { in: order.payments.map((p) => p.id) }, status: "COMPLETE" },
          data: { status: "VOIDED" },
        });
      }
      const creditCustomerId = order.customerId ?? order.reservation?.customerId ?? null;
      if (creditCustomerId) {
        await reconcileOrderCredit(tx, { tenantId: tid, orderId: order.id, orderNumber: order.orderNumber, customerId: creditCustomerId, status: "CANCELLED", paid: 0, total: 0, by: req.userId });
      }
      // Item-level returns still pending on an order that's now cancelled in
      // full have nothing left to decide — close them instead of leaving them
      // stranded in Approvals.
      await tx.posOrderReturnRequest.updateMany({
        where: { orderId: order.id, status: "PENDING" },
        data: { status: "REJECTED", decidedBy: req.userId ?? null, decidedAt: new Date(), decisionNote: "Order was returned in full" },
      });
      await tx.posOrder.update({ where: { id: order.id }, data: { status: "CANCELLED", cancelDecidedBy: req.userId ?? null, cancelDecidedAt: new Date() } });
      // A cancelled order no longer needs ingredients: withdraw any request still waiting at the store.
      await tx.stockDispatchRequest.updateMany({ where: { orderId: order.id, status: "REQUESTED" }, data: { status: "CANCELLED", respondedAt: new Date(), respondedBy: req.userId ?? null } });
      if (order.tableId) await releaseTableIfIdle(tx, order.tableId);
      return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
    });
    const tax = await taxSettingsFor(tid);
    res.status(200).json({ order: withFinancials(updated, tax) });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

/** Admin rejects a pending cancellation → the order returns to whatever
 * status it was in before the request. The reason and the decision note are
 * kept for the record. */
posRouter.post("/orders/:id/cancel/reject", requirePermission("POS_APPROVE_CANCELLATION"), async (req, res) => {
  const id = req.params.id as string;
  const parsed = rejectCancelSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id, tenantId: tid } });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (order.status !== "PENDING_CANCELLATION") { res.status(409).json({ error: "This order isn't waiting for a cancellation decision" }); return; }
  const updated = await prisma.posOrder.update({
    where: { id: order.id },
    data: {
      status: order.statusBeforeCancel ?? "OPEN",
      statusBeforeCancel: null,
      cancelDecidedBy: req.userId ?? null,
      cancelDecidedAt: new Date(),
      cancelDecisionNote: parsed.data.note ?? null,
    },
    include: orderInclude,
  });
  const tax = await taxSettingsFor(tid);
  res.status(200).json({ order: withFinancials(updated, tax) });
});

/** Settles a served order's bill — cash/card/etc. now, or charged to a
 * checked-in guest's room (decided here, not at order creation, since staff
 * often don't know or may change their mind about that until the customer
 * is actually ready to settle). Splits are fine either way — several partial
 * payments, or a mix of cash and a room charge, are both allowed. Completes
 * and frees the table once fully covered. */
posRouter.get("/return-requests", requirePermission("POS_APPROVE_CANCELLATION"), async (req, res) => {
  const query = z.object({
    status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid return request filters" }); return; }
  const tid = tenantIdFor(req);
  const [requests, tax] = await Promise.all([
    prisma.posOrderReturnRequest.findMany({
      where: { tenantId: tid, ...(query.data.status ? { status: query.data.status } : {}) },
      include: {
        order: { include: orderInclude },
        orderItem: { include: { menuItem: { select: { name: true } }, variant: { select: { name: true } } } },
      },
      orderBy: { requestedAt: "desc" },
      ...(query.data.limit ? { take: query.data.limit } : {}),
    }),
    taxSettingsFor(tid),
  ]);
  res.status(200).json({ requests: requests.map((request) => ({ ...request, order: withFinancials(request.order, tax) })) });
});

async function createReturnRequestsForOrder(args: {
  tenantId: string;
  orderId: string;
  items: { orderItemId: string; quantity: number }[];
  reason: string;
  userId?: string;
}) {
  const order = await prisma.posOrder.findFirst({ where: { id: args.orderId, tenantId: args.tenantId }, include: orderInclude });
  if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
  const superAdmin = await isSuperAdminUser(args.tenantId, args.userId);
  if (!superAdmin && !ownsOrder(order, { userId: args.userId })) throw Object.assign(new Error("You can only request a return on your own orders"), { status: 403 });
  if (!order.servedAt || !["SERVED", "COMPLETED"].includes(order.status)) throw Object.assign(new Error("Only served orders can have returns requested"), { status: 409 });
  if (!superAdmin && Date.now() - order.servedAt.getTime() > RETURN_WINDOW_MS) throw Object.assign(new Error("Returns are only allowed within 1 hour of an order being served"), { status: 409 });

  const requestedByItem = new Map<string, number>();
  for (const item of args.items) requestedByItem.set(item.orderItemId, (requestedByItem.get(item.orderItemId) ?? 0) + item.quantity);
  const orderItems = order.items.filter((row) => requestedByItem.has(row.id));
  if (orderItems.length !== requestedByItem.size) throw Object.assign(new Error("One or more return lines were not found on this order"), { status: 404 });
  if (orderItems.some((row) => !row.menuItemId || !row.menuItem)) throw Object.assign(new Error("One or more return lines cannot be returned"), { status: 404 });

  const pending = await prisma.posOrderReturnRequest.groupBy({
    by: ["orderItemId"],
    where: { tenantId: args.tenantId, orderId: order.id, status: "PENDING" },
    _sum: { quantity: true },
  });
  const pendingByItem = new Map(pending.map((row) => [row.orderItemId, row._sum.quantity ?? 0]));
  const totalUnits = order.items.reduce((sum, row) => sum + row.quantity, 0);
  const totalAlreadyPending = order.items.reduce((sum, row) => sum + (pendingByItem.get(row.id) ?? 0), 0);
  const totalRequested = [...requestedByItem.values()].reduce((sum, qty) => sum + qty, 0);
  if (totalRequested + totalAlreadyPending >= totalUnits) throw Object.assign(new Error("Partial returns must leave at least one item on the order. Use full return instead."), { status: 400 });

  for (const row of orderItems) {
    const requested = requestedByItem.get(row.id) ?? 0;
    const alreadyPending = pendingByItem.get(row.id) ?? 0;
    if (requested + alreadyPending > row.quantity) throw Object.assign(new Error(`Return quantity is too high for ${row.menuItem?.name ?? "one item"}`), { status: 400 });
  }

  return prisma.$transaction(orderItems.map((row) => prisma.posOrderReturnRequest.create({
    data: {
      tenantId: args.tenantId,
      orderId: order.id,
      orderItemId: row.id,
      quantity: requestedByItem.get(row.id)!,
      reason: args.reason,
      requestedBy: args.userId ?? null,
    },
    include: { orderItem: { include: { menuItem: { select: { name: true } }, variant: { select: { name: true } } } } },
  })));
}

posRouter.post("/orders/:id/return-request", async (req, res) => {
  const parsed = orderReturnRequestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid return request", details: parsed.error.flatten() }); return; }
  try {
    const requests = await createReturnRequestsForOrder({
      tenantId: tenantIdFor(req),
      orderId: req.params.id,
      items: parsed.data.items,
      reason: parsed.data.reason,
      userId: req.userId,
    });
    res.status(201).json({ requests });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

posRouter.post("/orders/:id/items/:itemId/return-request", async (req, res) => {
  const parsed = returnRequestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid return request", details: parsed.error.flatten() }); return; }
  try {
    const [request] = await createReturnRequestsForOrder({
      tenantId: tenantIdFor(req),
      orderId: req.params.id,
      items: [{ orderItemId: req.params.itemId, quantity: parsed.data.quantity }],
      reason: parsed.data.reason,
      userId: req.userId,
    });
    res.status(201).json({ request });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

posRouter.post("/return-requests/:id/approve", requirePermission("POS_APPROVE_CANCELLATION"), async (req, res) => {
  const parsed = returnDecisionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid return approval", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const id = req.params.id as string;
  const request = await prisma.posOrderReturnRequest.findFirst({
    where: { id, tenantId: tid },
    include: {
      order: { include: orderInclude },
      orderItem: {
        include: {
          menuItem: { include: { product: true, recipe: { include: { ingredients: { include: { product: true } } } } } },
          variant: { select: variantStockSelect },
          addons: { include: { addon: { include: addonStockInclude } } },
        },
      },
    },
  });
  if (!request) { res.status(404).json({ error: "Return request not found" }); return; }
  if (request.status !== "PENDING") { res.status(409).json({ error: "This return request has already been decided" }); return; }
  if (request.order.status === "PENDING_CANCELLATION") { res.status(409).json({ error: "This order has a full return waiting for a decision — decide that one instead" }); return; }
  if (!request.order.servedAt) { res.status(409).json({ error: "This order has not been served" }); return; }
  const pendingOnOrder = await prisma.posOrderReturnRequest.aggregate({
    where: { tenantId: tid, orderId: request.orderId, status: "PENDING" },
    _sum: { quantity: true },
  });
  const orderUnits = request.order.items.reduce((sum, item) => sum + item.quantity, 0);
  if ((pendingOnOrder._sum.quantity ?? 0) >= orderUnits) {
    res.status(400).json({ error: "Partial returns must leave at least one item on the order. Use full return instead." });
    return;
  }
  try {
    const tax = await taxSettingsFor(tid);
    const updated = await prisma.$transaction(async (tx) => {
      const stockLocationId = await resolveStockLocationId(tid, request.order.locationId);
      if (stockLocationId && request.orderItem.menuItem && !isUndeductedAddition(request.order, request.orderItem)) {
        const returned = computeStockRequirements([{ quantity: request.quantity, menuItem: request.orderItem.menuItem, variant: request.orderItem.variant, addons: request.orderItem.addons }]);
        await applyStockDelta(tx, tid, stockLocationId, returned, new Map(), request.order.orderNumber, req);
      }
      await recordMenuLedger(tx, {
        tenantId: tid,
        type: "RETURN",
        order: request.order,
        lines: menuLedgerLinesFromItems([request.orderItem], () => request.quantity),
        note: request.reason,
        by: req.userId,
      });
      await tx.posOrderItem.update({ where: { id: request.orderItemId }, data: { quantity: { decrement: request.quantity } } });
      await tx.posOrderReturnRequest.update({ where: { id: request.id }, data: { status: "APPROVED", decidedBy: req.userId ?? null, decidedAt: new Date(), decisionNote: parsed.data.note ?? null } });
      const order = await tx.posOrder.findUniqueOrThrow({ where: { id: request.orderId }, include: orderInclude });
      const withTotals = withFinancials(order, tax);
      await tx.posOrder.update({ where: { id: order.id }, data: { paymentStatus: paymentStatusFor(withTotals.paid, withTotals.total) } });
      const creditCustomerId = order.customerId ?? order.reservation?.customerId ?? null;
      if (creditCustomerId) {
        await reconcileOrderCredit(tx, { tenantId: tid, orderId: order.id, orderNumber: order.orderNumber, customerId: creditCustomerId, status: order.status, paid: withTotals.paid, total: withTotals.total, by: req.userId });
      }
      return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
    });
    res.status(200).json({ order: withFinancials(updated, tax) });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

posRouter.post("/return-requests/:id/reject", requirePermission("POS_APPROVE_CANCELLATION"), async (req, res) => {
  const parsed = returnDecisionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid return rejection", details: parsed.error.flatten() }); return; }
  const id = req.params.id as string;
  const updated = await prisma.posOrderReturnRequest.updateMany({
    where: { id, tenantId: tenantIdFor(req), status: "PENDING" },
    data: { status: "REJECTED", decidedBy: req.userId ?? null, decidedAt: new Date(), decisionNote: parsed.data.note ?? null },
  });
  if (!updated.count) { res.status(404).json({ error: "Pending return request not found" }); return; }
  res.status(200).json({ request: await prisma.posOrderReturnRequest.findUniqueOrThrow({ where: { id } }) });
});

posRouter.post("/orders/:id/payments", async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid payment", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const [order, tax] = await Promise.all([
    prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, include: orderInclude }),
    taxSettingsFor(tid),
  ]);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (!ownsOrder(order, req)) { res.status(403).json({ error: "You can only take payment on your own orders" }); return; }
  if (order.saleType === "COMPLIMENTARY") {
    res.status(409).json({ error: "Complimentary orders do not take payments" });
    return;
  }
  if (hasPendingReturnRequests(order)) {
    res.status(409).json({ error: "Approve or reject the pending return before taking payment" });
    return;
  }
  if (hasPendingAdditions(order)) {
    res.status(409).json({ error: "The kitchen hasn't handed over the items added to this order yet" });
    return;
  }
  const payable = order.status === "SERVED" || (order.status === "COMPLETED" && order.paymentStatus !== "PAID");
  if (!payable) { res.status(409).json({ error: order.status === "COMPLETED" ? "This order is already fully paid" : "The order must be served before it can be paid" }); return; }
  const { total } = computeOrderFinancials(order, tax);
  const alreadyPaid = order.payments.reduce((s, p) => s + Number(p.amount), 0);
  const remaining = Math.round((total - alreadyPaid) * 100) / 100;
  if (parsed.data.amount > remaining + 0.01) { res.status(400).json({ error: `Amount exceeds the remaining balance of ${remaining.toFixed(2)}` }); return; }
  const custId = order.customerId ?? order.reservation?.customerId ?? null;

  try {
    let updatedOrder;
    const data = parsed.data;
    if (data.method === "ROOM") {
      const reservation = await resolveBillableReservation(tid, data.reservationId);
      const roomChargeMethod = await prisma.paymentMethod.findFirst({ where: { tenantId: tid, code: "ROOM_CHARGE" } });
      if (!roomChargeMethod) throw Object.assign(new Error("Room charge isn't set up for this property"), { status: 500 });
      updatedOrder = await prisma.$transaction(async (tx) => {
        await tx.payment.create({ data: { tenantId: tid, orderId: order.id, paymentMethodId: roomChargeMethod.id, amount: data.amount, reference: reservation!.reservationNo, receivedBy: req.userId } });
        await chargeOrderToFolio(tx, tid, reservation!.folio!.id, order, data.amount, req);
        await tx.posOrder.update({ where: { id: order.id }, data: { reservationId: order.reservationId ?? reservation!.id, customerId: order.customerId ?? reservation!.customerId } });
        const paidSoFar = alreadyPaid + data.amount;
        const newStatus = order.status === "SERVED" && paidSoFar >= total - 0.01 ? "COMPLETED" : order.status;
        await tx.posOrder.update({ where: { id: order.id }, data: { status: newStatus, paymentStatus: paymentStatusFor(paidSoFar, total) } });
        if (newStatus === "COMPLETED" && order.status === "SERVED" && order.tableId) await releaseTableIfIdle(tx, order.tableId);
        if (newStatus === "COMPLETED") await mergeDuplicateOrderLines(tx, order.id, { includeFlagged: true });
        await reconcileOrderCredit(tx, { tenantId: tid, orderId: order.id, orderNumber: order.orderNumber, customerId: order.customerId ?? reservation!.customerId ?? null, status: newStatus, paid: paidSoFar, total, by: req.userId });
        return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
      });
    } else {
      await resolvePaymentMethod(tid, data.paymentMethodId, data.reference);
      const transactionNo = await nextTransactionNo(tid);
      updatedOrder = await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.create({ data: { tenantId: tid, orderId: order.id, paymentMethodId: data.paymentMethodId, amount: data.amount, reference: data.reference, receivedBy: req.userId } });
        await tx.transaction.create({
          data: {
            tenantId: tid,
            transactionNo,
            direction: "IN",
            source: "POS_SALE",
            amount: data.amount,
            paymentMethodId: data.paymentMethodId,
            reference: data.reference,
            customerId: order.customerId ?? order.reservation?.customerId ?? null,
            locationId: order.locationId,
            employeeId: req.userId,
            description: `POS order #${order.orderNumber} payment`,
            sourceRefId: payment.id,
          },
        });
        const paidSoFar = alreadyPaid + data.amount;
        const newStatus = order.status === "SERVED" && paidSoFar >= total - 0.01 ? "COMPLETED" : order.status;
        await tx.posOrder.update({ where: { id: order.id }, data: { status: newStatus, paymentStatus: paymentStatusFor(paidSoFar, total) } });
        if (newStatus === "COMPLETED" && order.status === "SERVED" && order.tableId) await releaseTableIfIdle(tx, order.tableId);
        if (newStatus === "COMPLETED") await mergeDuplicateOrderLines(tx, order.id, { includeFlagged: true });
        await reconcileOrderCredit(tx, { tenantId: tid, orderId: order.id, orderNumber: order.orderNumber, customerId: custId, status: newStatus, paid: paidSoFar, total, by: req.userId });
        return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
      });
    }
    res.status(201).json({ order: withFinancials(updatedOrder, tax) });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

/** Completes a served order for whatever's been paid — the rest goes onto
 * the customer's balance as credit. Needs a customer attached once anything
 * is left owing. Idempotent-ish: on an already-full order it just marks it
 * COMPLETED / PAID. */
posRouter.post("/orders/:id/settle", async (req, res) => {
  const id = req.params.id as string;
  const parsed = settleSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid settlement details", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const [order, tax] = await Promise.all([
    prisma.posOrder.findFirst({ where: { id, tenantId: tid }, include: orderInclude }),
    taxSettingsFor(tid),
  ]);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (!ownsOrder(order, req)) { res.status(403).json({ error: "You can only complete your own orders" }); return; }
  if (order.status !== "SERVED") { res.status(409).json({ error: "Only a served order can be completed" }); return; }
  if (hasPendingAdditions(order)) { res.status(409).json({ error: "The kitchen hasn't handed over the items added to this order yet" }); return; }
  if (hasPendingReturnRequests(order)) {
    res.status(409).json({ error: "Approve or reject the pending return before completing this order" });
    return;
  }
  const { total } = computeOrderFinancials(order, tax);
  const paid = order.payments.reduce((s, p) => s + Number(p.amount), 0);
  const shortfall = money2(total - paid);
  if (shortfall > 0.01 && !order.customerId) {
    res.status(400).json({ error: "Attach a customer before completing this order on credit" });
    return;
  }
  if (shortfall > 0.01 && (!parsed.data.creditReason || !parsed.data.creditExpectedAt)) {
    res.status(400).json({ error: "Give a credit reason and expected payment date before completing on credit" });
    return;
  }
  const updated = await prisma.$transaction(async (tx) => {
    await tx.posOrder.update({
      where: { id: order.id },
      data: {
        status: "COMPLETED",
        paymentStatus: paymentStatusFor(paid, total),
        creditReason: shortfall > 0.01 ? parsed.data.creditReason : null,
        creditExpectedAt: shortfall > 0.01 ? parsed.data.creditExpectedAt : null,
      },
    });
    if (order.tableId) await releaseTableIfIdle(tx, order.tableId);
    await mergeDuplicateOrderLines(tx, order.id, { includeFlagged: true });
    await reconcileOrderCredit(tx, { tenantId: tid, orderId: order.id, orderNumber: order.orderNumber, customerId: order.customerId, status: "COMPLETED", paid, total, by: req.userId });
    return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  });
  res.status(200).json({ order: withFinancials(updated, tax) });
});

/** Attaches (or changes) the customer a POS order is for — used at
 * settlement when a walk-in turns out to need credit. Blocked once the
 * order has recorded credit against a different customer. */
posRouter.post("/orders/:id/customer", async (req, res) => {
  const id = req.params.id as string;
  const parsed = z.object({ customerId: z.string().trim().min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose a customer" }); return; }
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id, tenantId: tid }, include: orderInclude });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (!ownsOrder(order, req)) { res.status(403).json({ error: "You can only manage your own orders" }); return; }
  if (["CANCELLED", "PENDING_CANCELLATION"].includes(order.status)) { res.status(409).json({ error: "This order can't be changed" }); return; }
  const customer = await prisma.customer.findFirst({ where: { id: parsed.data.customerId, tenantId: tid }, select: { id: true } });
  if (!customer) { res.status(400).json({ error: "Choose a customer from this property" }); return; }
  if (order.customerId && order.customerId !== customer.id) {
    const credited = await prisma.customerCreditEntry.count({ where: { orderId: order.id } });
    if (credited > 0) { res.status(409).json({ error: "This order already has credit recorded against a customer" }); return; }
  }
  const updated = await prisma.posOrder.update({ where: { id: order.id }, data: { customerId: customer.id }, include: orderInclude });
  const tax = await taxSettingsFor(tid);
  res.status(200).json({ order: withFinancials(updated, tax) });
});

posRouter.get("/orders/:id", async (req, res) => {
  const tid = tenantIdFor(req);
  const [order, tax] = await Promise.all([
    prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, include: orderInclude }),
    taxSettingsFor(tid),
  ]);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  res.status(200).json({ order: await withServedBy(withFinancials(order, tax)) });
});

/** Mint (once) and return a public, no-auth link to this order's receipt. The
 * link's origin is taken from the calling app so it points back at whatever
 * host the POS is served from. */
posRouter.post("/orders/:id/share", async (req, res) => {
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, shareToken: true } });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }

  let token = order.shareToken;
  if (!token) {
    token = randomBytes(12).toString("base64url");
    await prisma.posOrder.update({ where: { id: order.id }, data: { shareToken: token } });
  }

  const base = (req.get("origin") || process.env.PUBLIC_APP_URL || "").replace(/\/$/, "");
  res.status(200).json({ token, url: `${base}/r/${token}` });
});

/** Queues a print request for this order at its own location — for a device
 * with no printer of its own (most waiters' phones). Any other device at
 * that location already configured with a working thermal-printer
 * connection polls GET /pos/print-jobs/pending in the background and prints
 * it over its own Bluetooth/USB/bridge connection. See PrintJob's own
 * schema comment for the full design. */
posRouter.post("/orders/:id/print-jobs", async (req, res) => {
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, locationId: true } });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (!order.locationId) { res.status(400).json({ error: "This order has no location on it, so there's no printer to route it to" }); return; }
  const job = await prisma.printJob.create({
    data: { tenantId: tid, locationId: order.locationId, orderId: order.id, requestedBy: req.userId ?? null },
    select: { id: true, status: true, createdAt: true },
  });
  res.status(201).json({ job });
});

/** The full active add-on catalog for the checkout add-on picker, each with
 * its menu category so the client can filter. Managed via /api/addons. */
posRouter.get("/addons", async (req, res) => res.json({
  addons: await prisma.addon.findMany({
    where: { tenantId: tenantIdFor(req), isActive: true, scope: "MENU" },
    select: { id: true, name: true, description: true, price: true, imageUrl: true, menuCategoryId: true, menuCategory: { select: { id: true, name: true } } },
    orderBy: [{ menuCategory: { name: "asc" } }, { name: "asc" }],
  }),
}));

/** The add-ons the Services POS offers (Hot stones, Engine wash...), each tied to a service category or open to every service. */
posRouter.get("/service-addons", async (req, res) => res.json({
  addons: await prisma.addon.findMany({
    where: { tenantId: tenantIdFor(req), isActive: true, scope: "SERVICE" },
    select: { id: true, name: true, description: true, price: true, serviceCategoryId: true, serviceCategory: { select: { id: true, name: true } } },
    orderBy: [{ serviceCategory: { name: "asc" } }, { name: "asc" }],
  }),
}));

/** Returns the café-wide POS policy for this tenant. */
posRouter.get("/settings", async (req, res) => {
  const settings = await prisma.cafeSettings.findUnique({ where: { tenantId: tenantIdFor(req) } });
  res.status(200).json({ settings });
});

/** Creates or updates the café-wide POS and inventory policy. */
posRouter.put("/settings", async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid café settings", details: parsed.error.flatten() });
    return;
  }

  const settings = await prisma.cafeSettings.upsert({
    where: { tenantId: tenantIdFor(req) },
    create: { tenantId: tenantIdFor(req), ...parsed.data },
    update: parsed.data,
  });

  res.status(200).json({ settings });
});

/** Lists the café items the cashier can add to an order. Managed (create/edit/delete) via /menu/items.
 * Location-scoped: a fixed-location employee always sees their own location's
 * menu; an unassigned employee sees only unallocated items until they pass
 * ?locationId= (the frontend should prompt them to pick one). Properties
 * that have never created a Location see everything, unfiltered. */
posRouter.get("/menu-items", async (req, res) => {
  const tid = tenantIdFor(req);
  const query = z.object({ locationId: z.string().cuid().optional() }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid filters" }); return; }

  const [fixedLocationId, locationCount, taxDefaults] = await Promise.all([
    employeeLocationId(tid, req.userId),
    prisma.location.count({ where: { tenantId: tid } }),
    taxSettingsFor(tid),
  ]);
  const effectiveLocationId = fixedLocationId ?? query.data.locationId ?? null;
  // Where the kitchen must ask the store for ingredients, its own shelf is empty
  // by design - "how many can I sell" is what the supplying store still holds.
  const availabilityLocationId = await (async () => {
    if (!effectiveLocationId) return null;
    const loc = await prisma.location.findFirst({ where: { id: effectiveLocationId, tenantId: tid }, select: { id: true, serveMode: true, requireStoreDispatch: true, dispatchFromLocationId: true } });
    return loc && dispatchRequired(loc) ? (await supplyingStoreId(tid, loc)) ?? effectiveLocationId : effectiveLocationId;
  })();

  const where: Prisma.MenuItemWhereInput = {
    tenantId: tid,
    isAvailable: true,
    ...(locationCount > 0 ? { OR: [{ locations: { none: {} } }, ...(effectiveLocationId ? [{ locations: { some: { id: effectiveLocationId } } }] : [])] } : {}),
  };

  // A sentinel that can never match a real location id — used instead of
  // omitting the `where` below (which would fetch every location's stock and
  // wrongly sum them). When there's genuinely no location context yet,
  // availableQuantity is forced to null (untracked) after the query, not
  // computed from this deliberately-empty result.
  const stockWhere = { locationId: availabilityLocationId ?? "__no_location__" };

  const rows = await prisma.menuItem.findMany({
    where,
    include: {
      menuCategory: true,
      product: { include: { packUnit: { select: { id: true, name: true } }, stocks: { where: stockWhere, select: { quantity: true } } } },
      locations: { select: { id: true, name: true } },
      recipe: { include: { ingredients: { include: { product: { include: { stocks: { where: stockWhere, select: { quantity: true } } } } } } } },
      variants: {
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: {
          id: true, name: true, price: true, sku: true,
          stockQtyPerUnit: true,
          recipe: { select: { ingredients: { select: { quantity: true, product: { select: { id: true, stocks: { where: stockWhere, select: { quantity: true } } } } } } } },
          ingredientOverrides: { select: { quantity: true, isRemoved: true, product: { select: { id: true, stocks: { where: stockWhere, select: { quantity: true } } } } } },
          stockProduct: {
            select: {
              id: true,
              name: true,
              unit: true,
              packUnit: { select: { id: true, name: true } },
              stocks: { where: stockWhere, select: { quantity: true } },
            },
          },
        },
      },
    },
    orderBy: [{ menuCategory: { sortOrder: "asc" } }, { sortOrder: "asc" }, { name: "asc" }],
  });

  /** How many of this item (or variant) can be sold right now — floor(stock
   * / qty-per-unit), or the minimum across a recipe's ingredients. null means
   * untracked (no product/recipe link) — always orderable, no stock pill. */
  function availabilityFor(stockQty: number, perUnit: number | null | undefined): number | null {
    const per = Number(perUnit ?? 1);
    return per > 0 ? Math.floor(stockQty / per) : null;
  }

  const items = rows.map(({ menuCategory, taxRate, taxMode, taxTreatment, product, recipe, variants, stockQtyPerUnit, ...item }) => {
    let availableQuantity: number | null = null;
    let availabilityUnitLabel: string | null = null;
    if (product) {
      availableQuantity = availabilityFor(Number(product.stocks[0]?.quantity ?? 0), stockQtyPerUnit != null ? Number(stockQtyPerUnit) : null);
      // packLabel is the noun for one PACK ("Bottle") — what availableQuantity
      // actually counts once stockQtyPerUnit divides pack-unit stock (ml) back
      // down to whole packs. The raw pack UNIT name ("Millilitres") describes
      // how the stock is held, not what's being counted, and reads as if there
      // were only a couple of millilitres left — only fall back to it (then
      // product.unit) for a product with no packLabel at all.
      availabilityUnitLabel = product.packLabel ?? product.packUnit?.name ?? product.unit;
    } else if (recipe && recipe.ingredients.length > 0) {
      const perIngredient = recipe.ingredients.map((ing) => availabilityFor(Number(ing.product.stocks[0]?.quantity ?? 0), Number(ing.quantity)));
      availableQuantity = perIngredient.every((n) => n !== null) ? Math.min(...(perIngredient as number[])) : null;
      availabilityUnitLabel = "servings";
    }
    // A variant made from its own recipe: servings = the scarcest effective ingredient.
    const recipeAvailability = (v: (typeof variants)[number]): number | null => {
      if (!v.recipe) return null;
      const merged = new Map<string, { per: number; stock: number }>();
      for (const ing of v.recipe.ingredients) merged.set(ing.product.id, { per: Number(ing.quantity), stock: Number(ing.product.stocks[0]?.quantity ?? 0) });
      for (const o of v.ingredientOverrides) {
        if (o.isRemoved) merged.delete(o.product.id);
        else merged.set(o.product.id, { per: Number(o.quantity), stock: Number(o.product.stocks[0]?.quantity ?? 0) });
      }
      const counts = [...merged.values()].filter((m) => m.per > 0).map((m) => Math.floor(m.stock / m.per));
      return counts.length ? Math.min(...counts) : null;
    };
    const variantsWithStock = variants.map(({ stockProduct, stockQtyPerUnit: variantPerUnit, recipe: variantRecipe, ingredientOverrides, ...variant }) => ({
      ...variant,
      stockQtyPerUnit: variantPerUnit,
      stockProduct: stockProduct
        ? {
            id: stockProduct.id,
            name: stockProduct.name,
            unit: stockProduct.unit,
            packUnit: stockProduct.packUnit,
          }
        : null,
      availableQuantity: stockProduct ? availabilityFor(Number(stockProduct.stocks[0]?.quantity ?? 0), variantPerUnit != null ? Number(variantPerUnit) : null) : recipeAvailability({ ...variant, recipe: variantRecipe, ingredientOverrides } as (typeof variants)[number]),
      availabilityUnitLabel: stockProduct ? variant.name : variantRecipe ? "servings" : null,
    }));
    // A base item with no stock link of its own but stock-tracked variants
    // (e.g. spirits: the item carries no product/recipe, each pour size —
    // Tot/Double/Bottle — draws from the same bottle stock independently) —
    // the card's at-a-glance figure is the best case among them.
    if (availableQuantity === null && variantsWithStock.some((v) => v.availableQuantity !== null)) {
      const bestVariant = variantsWithStock.reduce((best, v) => ((v.availableQuantity ?? -1) > (best.availableQuantity ?? -1) ? v : best));
      availableQuantity = bestVariant.availableQuantity;
      availabilityUnitLabel = bestVariant.availabilityUnitLabel;
    }
    if (!effectiveLocationId) availableQuantity = null;
    return {
      ...item,
      category: menuCategory,
      variants: variantsWithStock.map((v) => ({ ...v, availableQuantity: effectiveLocationId ? v.availableQuantity : null })),
      availableQuantity,
      availabilityUnitLabel: effectiveLocationId ? availabilityUnitLabel : null,
      // Resolved effective tax (item override else tenant default) so the cart
      // can show a correct preview. The server re-resolves and snapshots this
      // on order create — the client value is never trusted for money.
      taxRate: taxRate ?? taxDefaults?.taxRate ?? null,
      taxMode: taxMode ?? taxDefaults?.taxMode ?? null,
      taxTreatment: taxTreatment ?? taxDefaults?.taxTreatment ?? null,
    };
  });
  res.status(200).json({ items });
});

/** Lists the products the cashier can add to a retail sale at their location
 * — every active sellable one, including zero-stock (shown, not hidden, so
 * "we don't have this" is visible at a glance rather than the item just
 * disappearing from the grid). */
posRouter.get("/product-items", async (req, res) => {
  const tid = tenantIdFor(req);
  const query = z.object({ locationId: z.string().cuid().optional() }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid filters" }); return; }
  const fixedLocationId = await employeeLocationId(tid, req.userId);
  const effectiveLocationId = fixedLocationId ?? query.data.locationId ?? null;
  if (!effectiveLocationId) { res.status(200).json({ items: [] }); return; }

  const items = await prisma.product.findMany({
    where: { tenantId: tid, isActive: true, sellsDirectly: true },
    include: { category: true, packUnit: { select: { id: true, name: true } }, stocks: { where: { locationId: effectiveLocationId }, select: { quantity: true } } },
    orderBy: { name: "asc" },
  });
  res.status(200).json({
    items: items.map((item) => {
      const stockQuantity = Number(item.stocks[0]?.quantity ?? 0);
      const packSize = Number(item.packSize) || 0;
      return { ...item, availableQuantity: packSize > 0 ? Math.floor(stockQuantity / packSize) : stockQuantity };
    }),
  });
});

/** Lists the services the cashier can add to a sale at their location.
 * Same unallocated-means-everywhere convention as menu items. */
posRouter.get("/service-items", async (req, res) => {
  const tid = tenantIdFor(req);
  const query = z.object({ locationId: z.string().cuid().optional() }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid filters" }); return; }
  const [fixedLocationId, locationCount] = await Promise.all([
    employeeLocationId(tid, req.userId),
    prisma.location.count({ where: { tenantId: tid } }),
  ]);
  const effectiveLocationId = fixedLocationId ?? query.data.locationId ?? null;

  const where: Prisma.ServiceWhereInput = {
    tenantId: tid,
    isActive: true,
    ...(locationCount > 0 ? { OR: [{ locations: { none: {} } }, ...(effectiveLocationId ? [{ locations: { some: { id: effectiveLocationId } } }] : [])] } : {}),
  };
  const [items, taxDefaults] = await Promise.all([
    prisma.service.findMany({
      where,
      include: {
        category: true,
        unit: true,
        locations: { select: { id: true, name: true } },
        variants: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, price: true, durationMinutes: true, sku: true } },
      },
      orderBy: { name: "asc" },
    }),
    taxSettingsFor(tid),
  ]);
  // Same resolution as menu items: the service's own override, else the property default -
  // the till previews exactly what the server will snapshot on the sale.
  res.status(200).json({
    items: items.map((item) => ({
      ...item,
      taxRate: item.taxRate ?? taxDefaults?.taxRate ?? null,
      taxMode: item.taxMode ?? taxDefaults?.taxMode ?? null,
      taxTreatment: item.taxTreatment ?? taxDefaults?.taxTreatment ?? null,
    })),
  });
});

/** Rings up a retail (Products) or service sale. Neither has a kitchen step,
 * so the order is created directly as SERVED — payment is taken immediately
 * after via the same POST /orders/:id/payments used for food. */
posRouter.post("/retail-orders", async (req, res) => {
  const parsed = retailOrderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid order", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);

  const locationResult = await resolveEffectiveLocation(tid, req.userId, parsed.data.locationId);
  if ("error" in locationResult) { res.status(400).json({ error: locationResult.error }); return; }
  const { location } = locationResult;
  const channel = parsed.data.channel;
  if (location && channel === "PRODUCTS" && !location.canSellProducts) { res.status(409).json({ error: `${location.name} isn't set up to sell products` }); return; }
  if (location && channel === "SERVICES" && !location.canSellServices) { res.status(409).json({ error: `${location.name} isn't set up to sell services` }); return; }
  const effectiveLocationId = location?.id ?? null;

  let customerId: string | undefined;
  try {
    customerId = await resolveCustomerId(tid, parsed.data.customerId);
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
  const tax = await taxSettingsFor(tid);
  // Retail lines carry the tenant's default tax treatment as their snapshot,
  // the same way a menu line carries its own — keeps receipts and the tax
  // breakdown complete across every channel.
  const retailFallbackTax = { taxRate: tax?.taxRate ?? null, taxMode: tax?.taxMode ?? null, taxTreatment: tax?.taxTreatment ?? null };

  try {
    const order = await prisma.$transaction(async (tx) => {
      let itemsCreate: Prisma.PosOrderItemCreateWithoutOrderInput[];
      const productNames = new Map<string, string>();
      const productsById = new Map<string, SaleProductSnapshot>();

      if (channel === "PRODUCTS") {
        if (!effectiveLocationId) throw Object.assign(new Error("Choose which location this sale is for"), { status: 400 });
        const productIds = parsed.data.items.map((item) => item.productId);
        const products = await tx.product.findMany({
          where: { id: { in: productIds }, tenantId: tid, isActive: true, sellsDirectly: true },
          select: { id: true, name: true, sellingPrice: true, taxRate: true, taxMode: true, taxTreatment: true, packSize: true },
        });
        if (products.length !== new Set(productIds).size) throw Object.assign(new Error("Every item must be an active, sellable product from this property"), { status: 400 });
        for (const p of products) {
          productNames.set(p.id, p.name);
          productsById.set(p.id, p);
        }
        itemsCreate = parsed.data.items.map((item) => {
          const product = productsById.get(item.productId)!;
          return {
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: product.sellingPrice!,
            taxRate: product.taxRate ?? retailFallbackTax.taxRate,
            taxMode: product.taxMode ?? retailFallbackTax.taxMode,
            taxTreatment: product.taxTreatment ?? retailFallbackTax.taxTreatment,
          };
        });
      } else {
        const serviceIds = [...new Set(parsed.data.items.map((item) => item.serviceId))];
        const addonIds = [...new Set(parsed.data.items.flatMap((item) => item.addons.map((a) => a.addonId)))];
        const [services, serviceAddons] = await Promise.all([
          tx.service.findMany({ where: { id: { in: serviceIds }, tenantId: tid, isActive: true }, include: { locations: { select: { id: true } }, variants: { where: { isActive: true } } } }),
          addonIds.length ? tx.addon.findMany({ where: { id: { in: addonIds }, tenantId: tid, isActive: true, scope: "SERVICE" }, select: { id: true, name: true, price: true, serviceCategoryId: true } }) : Promise.resolve([]),
        ]);
        if (services.length !== serviceIds.length) throw Object.assign(new Error("Every item must be an active service from this property"), { status: 400 });
        if (serviceAddons.length !== addonIds.length) throw Object.assign(new Error("Every add-on must be an active service add-on from this property"), { status: 400 });
        // A service allocated to specific locations may only be sold there (empty = everywhere).
        const notHere = services.find((s) => s.locations.length > 0 && (!effectiveLocationId || !s.locations.some((l) => l.id === effectiveLocationId)));
        if (notHere) throw Object.assign(new Error(`"${notHere.name}" isn't sold at this location`), { status: 409 });
        const byId = new Map(services.map((s) => [s.id, s]));
        const addonById = new Map(serviceAddons.map((a) => [a.id, a]));
        itemsCreate = parsed.data.items.map((item) => {
          const service = byId.get(item.serviceId)!;
          // Sizes/options: required once a service has any active ones.
          if (service.variants.length > 0 && !item.variantId) throw Object.assign(new Error(`Choose an option for "${service.name}"`), { status: 400 });
          const variant = item.variantId ? service.variants.find((v) => v.id === item.variantId) : undefined;
          if (item.variantId && !variant) throw Object.assign(new Error(`That option isn't available for "${service.name}"`), { status: 400 });
          const addonIdsOnLine = item.addons.map((a) => a.addonId);
          if (new Set(addonIdsOnLine).size !== addonIdsOnLine.length) throw Object.assign(new Error("Each add-on can only appear once per line"), { status: 400 });
          for (const line of item.addons) {
            const addon = addonById.get(line.addonId)!;
            if (addon.serviceCategoryId && addon.serviceCategoryId !== service.categoryId) throw Object.assign(new Error(`"${addon.name}" isn't offered with "${service.name}"`), { status: 400 });
          }
          const listPrice = variant?.price ?? service.price;
          // Override: charge another price, but keep the list price and the reason on the line.
          const overridden = item.unitPrice !== undefined && Math.abs(item.unitPrice - Number(listPrice)) > 0.004;
          if (overridden && !(item.overrideReason && item.overrideReason.length >= 3)) throw Object.assign(new Error(`Give a reason for changing the price of "${service.name}"`), { status: 400 });
          return {
            serviceId: item.serviceId,
            serviceVariantId: variant?.id,
            quantity: item.quantity,
            unitPrice: overridden ? item.unitPrice! : listPrice,
            ...(overridden ? { listPrice, priceOverrideReason: item.overrideReason, priceOverriddenBy: req.userId } : {}),
            // The service's own tax (else the property default), frozen on the line like a menu item.
            taxRate: service.taxRate ?? retailFallbackTax.taxRate,
            taxMode: service.taxMode ?? retailFallbackTax.taxMode,
            taxTreatment: service.taxTreatment ?? retailFallbackTax.taxTreatment,
            unitCost: variant?.cost ?? service.cost,
            addons: { create: item.addons.map((line) => ({ addonId: line.addonId, quantity: line.quantity, unitPrice: addonById.get(line.addonId)!.price })) },
          };
        });
      }

      const last = await tx.posOrder.findFirst({ where: { tenantId: tid }, orderBy: { orderNumber: "desc" }, select: { orderNumber: true } });
      const created = await tx.posOrder.create({
        data: {
          tenantId: tid,
          orderNumber: (last?.orderNumber ?? 0) + 1,
          channel,
          status: "SERVED",
          servedAt: new Date(),
          locationId: effectiveLocationId,
          customerId,
          createdBy: req.userId,
          notes: parsed.data.notes,
          discount: parsed.data.discount,
          items: { create: itemsCreate },
        },
        include: orderInclude,
      });

      if (channel === "PRODUCTS") {
        for (const item of parsed.data.items) {
          const product = productsById.get(item.productId)!;
          const stockQuantity = item.quantity * (Number(product.packSize) || 1);
          try {
            await recordStockMovement(tx, {
              tenantId: tid, productId: item.productId, locationId: effectiveLocationId!, type: "SALE",
              quantity: -stockQuantity, note: `Sold — POS order #${created.orderNumber}`,
              sourceType: "POS_ORDER", sourceRefId: created.id, performedBy: req.userId ?? null,
              label: productNames.get(item.productId) ?? "stock",
            });
          } catch (error) {
            if (error instanceof InsufficientStockError) throw Object.assign(new Error(`Not enough ${error.label} at this location`), { status: 409 });
            throw error;
          }
        }
      }
      if (channel === "SERVICES") {
        // A service that uses a product or recipe (lotion, wash chemicals) consumes it now,
        // from the location it's sold at - the same maths and ledger as a menu item.
        const requirements = computeStockRequirements(created.items);
        if (requirements.size > 0) {
          const stockLocationId = await resolveStockLocationId(tid, effectiveLocationId);
          if (!stockLocationId) throw Object.assign(new Error("No location is configured to hold stock for this sale"), { status: 400 });
          await deductStockForOrder(tx, tid, requirements, stockLocationId, created.orderNumber, req);
        }
      }
      return created;
    });
    res.status(201).json({ order: withFinancials(order, tax) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

// ============================================================================
// Print job relay — see the PrintJob schema comment for the design. A device
// polls /pending for its own working location, atomically /claim's one
// before printing it (so two polling hosts never both print the same job),
// then reports back /complete or /fail.
// ============================================================================

posRouter.get("/print-jobs/pending", async (req, res) => {
  const tid = tenantIdFor(req);
  const query = z.object({ locationId: z.string().cuid() }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "A locationId is required" }); return; }
  const jobs = await prisma.printJob.findMany({
    where: { tenantId: tid, locationId: query.data.locationId, status: "PENDING" },
    select: { id: true, orderId: true, kind: true, createdAt: true, nudgedAt: true },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  res.status(200).json({ jobs });
});

/** The requester flags a still-pending job as taking a while — surfaced to
 * whichever device is polling /pending (the print-job indicator badge) so a
 * stuck job is visible there instead of silently waiting on a tab that's
 * closed, asleep, or lost its Bluetooth connection. */
posRouter.post("/print-jobs/:id/nudge", async (req, res) => {
  const tid = tenantIdFor(req);
  const updated = await prisma.printJob.updateMany({
    where: { id: req.params.id, tenantId: tid, status: { in: ["PENDING", "CLAIMED"] } },
    data: { nudgedAt: new Date() },
  });
  if (!updated.count) { res.status(409).json({ error: "This job has already finished" }); return; }
  res.status(204).send();
});

posRouter.post("/print-jobs/:id/claim", async (req, res) => {
  const tid = tenantIdFor(req);
  const claimed = await prisma.printJob.updateMany({
    where: { id: req.params.id, tenantId: tid, status: "PENDING" },
    data: { status: "CLAIMED", claimedBy: req.userId ?? null, claimedAt: new Date() },
  });
  if (!claimed.count) { res.status(409).json({ error: "Already claimed by another device, or not found" }); return; }
  const job = await prisma.printJob.findUniqueOrThrow({ where: { id: req.params.id }, select: { id: true, orderId: true, status: true, kind: true, dispatchRequestId: true } });
  // A dispatch slip travels with the claim, so the printing device needs no store permissions of its own.
  const slip = job.kind === "DISPATCH" && job.dispatchRequestId ? await dispatchSlipFor(tid, job.dispatchRequestId) : null;
  res.status(200).json({ job, slip });
});

posRouter.post("/print-jobs/:id/complete", async (req, res) => {
  const tid = tenantIdFor(req);
  const updated = await prisma.printJob.updateMany({
    where: { id: req.params.id, tenantId: tid, status: "CLAIMED" },
    data: { status: "DONE", completedAt: new Date() },
  });
  if (!updated.count) { res.status(404).json({ error: "Print job not found or not claimed" }); return; }
  res.status(204).send();
});

posRouter.post("/print-jobs/:id/fail", async (req, res) => {
  const tid = tenantIdFor(req);
  const data = z.object({ error: z.string().trim().max(300).optional() }).safeParse(req.body);
  const updated = await prisma.printJob.updateMany({
    where: { id: req.params.id, tenantId: tid, status: "CLAIMED" },
    data: { status: "FAILED", completedAt: new Date(), error: data.success ? (data.data.error ?? null) : null },
  });
  if (!updated.count) { res.status(404).json({ error: "Print job not found or not claimed" }); return; }
  res.status(204).send();
});

/** So a waiter's screen can show "Printing…" -> "Printed"/"Failed" instead
 * of a fire-and-forget toast, without needing its own polling endpoint. */
posRouter.get("/print-jobs/:id", async (req, res) => {
  const tid = tenantIdFor(req);
  const job = await prisma.printJob.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, status: true, error: true, nudgedAt: true } });
  if (!job) { res.status(404).json({ error: "Print job not found" }); return; }
  res.status(200).json({ job });
});
