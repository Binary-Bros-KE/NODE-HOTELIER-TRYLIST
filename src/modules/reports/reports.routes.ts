import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { computeOrderFinancials } from "../../lib/orderTotals.js";
import { stockValue } from "../../lib/stockValuation.js";
import { taxSettingsFor } from "../pos/pos.routes.js";
import { businessDateOnly, businessDayKey, businessDayWindowForDateOnly, addDays as addBusinessDays } from "../../lib/businessDay.js";

export const reportsRouter = Router();
reportsRouter.use(requireModule("REPORTS"));

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Local calendar date, not UTC — "from"/"to" are parsed as local midnight
// below, so the default must agree with that or the window silently shifts.
function localIsoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayBounds(from?: string, to?: string) {
  const today = localIsoToday();
  const start = new Date(`${from ?? today}T00:00:00.000`);
  const end = new Date(`${to ?? from ?? today}T23:59:59.999`);
  return { start, end };
}

// The old till-reconciliation /sales endpoint (payments-by-method/cashier,
// served-but-unpaid orders) has been fully superseded by the Sales Report v2
// engine below — see its own header comment.

// ============================================================================
// Sales Report — a full financial report, not just till reconciliation.
// ============================================================================

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function businessDayStartHourFor(tid: string): Promise<number> {
  const profile = await prisma.businessProfile.findUnique({ where: { tenantId: tid }, select: { businessDayStartHour: true } });
  return profile?.businessDayStartHour ?? 0;
}

/** day/week(Mon-Sun)/month(calendar)/custom(from-to) — every boundary is a
 * "business day" per businessDayWindowForDateOnly (Nairobi wall-clock,
 * rolling over at the tenant's configured startHour instead of plain
 * midnight), not the server process's own local time. A calendar date names
 * the business day that STARTS on it — e.g. with startHour=9, "date=Sep 18"
 * means the trading day running Sep 18 09:00 to Sep 19 09:00. */
function resolveSalesRange(period: "day" | "week" | "month" | "custom", dateStr: string | undefined, fromStr: string | undefined, toStr: string | undefined, startHour: number) {
  const anchorDateOnly = dateStr ? new Date(`${dateStr}T00:00:00.000Z`) : businessDateOnly(startHour, new Date());
  if (period === "custom") {
    const fromOnly = new Date(`${fromStr}T00:00:00.000Z`);
    const toOnly = new Date(`${toStr ?? fromStr}T00:00:00.000Z`);
    return { start: businessDayWindowForDateOnly(startHour, fromOnly).start, end: businessDayWindowForDateOnly(startHour, toOnly).end };
  }
  if (period === "week") {
    const diffToMonday = (anchorDateOnly.getUTCDay() + 6) % 7; // Sun=0..Sat=6 -> days back to Monday
    const monday = addBusinessDays(anchorDateOnly, -diffToMonday);
    const sunday = addBusinessDays(monday, 6);
    return { start: businessDayWindowForDateOnly(startHour, monday).start, end: businessDayWindowForDateOnly(startHour, sunday).end };
  }
  if (period === "month") {
    const first = new Date(Date.UTC(anchorDateOnly.getUTCFullYear(), anchorDateOnly.getUTCMonth(), 1));
    const last = new Date(Date.UTC(anchorDateOnly.getUTCFullYear(), anchorDateOnly.getUTCMonth() + 1, 0));
    return { start: businessDayWindowForDateOnly(startHour, first).start, end: businessDayWindowForDateOnly(startHour, last).end };
  }
  return businessDayWindowForDateOnly(startHour, anchorDateOnly);
}

type Moneyish = Prisma.Decimal | number | null;

/** Cost of one sold line (quantity already applied), checked in priority
 * order: a direct retail-product sale, then a variant's own bar/stock link,
 * then the menu item's recipe, then the menu item's own direct product link.
 * Null means "can't be costed" (a Service line, or a MenuItem with none of
 * the above) — never silently treated as zero, so it can be surfaced as a
 * caveat instead of quietly inflating Net Revenue. */
type CostableItem = {
  quantity: number;
  product: { unitCost: Moneyish; packSize: Moneyish } | null;
  variant: { stockQtyPerUnit: Moneyish; stockProduct: { unitCost: Moneyish; packSize: Moneyish } | null } | null;
  service: { id: string } | null;
  menuItem: {
    stockQtyPerUnit: Moneyish;
    product: { unitCost: Moneyish; packSize: Moneyish } | null;
    recipe: { ingredients: { quantity: Moneyish; product: { unitCost: Moneyish; packSize: Moneyish } }[] } | null;
  } | null;
};

function resolveItemCost(item: CostableItem): number | null {
  if (item.product) return item.product.unitCost != null ? Number(item.product.unitCost) * item.quantity : null;
  if (item.variant?.stockProduct) {
    const perUnit = Number(item.variant.stockQtyPerUnit ?? 1);
    return stockValue(perUnit * item.quantity, item.variant.stockProduct.unitCost, item.variant.stockProduct.packSize);
  }
  if (item.menuItem?.recipe?.ingredients.length) {
    if (item.menuItem.recipe.ingredients.some((ing) => ing.product.unitCost == null)) return null;
    const perUnit = item.menuItem.recipe.ingredients.reduce((s, ing) => s + (stockValue(ing.quantity, ing.product.unitCost, ing.product.packSize) ?? 0), 0);
    return perUnit * item.quantity;
  }
  if (item.menuItem?.product) {
    const perUnit = Number(item.menuItem.stockQtyPerUnit ?? 1);
    return stockValue(perUnit * item.quantity, item.menuItem.product.unitCost, item.menuItem.product.packSize);
  }
  if (item.service) return 0;
  return null;
}

const salesQuerySchema = z.object({
  period: z.enum(["day", "week", "month", "custom"]).default("day"),
  date: isoDate.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  locationId: z.string().trim().optional(),
}).refine((v) => v.period !== "custom" || !!v.from, { message: "A custom range needs a from date", path: ["from"] });

const orderItemInclude = {
  addons: { select: { quantity: true, unitPrice: true } },
  product: { select: { id: true, name: true, unit: true, unitCost: true, packSize: true } },
  service: { select: { id: true, name: true } },
  variant: { select: { id: true, name: true, stockQtyPerUnit: true, stockProduct: { select: { unitCost: true, packSize: true } } } },
  menuItem: {
    select: {
      id: true,
      name: true,
      stockQtyPerUnit: true,
      product: { select: { unitCost: true, packSize: true } },
      recipe: { select: { ingredients: { select: { quantity: true, product: { select: { unitCost: true, packSize: true } } } } } },
    },
  },
} as const;

reportsRouter.get("/sales", async (req, res, next) => {
  try {
    const query = salesQuerySchema.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid report filters", details: query.error.flatten() }); return; }
    const { period, date, from, to, locationId } = query.data;
    const tid = tenantId(req);
    const startHour = await businessDayStartHourFor(tid);
    const { start, end } = resolveSalesRange(period, date, from, to, startHour);
    const trendAnchor = businessDateOnly(startHour, end);
    const trendStart = businessDayWindowForDateOnly(startHour, addBusinessDays(trendAnchor, -5)).start;
    const trendEnd = businessDayWindowForDateOnly(startHour, addBusinessDays(trendAnchor, 5)).end;

    const [
      tax, completedOrders, cancelledOrders, transactionsIn, trendTransactions,
      appointmentsPaid, membershipPayments, expenses, goodsReceiptItems,
      cancelledPurchases, supplierPayments, debtorCustomers, openFolios,
      creditorSuppliers, employeesForBranch,
    ] = await Promise.all([
      taxSettingsFor(tid),
      prisma.posOrder.findMany({
        where: { tenantId: tid, status: "COMPLETED", updatedAt: { gte: start, lte: end }, ...(locationId ? { locationId } : {}) },
        include: { items: { include: orderItemInclude }, location: { select: { id: true, name: true } }, customer: { select: { id: true, firstName: true, lastName: true } }, complimentarySession: true, payments: { select: { amount: true } } },
      }),
      prisma.posOrder.findMany({
        where: { tenantId: tid, status: "CANCELLED", updatedAt: { gte: start, lte: end }, ...(locationId ? { locationId } : {}) },
        include: { items: { include: { addons: { select: { quantity: true, unitPrice: true } } } } },
      }),
      prisma.transaction.findMany({
        where: { tenantId: tid, direction: "IN", status: "COMPLETE", createdAt: { gte: start, lte: end }, ...(locationId ? { locationId } : {}) },
        include: { paymentMethod: { select: { id: true, name: true } } },
      }),
      prisma.transaction.findMany({
        where: { tenantId: tid, direction: "IN", status: "COMPLETE", createdAt: { gte: trendStart, lte: trendEnd }, ...(locationId ? { locationId } : {}) },
        select: { amount: true, createdAt: true },
      }),
      locationId ? Promise.resolve([]) : prisma.appointment.findMany({ where: { tenantId: tid, paymentStatus: "PAID", updatedAt: { gte: start, lte: end } }, select: { amount: true } }),
      locationId ? Promise.resolve([]) : prisma.membershipPayment.findMany({ where: { tenantId: tid, status: "PAID", createdAt: { gte: start, lte: end } }, select: { amount: true } }),
      prisma.expense.findMany({ where: { tenantId: tid, status: "ACTIVE", expenseDate: { gte: start, lte: end }, ...(locationId ? { locationId } : {}) }, include: { category: { select: { name: true } } } }),
      prisma.goodsReceiptItem.findMany({
        where: { goodsReceipt: { tenantId: tid, receivedAt: { gte: start, lte: end }, ...(locationId ? { locationId } : {}) } },
        select: { quantity: true, unitCost: true, product: { select: { packSize: true } }, goodsReceipt: { select: { purchase: { select: { supplierId: true, supplier: { select: { name: true } } } } } } },
      }),
      prisma.purchase.findMany({ where: { tenantId: tid, status: "CANCELLED", updatedAt: { gte: start, lte: end } }, select: { id: true, total: true } }),
      prisma.supplierPayment.findMany({ where: { tenantId: tid, paidAt: { gte: start, lte: end } }, select: { amount: true } }),
      prisma.customer.findMany({ where: { tenantId: tid, balance: { gt: 0 } }, select: { id: true, firstName: true, lastName: true, balance: true }, orderBy: { balance: "desc" } }),
      prisma.folio.findMany({
        where: { tenantId: tid, status: "OPEN" },
        select: { folioNo: true, lineItems: { select: { amount: true, quantity: true } }, payments: { select: { amount: true } }, reservation: { select: { reservationNo: true, customer: { select: { firstName: true, lastName: true } } } } },
      }),
      prisma.supplier.findMany({ where: { tenantId: tid, balance: { gt: 0 } }, select: { id: true, name: true, balance: true }, orderBy: { balance: "desc" } }),
      prisma.employee.findMany({ where: { tenantId: tid }, select: { id: true, firstName: true, lastName: true, defaultLocation: { select: { name: true } } } }),
    ]);

    // ---- Total Revenue: cash actually received (Transaction ledger is the
    // single source of truth here — it already avoids double-counting a
    // room-billed POS sale at both ring-up and checkout). Appointments and
    // memberships aren't tenant-location-tagged yet, so they're folded in
    // only for the all-locations view. ----
    const posSalesCash = round2(transactionsIn.filter((t) => t.source === "POS_SALE").reduce((s, t) => s + Number(t.amount), 0));
    const folioDepositsCash = round2(transactionsIn.filter((t) => t.source === "FOLIO_DEPOSIT").reduce((s, t) => s + Number(t.amount), 0));
    const folioSettlementsCash = round2(transactionsIn.filter((t) => t.source === "FOLIO_SETTLEMENT").reduce((s, t) => s + Number(t.amount), 0));
    const serviceCenterCash = round2(appointmentsPaid.reduce((s, a) => s + Number(a.amount), 0) + membershipPayments.reduce((s, m) => s + Number(m.amount), 0));
    const totalRevenue = round2(posSalesCash + folioDepositsCash + folioSettlementsCash + serviceCenterCash);

    // ---- Completed orders: the sales-volume + Net Revenue/Profit basis.
    // Deliberately NOT the same base as Total Revenue above — a sale settled
    // on credit is "sold" (counts here) before it's "paid" (counts there).
    // Each figure is labeled for exactly what it is; see the Reports.tsx
    // "how we calculate this" panel. ----
    let completedSalesValue = 0;
    let cogsTotal = 0;
    let unresolvedCostLines = 0;
    let itemsSold = 0;
    let taxCollected = 0;
    let discountsGiven = 0;
    let menuOrdersCompleted = 0;
    const taxBuckets = new Map<string, { key: string; label: string; treatment: string; rate: number; mode: string; net: number; tax: number; gross: number }>();
    const topItemsMap = new Map<string, { name: string; qty: number; revenue: number }>();
    const byLocationMap = new Map<string, { name: string; count: number; revenue: number; cogs: number }>();
    const byCustomerMap = new Map<string, { name: string; count: number; revenue: number }>();
    const compSessions = new Map<string, { id: string; title: string; hostName: string | null; startsAt: Date | null; endsAt: Date | null; complimentaryValue: number; complimentaryCogs: number; guestRevenue: number; guestCogs: number; orders: number }>();
    let complimentaryValue = 0;
    let complimentaryCogs = 0;
    let creditGiven = 0;
    let creditCount = 0;
    let complimentaryCount = 0;

    for (const order of completedOrders) {
      const fin = computeOrderFinancials(order, tax);
      completedSalesValue += fin.total;
      taxCollected += fin.taxAmount;
      discountsGiven += Number(order.discount);
      if (order.channel === "FOOD") menuOrdersCompleted += 1;

      // A completed order can be settled short of its total (the rest parked
      // as customer credit at /settle) — that gap never produces a
      // Transaction row, so it's invisible to the cash-basis breakdown below
      // unless counted here explicitly.
      if (order.saleType !== "COMPLIMENTARY") {
        const paidSoFar = order.payments.reduce((s, p) => s + Number(p.amount), 0);
        const shortfall = round2(fin.total - paidSoFar);
        if (shortfall > 0.01) { creditGiven += shortfall; creditCount += 1; }
      }

      for (const line of fin.taxLines) {
        const bucket = taxBuckets.get(line.key) ?? { ...line, net: 0, tax: 0, gross: 0 };
        bucket.net += line.net; bucket.tax += line.tax; bucket.gross += line.gross;
        taxBuckets.set(line.key, bucket);
      }

      let orderCogs = 0;
      for (const item of order.items) {
        itemsSold += item.quantity;
        const cost = resolveItemCost(item);
        if (cost == null) unresolvedCostLines += 1; else orderCogs += cost;
        const key = item.menuItem?.id ?? item.product?.id ?? item.service?.id ?? "unknown";
        const name = item.menuItem?.name ?? item.product?.name ?? item.service?.name ?? "Unknown";
        const bucket = topItemsMap.get(key) ?? { name, qty: 0, revenue: 0 };
        bucket.qty += item.quantity;
        bucket.revenue += Number(item.unitPrice) * item.quantity;
        topItemsMap.set(key, bucket);
      }
      cogsTotal += orderCogs;
      if (order.saleType === "COMPLIMENTARY") {
        complimentaryValue += fin.complimentaryValue;
        complimentaryCogs += orderCogs;
        complimentaryCount += 1;
      }
      if (order.complimentarySessionId) {
        const session = compSessions.get(order.complimentarySessionId) ?? {
          id: order.complimentarySessionId,
          title: order.complimentarySession?.title ?? "Complimentary session",
          hostName: order.complimentarySession?.hostName ?? null,
          startsAt: order.complimentarySession?.startsAt ?? order.complimentarySession?.eventDate ?? null,
          endsAt: order.complimentarySession?.endsAt ?? null,
          complimentaryValue: 0,
          complimentaryCogs: 0,
          guestRevenue: 0,
          guestCogs: 0,
          orders: 0,
        };
        session.orders += 1;
        if (order.saleType === "COMPLIMENTARY") {
          session.complimentaryValue += fin.complimentaryValue;
          session.complimentaryCogs += orderCogs;
        } else {
          session.guestRevenue += fin.total;
          session.guestCogs += orderCogs;
        }
        compSessions.set(order.complimentarySessionId, session);
      }

      const locKey = order.locationId ?? "unassigned";
      const locBucket = byLocationMap.get(locKey) ?? { name: order.location?.name ?? "Unassigned", count: 0, revenue: 0, cogs: 0 };
      locBucket.count += 1;
      locBucket.revenue += fin.total;
      locBucket.cogs += orderCogs;
      byLocationMap.set(locKey, locBucket);

      const custKey = order.customerId ?? "walk-in";
      const custBucket = byCustomerMap.get(custKey) ?? { name: order.customer ? `${order.customer.firstName} ${order.customer.lastName ?? ""}`.trim() : "Walk-in", count: 0, revenue: 0 };
      custBucket.count += 1;
      custBucket.revenue += fin.total;
      byCustomerMap.set(custKey, custBucket);
    }
    completedSalesValue = round2(completedSalesValue);
    cogsTotal = round2(cogsTotal);
    taxCollected = round2(taxCollected);
    discountsGiven = round2(discountsGiven);
    complimentaryValue = round2(complimentaryValue);
    complimentaryCogs = round2(complimentaryCogs);
    creditGiven = round2(creditGiven);

    const topItems = [...topItemsMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10).map((i) => ({ ...i, revenue: round2(i.revenue) }));
    const taxBreakdown = [...taxBuckets.values()].map((b) => ({ ...b, net: round2(b.net), tax: round2(b.tax), gross: round2(b.gross) })).sort((a, b) => b.gross - a.gross);

    // ---- Expenses ----
    const totalExpenses = round2(expenses.reduce((s, e) => s + Number(e.amount), 0));
    const expensesByCategoryMap = new Map<string, { name: string; count: number; total: number }>();
    const expensesByLocationMap = new Map<string, number>();
    for (const e of expenses) {
      const catBucket = expensesByCategoryMap.get(e.categoryId) ?? { name: e.category.name, count: 0, total: 0 };
      catBucket.count += 1; catBucket.total += Number(e.amount);
      expensesByCategoryMap.set(e.categoryId, catBucket);
      const locKey = e.locationId ?? "unassigned";
      expensesByLocationMap.set(locKey, (expensesByLocationMap.get(locKey) ?? 0) + Number(e.amount));
    }
    const expensesByCategory = [...expensesByCategoryMap.values()].map((b) => ({ ...b, total: round2(b.total) })).sort((a, b) => b.total - a.total);

    // ---- Purchases ----
    const purchasesBySupplierMap = new Map<string, { name: string; count: number; total: number }>();
    for (const gri of goodsReceiptItems) {
      const supplierId = gri.goodsReceipt.purchase.supplierId;
      const bucket = purchasesBySupplierMap.get(supplierId) ?? { name: gri.goodsReceipt.purchase.supplier.name, count: 0, total: 0 };
      bucket.count += 1;
      bucket.total += stockValue(gri.quantity, gri.unitCost, gri.product.packSize) ?? 0;
      purchasesBySupplierMap.set(supplierId, bucket);
    }
    const purchasesBySupplier = [...purchasesBySupplierMap.values()].map((b) => ({ ...b, total: round2(b.total) })).sort((a, b) => b.total - a.total);
    const cancelledPurchasesSummary = { count: cancelledPurchases.length, value: round2(cancelledPurchases.reduce((s, p) => s + Number(p.total), 0)) };
    const capitalInvested = round2(supplierPayments.reduce((s, p) => s + Number(p.amount), 0));

    // ---- Net Revenue / Net Profit ----
    const netRevenue = round2(completedSalesValue - cogsTotal);
    const netProfit = round2(netRevenue - totalExpenses);

    // ---- Cards ----
    const transactionsCount = completedOrders.length;
    const averageSale = transactionsCount ? round2(completedSalesValue / transactionsCount) : 0;

    // ---- Sales by location (net profit + % needs that location's own
    // expenses, not the tenant-wide total) ----
    const salesByLocation = [...byLocationMap.entries()].map(([locId, b]) => {
      const locExpenses = round2(expensesByLocationMap.get(locId) ?? 0);
      const netProfitHere = round2(b.revenue - b.cogs - locExpenses);
      return {
        locationId: locId === "unassigned" ? null : locId,
        name: b.name,
        transactions: b.count,
        revenue: round2(b.revenue),
        avgSale: b.count ? round2(b.revenue / b.count) : 0,
        percentOfTotal: completedSalesValue ? round2((b.revenue / completedSalesValue) * 100) : 0,
        expenses: locExpenses,
        netProfit: netProfitHere,
        profitPercent: b.revenue ? round2((netProfitHere / b.revenue) * 100) : 0,
      };
    }).sort((a, b) => b.revenue - a.revenue);

    // ---- Sales by payment method / by employee (cash-basis, from the
    // Transaction ledger — same set that built Total Revenue above, minus
    // service-center bookings which have no method/employee here) ----
    const transactionsInTotal = round2(transactionsIn.reduce((s, t) => s + Number(t.amount), 0));
    const byMethodMap = new Map<string, { name: string; count: number; total: number }>();
    for (const t of transactionsIn) {
      const key = t.paymentMethodId ?? "unknown";
      const bucket = byMethodMap.get(key) ?? { name: t.paymentMethod?.name ?? "Unknown", count: 0, total: 0 };
      bucket.count += 1; bucket.total += Number(t.amount);
      byMethodMap.set(key, bucket);
    }
    // Credit and complimentary sales never produce a Transaction row (nothing
    // was collected), so without adding them explicitly here they'd be
    // invisible in this breakdown — someone reading it would see cash
    // totals that don't add up to what was actually sold. They're appended
    // as their own rows (only when non-zero, same as any other unused
    // method) and every row's percentOfTotal is against the combined
    // cash + credit + complimentary total, not just cash-in.
    const soldBasisTotal = round2(transactionsInTotal + creditGiven + complimentaryValue);
    const rawMethodRows: { name: string; count: number; total: number }[] = [...byMethodMap.values()];
    if (creditGiven > 0.01) rawMethodRows.push({ name: "Credit", count: creditCount, total: creditGiven });
    if (complimentaryValue > 0.01) rawMethodRows.push({ name: "Complimentary", count: complimentaryCount, total: complimentaryValue });
    const byPaymentMethod = rawMethodRows
      .map((b) => ({ ...b, total: round2(b.total), percentOfTotal: soldBasisTotal ? round2((b.total / soldBasisTotal) * 100) : 0 }))
      .sort((a, b) => b.total - a.total);

    const employeeName = new Map(employeesForBranch.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));
    const employeeBranch = new Map(employeesForBranch.map((e) => [e.id, e.defaultLocation?.name ?? "—"]));
    const byEmployeeMap = new Map<string, { name: string; branch: string; count: number; total: number }>();
    for (const t of transactionsIn) {
      const key = t.employeeId ?? "unattributed";
      const bucket = byEmployeeMap.get(key) ?? {
        name: t.employeeId ? employeeName.get(t.employeeId) ?? "Unknown" : "Unattributed",
        branch: t.employeeId ? employeeBranch.get(t.employeeId) ?? "—" : "—",
        count: 0, total: 0,
      };
      bucket.count += 1; bucket.total += Number(t.amount);
      byEmployeeMap.set(key, bucket);
    }
    const byEmployee = [...byEmployeeMap.values()]
      .map((b) => ({ ...b, total: round2(b.total), percentOfTotal: transactionsInTotal ? round2((b.total / transactionsInTotal) * 100) : 0 }))
      .sort((a, b) => b.total - a.total);

    // ---- Sales by customer — sold-basis like Sales by Location (a credit
    // sale counts here even before it's paid), top 10 by revenue plus a
    // combined tail so the percentages still foot to 100%. ----
    const byCustomerSorted = [...byCustomerMap.values()]
      .map((b) => ({ ...b, revenue: round2(b.revenue), percentOfTotal: completedSalesValue ? round2((b.revenue / completedSalesValue) * 100) : 0 }))
      .sort((a, b) => b.revenue - a.revenue);
    const byCustomer = byCustomerSorted.slice(0, 10);
    if (byCustomerSorted.length > 10) {
      const rest = byCustomerSorted.slice(10);
      byCustomer.push({
        name: `${rest.length} other customer${rest.length === 1 ? "" : "s"}`,
        count: rest.reduce((s, c) => s + c.count, 0),
        revenue: round2(rest.reduce((s, c) => s + c.revenue, 0)),
        percentOfTotal: round2(rest.reduce((s, c) => s + c.percentOfTotal, 0)),
      });
    }

    // ---- Voided sales / (unsupported) returns ----
    const voided = { count: cancelledOrders.length, value: round2(cancelledOrders.reduce((s, o) => s + computeOrderFinancials(o, tax).total, 0)) };
    const returns = { supported: false, count: 0, value: 0, note: "Partial refunds aren't tracked yet — only whole-order voids are." };

    // ---- Revenue trend: 11 days centered on the range's end date ----
    const trendMap = new Map<string, number>();
    for (let d = trendStart; d <= trendEnd; d = addBusinessDays(d, 1)) trendMap.set(businessDayKey(startHour, d), 0);
    for (const t of trendTransactions) trendMap.set(businessDayKey(startHour, t.createdAt), (trendMap.get(businessDayKey(startHour, t.createdAt)) ?? 0) + Number(t.amount));
    const trend = [...trendMap.entries()].map(([trendDate, value]) => ({ date: trendDate, revenue: round2(value) }));

    // ---- Debtors: a live snapshot, not scoped to the selected period —
    // Customer.balance (credit sales) and open Folios (unsettled room bills)
    // are two separate, non-overlapping mechanisms. ----
    const customerDebtTotal = round2(debtorCustomers.reduce((s, c) => s + Number(c.balance), 0));
    const folioBalances = openFolios
      .map((f) => {
        const charges = f.lineItems.reduce((s, li) => s + Number(li.amount) * li.quantity, 0);
        const paid = f.payments.reduce((s, p) => s + Number(p.amount), 0);
        return {
          folioNo: f.folioNo,
          reservationNo: f.reservation.reservationNo,
          guestName: `${f.reservation.customer.firstName} ${f.reservation.customer.lastName ?? ""}`.trim(),
          balance: round2(charges - paid),
        };
      })
      .filter((f) => f.balance > 0.01)
      .sort((a, b) => b.balance - a.balance);
    const folioDebtTotal = round2(folioBalances.reduce((s, f) => s + f.balance, 0));
    const debtors = {
      total: round2(customerDebtTotal + folioDebtTotal),
      customers: { total: customerDebtTotal, top: debtorCustomers.slice(0, 15).map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName ?? ""}`.trim(), balance: round2(Number(c.balance)) })) },
      unsettledFolios: { total: folioDebtTotal, top: folioBalances.slice(0, 15) },
    };

    // ---- Creditors: also a live snapshot ----
    const creditorTotal = round2(creditorSuppliers.reduce((s, sup) => s + Number(sup.balance), 0));
    const creditors = {
      total: creditorTotal,
      top: creditorSuppliers.slice(0, 15).map((s) => ({ id: s.id, name: s.name, balance: round2(Number(s.balance)) })),
    };

    const expectedProfit = round2(netProfit + debtors.total - creditors.total);

    res.json({
      range: { period, start: start.toISOString(), end: end.toISOString() },
      cards: { totalRevenue, netRevenue, totalExpenses, netProfit, capitalInvested, transactions: transactionsCount, averageSale, itemsSold, menuOrdersCompleted },
      revenueBreakdown: {
        posSalesCash, folioDepositsCash, folioSettlementsCash, serviceCenterCash, totalRevenue,
        taxCollected, discountsGiven,
        complimentaryValue, complimentaryCogs,
        creditGiven, creditCount,
        completedSalesValue, cogs: cogsTotal, unresolvedCostLines, netRevenue,
        serviceCenterExcludedByLocationFilter: !!locationId,
      },
      complimentarySessions: [...compSessions.values()].map((s) => ({
        ...s,
        startsAt: s.startsAt?.toISOString() ?? null,
        endsAt: s.endsAt?.toISOString() ?? null,
        complimentaryValue: round2(s.complimentaryValue),
        complimentaryCogs: round2(s.complimentaryCogs),
        guestRevenue: round2(s.guestRevenue),
        guestCogs: round2(s.guestCogs),
        guestProfit: round2(s.guestRevenue - s.guestCogs),
        coverPercent: s.complimentaryCogs > 0 ? round2(((s.guestRevenue - s.guestCogs) / s.complimentaryCogs) * 100) : (s.guestRevenue > 0 ? 100 : 0),
        netImpact: round2(s.guestRevenue - s.guestCogs - s.complimentaryCogs),
      })).sort((a, b) => b.netImpact - a.netImpact),
      topItems,
      expensesByCategory,
      purchasesBySupplier,
      trend,
      salesByLocation,
      byPaymentMethod,
      byEmployee,
      byCustomer,
      voided,
      returns,
      cancelledPurchases: cancelledPurchasesSummary,
      debtors,
      creditors,
      expectedProfit,
      taxBreakdown,
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// Tax Report — VAT collected by treatment/rate, with the highest-taxed items
// under each bucket. Uses the same line-level tax snapshots as receipts.
// ============================================================================

reportsRouter.get("/tax", async (req, res, next) => {
  try {
    const query = salesQuerySchema.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid report filters", details: query.error.flatten() }); return; }
    const { period, date, from, to, locationId } = query.data;
    const tid = tenantId(req);
    const { start, end } = resolveSalesRange(period, date, from, to, await businessDayStartHourFor(tid));

    const [tax, orders] = await Promise.all([
      taxSettingsFor(tid),
      prisma.posOrder.findMany({
        where: { tenantId: tid, status: "COMPLETED", updatedAt: { gte: start, lte: end }, ...(locationId ? { locationId } : {}) },
        include: {
          items: {
            include: {
              addons: { select: { quantity: true, unitPrice: true } },
              menuItem: { select: { id: true, name: true, sku: true, menuCategory: { select: { name: true } } } },
              variant: { select: { id: true, name: true, sku: true } },
              product: { select: { id: true, name: true, sku: true, category: { select: { name: true } } } },
              service: { select: { id: true, name: true, category: { select: { name: true } } } },
            },
          },
        },
      }),
    ]);

    const categories = new Map<string, {
      key: string;
      label: string;
      treatment: string;
      rate: number;
      mode: string;
      lines: number;
      net: number;
      tax: number;
      gross: number;
      items: Map<string, { itemId: string | null; name: string; sku: string | null; category: string | null; quantity: number; net: number; tax: number; gross: number }>;
    }>();

    let net = 0;
    let taxAmount = 0;
    let gross = 0;

    for (const order of orders) {
      const financials = computeOrderFinancials(order, tax);
      net += financials.net;
      taxAmount += financials.taxAmount;
      gross += financials.total;

      for (const line of financials.taxLineItems) {
        const orderItem = order.items[line.index];
        if (!orderItem) continue;
        const itemId = orderItem.variantId ?? orderItem.menuItemId ?? orderItem.productId ?? orderItem.serviceId ?? null;
        const sku = orderItem.variant?.sku ?? orderItem.menuItem?.sku ?? orderItem.product?.sku ?? null;
        const baseName = orderItem.menuItem?.name ?? orderItem.product?.name ?? orderItem.service?.name ?? "Unknown";
        const name = orderItem.variant ? `${baseName} (${orderItem.variant.name})` : baseName;
        const category = orderItem.menuItem?.menuCategory?.name ?? orderItem.product?.category?.name ?? orderItem.service?.category?.name ?? null;

        const bucket = categories.get(line.key) ?? {
          key: line.key,
          label: line.label,
          treatment: line.treatment,
          rate: line.rate,
          mode: line.mode,
          lines: 0,
          net: 0,
          tax: 0,
          gross: 0,
          items: new Map(),
        };
        bucket.lines += 1;
        bucket.net += line.net;
        bucket.tax += line.tax;
        bucket.gross += line.gross;
        const itemKey = `${line.key}|${itemId ?? name}`;
        const itemBucket = bucket.items.get(itemKey) ?? { itemId, name, sku, category, quantity: 0, net: 0, tax: 0, gross: 0 };
        itemBucket.quantity += line.quantity;
        itemBucket.net += line.net;
        itemBucket.tax += line.tax;
        itemBucket.gross += line.gross;
        bucket.items.set(itemKey, itemBucket);
        categories.set(line.key, bucket);
      }
    }

    const breakdown = [...categories.values()]
      .map((category) => ({
        key: category.key,
        label: category.label,
        treatment: category.treatment,
        rate: category.rate,
        mode: category.mode,
        lines: category.lines,
        net: round2(category.net),
        tax: round2(category.tax),
        gross: round2(category.gross),
        topItems: [...category.items.values()]
          .map((item) => ({ ...item, quantity: round2(item.quantity), net: round2(item.net), tax: round2(item.tax), gross: round2(item.gross) }))
          .sort((a, b) => b.tax - a.tax || b.gross - a.gross)
          .slice(0, 10),
      }))
      .sort((a, b) => b.tax - a.tax || b.gross - a.gross);

    res.json({
      range: { period, start: start.toISOString(), end: end.toISOString() },
      summary: { net: round2(net), tax: round2(taxAmount), gross: round2(gross), orders: orders.length, lines: breakdown.reduce((sum, b) => sum + b.lines, 0) },
      breakdown,
      topItems: breakdown
        .flatMap((b) => b.topItems.map((item) => ({ ...item, taxCategory: b.label })))
        .filter((item) => item.tax > 0)
        .sort((a, b) => b.tax - a.tax || b.gross - a.gross)
        .slice(0, 10),
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// Inventory Report — a live (or as-of-date) stock snapshot: what's on hand
// right now, its value by category, and a per-location breakdown. This is
// deliberately a different report from GET /inventory above (which is a
// movement-over-a-period reconstruction) — this one answers "what do we have
// on the shelf today", not "what moved this week".
// ============================================================================

type StockRow = {
  productId: string;
  name: string;
  sku: string | null;
  category: string | null;
  quantity: number;
  unit: string;
  unitCost: number;
  packSize: number | null;
  packLabel: string | null;
  packUnit: { id: string; name: string } | null;
  reorderLevel: number;
};

function summarizeStock(rows: StockRow[]) {
  const inventoryValue = round2(rows.reduce((s, r) => s + (stockValue(r.quantity, r.unitCost, r.packSize) ?? 0), 0));
  const byCategoryMap = new Map<string, { units: number; value: number }>();
  for (const r of rows) {
    const key = r.category ?? "Uncategorized";
    const bucket = byCategoryMap.get(key) ?? { units: 0, value: 0 };
    bucket.units += r.quantity;
    bucket.value += stockValue(r.quantity, r.unitCost, r.packSize) ?? 0;
    byCategoryMap.set(key, bucket);
  }
  const byCategory = [...byCategoryMap.entries()]
    .map(([category, v]) => ({ category, units: v.units, value: round2(v.value), percent: inventoryValue > 0 ? round2((v.value / inventoryValue) * 100) : 0 }))
    .sort((a, b) => b.value - a.value);
  return {
    totalProducts: rows.length,
    totalUnits: rows.reduce((s, r) => s + r.quantity, 0),
    lowStockCount: rows.filter((r) => r.quantity > 0 && r.quantity <= r.reorderLevel).length,
    outOfStockCount: rows.filter((r) => r.quantity === 0).length,
    stockValue: inventoryValue,
    byCategory,
  };
}

reportsRouter.get("/inventory-overview", async (req, res, next) => {
  try {
    const query = z.object({ asOfDate: isoDate.optional(), locationId: z.string().trim().optional() }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid filters", details: query.error.flatten() }); return; }
    const tid = tenantId(req);
    const { asOfDate, locationId } = query.data;
    const mode: "live" | "asOf" = asOfDate && asOfDate !== localIsoToday() ? "asOf" : "live";

    const locations = await prisma.location.findMany({
      where: { tenantId: tid, ...(locationId ? { id: locationId } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });

    // key: `${productId}::${locationId}` -> quantity on hand
    const balances = new Map<string, number>();
    if (mode === "live") {
      const stocks = await prisma.productStock.findMany({
        where: { tenantId: tid, ...(locationId ? { locationId } : {}) },
        select: { productId: true, locationId: true, quantity: true },
      });
      for (const s of stocks) balances.set(`${s.productId}::${s.locationId}`, Number(s.quantity));
    } else {
      const { end } = dayBounds(asOfDate, asOfDate);
      const movements = await prisma.inventoryMovement.findMany({
        where: { tenantId: tid, occurredAt: { lte: end }, ...(locationId ? { locationId } : {}) },
        select: { productId: true, locationId: true, quantity: true },
      });
      for (const m of movements) {
        const key = `${m.productId}::${m.locationId}`;
        balances.set(key, (balances.get(key) ?? 0) + Number(m.quantity));
      }
    }

    // Every active product, not just ones with a stock row anywhere — the
    // per-location breakdown lists all of them so "we don't carry this here"
    // is visible as an explicit zero row, not a silent gap in the table. An
    // inactive product that still has a tracked balance is fetched too (via
    // the OR below) so the overall summary further down never trips over a
    // balance with no matching product.
    const trackedProductIds = new Set([...balances.keys()].map((k) => k.split("::")[0]));
    const allProducts = await prisma.product.findMany({
      where: { tenantId: tid, OR: [{ isActive: true }, { id: { in: [...trackedProductIds] } }] },
      select: { id: true, name: true, sku: true, unit: true, unitCost: true, packSize: true, packLabel: true, packUnit: { select: { id: true, name: true } }, reorderLevel: true, isActive: true, category: { select: { name: true } } },
    });
    const productById = new Map(allProducts.map((p) => [p.id, p]));
    const activeProducts = allProducts.filter((p) => p.isActive);

    const perLocation = locations.map((loc) => {
      const rows: StockRow[] = activeProducts.map((p) => ({
        productId: p.id,
        name: p.name,
        sku: p.sku,
        category: p.category?.name ?? null,
        quantity: balances.get(`${p.id}::${loc.id}`) ?? 0,
        unit: p.unit,
        unitCost: p.unitCost != null ? Number(p.unitCost) : 0,
        packSize: p.packSize == null ? null : Number(p.packSize),
        packLabel: p.packLabel,
        packUnit: p.packUnit,
        reorderLevel: Number(p.reorderLevel),
      }));
      rows.sort((a, b) => a.name.localeCompare(b.name));
      const summary = summarizeStock(rows);
      return { locationId: loc.id, name: loc.name, ...summary, products: rows.map(({ reorderLevel, ...r }) => ({ ...r, value: round2(stockValue(r.quantity, r.unitCost, r.packSize) ?? 0), low: r.quantity > 0 && r.quantity <= reorderLevel, out: r.quantity === 0 })) };
    });

    // Overall: one row per product, quantity summed across every location.
    const overallByProduct = new Map<string, number>();
    for (const [key, quantity] of balances) {
      const productId = key.split("::")[0];
      overallByProduct.set(productId, (overallByProduct.get(productId) ?? 0) + quantity);
    }
    const overallRows: StockRow[] = [...overallByProduct.entries()].map(([productId, quantity]) => {
      const p = productById.get(productId)!;
      return {
        productId,
        name: p.name,
        sku: p.sku,
        category: p.category?.name ?? null,
        quantity,
        unit: p.unit,
        unitCost: p.unitCost != null ? Number(p.unitCost) : 0,
        packSize: p.packSize == null ? null : Number(p.packSize),
        packLabel: p.packLabel,
        packUnit: p.packUnit,
        reorderLevel: Number(p.reorderLevel),
      };
    });

    res.json({ mode, asOfDate: asOfDate ?? localIsoToday(), overall: summarizeStock(overallRows), locations: perLocation });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// Products Report — best sellers and slow movers for a period, by quantity,
// revenue, or profit. The product universe is every active product (so a
// never-sold one still shows up among the slowest movers); "last sold" looks
// across all time, independent of the selected period.
// ============================================================================

reportsRouter.get("/products-overview", async (req, res, next) => {
  try {
    const query = z.object({
      from: isoDate.optional(),
      to: isoDate.optional(),
      locationId: z.string().trim().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid filters", details: query.error.flatten() }); return; }
    const tid = tenantId(req);
    const { locationId, limit } = query.data;
    const { start, end } = dayBounds(query.data.from, query.data.to);

    const [products, completedOrders, lastSoldRows] = await Promise.all([
      prisma.product.findMany({ where: { tenantId: tid, isActive: true }, select: { id: true, name: true, sku: true, category: { select: { name: true } } } }),
      prisma.posOrder.findMany({
        where: { tenantId: tid, status: "COMPLETED", updatedAt: { gte: start, lte: end }, ...(locationId ? { locationId } : {}) },
        select: { items: { where: { productId: { not: null } }, select: { productId: true, quantity: true, unitPrice: true, product: { select: { unitCost: true, packSize: true } } } } },
      }),
      prisma.posOrderItem.groupBy({
        by: ["productId"],
        where: { productId: { not: null }, order: { tenantId: tid, status: "COMPLETED" } },
        _max: { createdAt: true },
      }),
    ]);

    const soldMap = new Map<string, { qty: number; revenue: number; cost: number }>();
    for (const order of completedOrders) {
      for (const item of order.items) {
        if (!item.productId) continue;
        const bucket = soldMap.get(item.productId) ?? { qty: 0, revenue: 0, cost: 0 };
        bucket.qty += item.quantity;
        bucket.revenue += Number(item.unitPrice) * item.quantity;
        bucket.cost += item.product?.unitCost != null ? Number(item.product.unitCost) * item.quantity : 0;
        soldMap.set(item.productId, bucket);
      }
    }
    const lastSoldMap = new Map(lastSoldRows.filter((r) => r.productId).map((r) => [r.productId as string, r._max.createdAt]));

    const rows = products.map((p) => {
      const sold = soldMap.get(p.id) ?? { qty: 0, revenue: 0, cost: 0 };
      const profit = sold.revenue - sold.cost;
      return {
        productId: p.id,
        name: p.name,
        sku: p.sku,
        category: p.category?.name ?? null,
        qty: sold.qty,
        revenue: round2(sold.revenue),
        profit: round2(profit),
        margin: sold.revenue > 0 ? round2((profit / sold.revenue) * 100) : 0,
        lastSoldAt: lastSoldMap.get(p.id)?.toISOString() ?? null,
      };
    });

    res.json({
      range: { from: start.toISOString(), to: end.toISOString() },
      bestSelling: {
        byQuantity: [...rows].sort((a, b) => b.qty - a.qty).slice(0, limit),
        byRevenue: [...rows].sort((a, b) => b.revenue - a.revenue).slice(0, limit),
        byProfit: [...rows].sort((a, b) => b.profit - a.profit).slice(0, limit),
      },
      slowest: [...rows].sort((a, b) => a.qty - b.qty).slice(0, limit),
    });
  } catch (error) {
    next(error);
  }
});
