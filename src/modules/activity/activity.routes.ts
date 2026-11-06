import { Router } from "express";
import type { Prisma, ReservationActivityAction } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requirePermission } from "../../middleware/tenantContext.js";
import { blankToUndefined, localStamp, parseLocalStamp } from "../../lib/dateFilters.js";
import type { ActivityArea } from "../../lib/activity.js";

/**
 * The Activity Log: who did what. Two kinds of rows are merged, newest first:
 *  - ActivityLog entries, written by the action itself from the day it started logging;
 *  - the trail that records already carried before that (who voided a sale, reverted
 *    an order, decided a return, adjusted or counted stock, acted on a stay, cancelled
 *    an invoice, voided a salary, re-reviewed a shift), marked fromRecords.
 * Once an action logs itself, its record source stops at that date (LEGACY_UNTIL) so
 * nothing shows twice.
 */
export const activityRouter = Router();
activityRouter.use(requirePermission("ACTIVITY_VIEW"));

type Row = {
  id: string;
  occurredAt: Date;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  area: ActivityArea;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  summary: string;
  reason: string | null;
  changes: unknown;
  fromRecords: boolean;
};

type Filter = {
  start?: Date;
  end?: Date;
  actorId?: string;
  area?: string;
  search?: string;
  target?: { type: string; id: string };
};

const money = (value: unknown) => `KSh ${Number(value).toLocaleString("en-KE", { maximumFractionDigits: 2 })}`;
const fullName = (e?: { firstName: string; lastName: string | null } | null) => (e ? `${e.firstName} ${e.lastName ?? ""}`.trim() : null);
const insensitive = (value: string) => ({ contains: value, mode: "insensitive" as const });
const orderNumberOf = (search?: string) => (search && /^#?\d+$/.test(search) ? Number(search.replace("#", "")) : undefined);

/** A source's time window: the filter's, capped where the action started logging itself. */
function window(f: Filter, until?: Date): Prisma.DateTimeFilter | undefined {
  const lte = until && (!f.end || until < f.end) ? until : f.end;
  return f.start || lte ? { ...(f.start ? { gte: f.start } : {}), ...(lte ? { lte } : {}) } : undefined;
}

// Set a source's date here when the action it covers starts writing ActivityLog.
const LEGACY_UNTIL: Partial<Record<string, Date>> = {};

const SENSITIVE_STAY_ACTIONS: ReservationActivityAction[] = ["UPDATED", "CANCELLED", "NO_SHOW", "EXTENDED", "CHARGE_REMOVED", "GUEST_REMOVED", "ROOM_TERMS_CHANGED", "ROOM_CHARGE_CHANGED", "ROOM_CHANGED"];

type Source = { key: string; area: ActivityArea; targetTypes?: string[]; load: (tid: string, f: Filter, take: number) => Promise<Row[]> };

const row = (r: Omit<Row, "actorName" | "actorRole" | "changes" | "fromRecords"> & Partial<Pick<Row, "actorName" | "changes">>): Row => ({ actorName: null, actorRole: null, changes: null, fromRecords: true, ...r });

const sources: Source[] = [
  {
    key: "posCancel", area: "POS", targetTypes: ["PosOrder"],
    load: async (tid, f, take) => {
      const orders = await prisma.posOrder.findMany({
        where: {
          tenantId: tid, status: "CANCELLED", cancelDecidedAt: window(f, LEGACY_UNTIL.posCancel) ?? { not: null },
          ...(f.actorId ? { cancelDecidedBy: f.actorId } : {}),
          ...(f.target ? { id: f.target.id } : {}),
          ...(f.search ? { orderNumber: orderNumberOf(f.search) ?? -1 } : {}),
        },
        select: { id: true, orderNumber: true, statusBeforeCancel: true, cancelReason: true, cancelDecidedAt: true, cancelDecidedBy: true, cancelRequestedBy: true, location: { select: { name: true } } },
        orderBy: { cancelDecidedAt: "desc" }, take,
      });
      return orders.map((o) => {
        const voided = o.statusBeforeCancel === "COMPLETED";
        return row({
          id: `posCancel:${o.id}`, occurredAt: o.cancelDecidedAt!, actorId: o.cancelDecidedBy, area: "POS",
          action: voided ? "pos.order.void" : "pos.order.cancel",
          targetType: "PosOrder", targetId: o.id, targetLabel: `Order #${o.orderNumber}`,
          // A store rejecting the kitchen's request cancels the order by itself (dispatch.routes.ts).
          summary: o.cancelReason?.startsWith("Rejected by store")
            ? `Rejected the store request for Order #${o.orderNumber}${o.location ? ` at ${o.location.name}` : ""}, which cancelled it`
            : `${voided ? "Voided the completed sale" : "Approved cancelling"} Order #${o.orderNumber}${o.location ? ` at ${o.location.name}` : ""}`,
          reason: o.cancelReason,
        });
      });
    },
  },
  {
    key: "posRevert", area: "POS", targetTypes: [],
    load: async (tid, f, take) => {
      const reverts = await prisma.posOrderRevert.findMany({
        where: {
          tenantId: tid, ...(window(f, LEGACY_UNTIL.posRevert) ? { revertedAt: window(f, LEGACY_UNTIL.posRevert) } : {}),
          ...(f.actorId ? { revertedById: f.actorId } : {}),
          ...(f.search ? { orderNumber: orderNumberOf(f.search) ?? -1 } : {}),
        },
        orderBy: { revertedAt: "desc" }, take,
      });
      return reverts.map((r) => row({
        id: `posRevert:${r.id}`, occurredAt: r.revertedAt, actorId: r.revertedById, actorName: r.revertedByName, area: "POS", action: "pos.order.revert",
        targetType: null, targetId: null, targetLabel: `Order #${r.orderNumber}`,
        summary: `Reverted Order #${r.orderNumber} (${money(r.total)})${r.locationName ? ` at ${r.locationName}` : ""}${r.createdByName && r.createdByName !== r.revertedByName ? `, rung up by ${r.createdByName}` : ""} - the order was removed`,
        reason: null,
      }));
    },
  },
  {
    key: "posReturn", area: "POS", targetTypes: ["PosOrder"],
    load: async (tid, f, take) => {
      const decided = await prisma.posOrderReturnRequest.findMany({
        where: {
          tenantId: tid, status: { in: ["APPROVED", "REJECTED"] }, decidedAt: window(f, LEGACY_UNTIL.posReturn) ?? { not: null },
          ...(f.actorId ? { decidedBy: f.actorId } : {}),
          ...(f.target ? { orderId: f.target.id } : {}),
          ...(f.search ? { order: { orderNumber: orderNumberOf(f.search) ?? -1 } } : {}),
        },
        select: { id: true, status: true, quantity: true, reason: true, decisionNote: true, decidedAt: true, decidedBy: true, orderId: true, order: { select: { orderNumber: true } }, orderItem: { select: { menuItem: { select: { name: true } }, product: { select: { name: true } }, service: { select: { name: true } } } } },
        orderBy: { decidedAt: "desc" }, take,
      });
      return decided.map((r) => {
        const item = r.orderItem.menuItem?.name ?? r.orderItem.product?.name ?? r.orderItem.service?.name ?? "item";
        return row({
          id: `posReturn:${r.id}`, occurredAt: r.decidedAt!, actorId: r.decidedBy, area: "POS", action: r.status === "APPROVED" ? "pos.return.approve" : "pos.return.reject",
          targetType: "PosOrder", targetId: r.orderId, targetLabel: `Order #${r.order.orderNumber}`,
          summary: `${r.status === "APPROVED" ? "Approved" : "Rejected"} returning ${r.quantity} x ${item} on Order #${r.order.orderNumber}`,
          reason: [r.reason, r.decisionNote].filter(Boolean).join(" - ") || null,
        });
      });
    },
  },
  {
    key: "stock", area: "STOCK", targetTypes: ["Product"],
    load: async (tid, f, take) => {
      const movements = await prisma.inventoryMovement.findMany({
        where: {
          tenantId: tid,
          // What a person did to stock by hand; sales, transfers and deliveries carry their own documents.
          OR: [{ sourceType: { in: ["MANUAL", "STOCK_COUNT", "STOCK_TAKE"] } }, { type: { in: ["DAMAGE_LOSS", "ADJUSTMENT"] } }],
          ...(window(f, LEGACY_UNTIL.stock) ? { createdAt: window(f, LEGACY_UNTIL.stock) } : {}),
          ...(f.actorId ? { performedBy: f.actorId } : {}),
          ...(f.target ? { productId: f.target.id } : {}),
          ...(f.search ? { product: { name: insensitive(f.search) } } : {}),
        },
        select: { id: true, type: true, quantity: true, balanceBefore: true, balanceAfter: true, note: true, sourceType: true, createdAt: true, performedBy: true, productId: true, product: { select: { name: true } }, location: { select: { name: true } } },
        orderBy: { createdAt: "desc" }, take,
      });
      const what: Record<string, string> = { STOCK_TAKE: "Stock take", STOCK_COUNT: "Stock count", DAMAGE_LOSS: "Recorded a loss", ADJUSTMENT: "Adjusted stock", OPENING_STOCK: "Opening stock", PURCHASE: "Added stock", RETURN: "Returned stock" };
      return movements.map((m) => {
        const qty = Number(m.quantity);
        return row({
          id: `stock:${m.id}`, occurredAt: m.createdAt, actorId: m.performedBy, area: "STOCK", action: `stock.${(m.sourceType === "STOCK_TAKE" || m.sourceType === "STOCK_COUNT" ? m.sourceType : m.type).toLowerCase()}`,
          targetType: "Product", targetId: m.productId, targetLabel: m.product.name,
          summary: `${what[m.sourceType ?? ""] ?? what[m.type] ?? "Changed stock"}: ${m.product.name} ${qty > 0 ? "+" : ""}${qty.toLocaleString("en-KE")} at ${m.location.name} (${Number(m.balanceBefore).toLocaleString("en-KE")} to ${Number(m.balanceAfter).toLocaleString("en-KE")})`,
          reason: m.note,
        });
      });
    },
  },
  {
    key: "stays", area: "STAYS", targetTypes: ["Reservation"],
    load: async (tid, f, take) => {
      const events = await prisma.reservationActivity.findMany({
        where: {
          tenantId: tid, ...(window(f, LEGACY_UNTIL.stays) ? { occurredAt: window(f, LEGACY_UNTIL.stays) } : {}),
          ...(f.actorId ? { performedBy: f.actorId } : {}),
          // A stay's own History shows everything; the log shows only changes to someone's booking or bill,
          // not the routine desk work (booking, checking in, taking a deposit) whose author is plain.
          ...(f.target ? { reservationId: f.target.id } : { action: { in: SENSITIVE_STAY_ACTIONS } }),
          ...(f.search ? { OR: [{ reservation: { reservationNo: insensitive(f.search) } }, { summary: insensitive(f.search) }] } : {}),
        },
        select: { id: true, action: true, summary: true, occurredAt: true, performedBy: true, reservationId: true, reservation: { select: { reservationNo: true } } },
        orderBy: { occurredAt: "desc" }, take,
      });
      return events.map((e) => row({
        id: `stays:${e.id}`, occurredAt: e.occurredAt, actorId: e.performedBy, area: "STAYS", action: `stay.${e.action.toLowerCase()}`,
        targetType: "Reservation", targetId: e.reservationId, targetLabel: e.reservation.reservationNo,
        summary: `${e.reservation.reservationNo}: ${e.summary}`, reason: null,
      }));
    },
  },
  {
    key: "documents", area: "DOCUMENTS", targetTypes: ["CommercialDocument"],
    load: async (tid, f, take) => {
      const docs = await prisma.commercialDocument.findMany({
        where: {
          tenantId: tid, cancelledAt: window(f, LEGACY_UNTIL.documents) ?? { not: null },
          ...(f.actorId ? { cancelledBy: f.actorId } : {}),
          ...(f.target ? { id: f.target.id } : {}),
          ...(f.search ? { documentNo: insensitive(f.search) } : {}),
        },
        select: { id: true, documentNo: true, type: true, total: true, cancelledAt: true, cancelledBy: true, cancelledByName: true, cancelReason: true },
        orderBy: { cancelledAt: "desc" }, take,
      });
      return docs.map((d) => row({
        id: `documents:${d.id}`, occurredAt: d.cancelledAt!, actorId: d.cancelledBy, actorName: d.cancelledByName, area: "DOCUMENTS", action: `${d.type === "INVOICE" ? "invoice" : "quotation"}.cancel`,
        targetType: "CommercialDocument", targetId: d.id, targetLabel: d.documentNo,
        summary: `Cancelled ${d.type === "INVOICE" ? "invoice" : "quotation"} ${d.documentNo} (${money(d.total)})`, reason: d.cancelReason,
      }));
    },
  },
  {
    key: "salaryVoid", area: "PAYROLL", targetTypes: ["EmployeeSalary"],
    load: async (tid, f, take) => {
      const voided = await prisma.employeeSalary.findMany({
        where: {
          tenantId: tid, voidedBy: f.actorId ?? { not: null }, ...(window(f, LEGACY_UNTIL.salaryVoid) ? { updatedAt: window(f, LEGACY_UNTIL.salaryVoid) } : {}),
          ...(f.search ? { employee: { OR: [{ firstName: insensitive(f.search) }, { lastName: insensitive(f.search) }] } } : {}),
        },
        select: { id: true, voidedBy: true, voidReason: true, updatedAt: true, netPay: true, employee: { select: { firstName: true, lastName: true } } },
        orderBy: { updatedAt: "desc" }, take,
      });
      return voided.map((s) => row({
        id: `salaryVoid:${s.id}`, occurredAt: s.updatedAt, actorId: s.voidedBy, area: "PAYROLL", action: "salary.void",
        targetType: "EmployeeSalary", targetId: s.id, targetLabel: fullName(s.employee),
        summary: `Voided the salary of ${fullName(s.employee)} (${money(s.netPay)} net)`, reason: s.voidReason,
      }));
    },
  },
  {
    key: "shiftReview", area: "SHIFTS", targetTypes: [],
    load: async (tid, f, take) => {
      const reviewed = await prisma.shiftSession.findMany({
        where: {
          tenantId: tid, reviewedAt: window(f, LEGACY_UNTIL.shiftReview) ?? { not: null },
          ...(f.actorId ? { reviewedBy: f.actorId } : {}),
          ...(f.search ? { employee: { OR: [{ firstName: insensitive(f.search) }, { lastName: insensitive(f.search) }] } } : {}),
        },
        select: { id: true, status: true, reviewedAt: true, reviewedBy: true, reviewReason: true, employee: { select: { firstName: true, lastName: true } } },
        orderBy: { reviewedAt: "desc" }, take,
      });
      return reviewed.map((s) => row({
        id: `shiftReview:${s.id}`, occurredAt: s.reviewedAt!, actorId: s.reviewedBy, area: "SHIFTS", action: "shift.review",
        targetType: null, targetId: null, targetLabel: fullName(s.employee),
        summary: `Re-reviewed the shift of ${fullName(s.employee)} (now ${s.status.toLowerCase().replaceAll("_", " ")})`, reason: s.reviewReason,
      }));
    },
  },
];

async function loggedRows(tid: string, f: Filter, take: number): Promise<Row[]> {
  const entries = await prisma.activityLog.findMany({
    where: {
      tenantId: tid,
      ...(window(f) ? { occurredAt: window(f) } : {}),
      ...(f.actorId ? { actorId: f.actorId } : {}),
      ...(f.area ? { area: f.area } : {}),
      ...(f.target ? { targetType: f.target.type, targetId: f.target.id } : {}),
      ...(f.search ? { OR: [{ summary: insensitive(f.search) }, { targetLabel: insensitive(f.search) }, { actorName: insensitive(f.search) }, { reason: insensitive(f.search) }] } : {}),
    },
    orderBy: { occurredAt: "desc" }, take,
  });
  return entries.map((e) => ({ ...e, area: e.area as ActivityArea, fromRecords: false }));
}

export const listQuery = z.object({
  from: localStamp,
  to: localStamp,
  actorId: z.preprocess(blankToUndefined, z.string().trim().max(40).optional()),
  area: z.preprocess(blankToUndefined, z.string().trim().max(30).optional()),
  search: z.preprocess(blankToUndefined, z.string().trim().max(80).optional()),
  targetType: z.preprocess(blankToUndefined, z.string().trim().max(40).optional()),
  targetId: z.preprocess(blankToUndefined, z.string().trim().max(40).optional()),
  page: z.coerce.number().int().min(1).max(200).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});

/** One page of the merged feed, newest first. */
export async function activityFeed(tid: string, q: z.infer<typeof listQuery>) {
  const f: Filter = {
    start: q.from ? parseLocalStamp(q.from, false) : undefined,
    end: q.to ? parseLocalStamp(q.to, true) : undefined,
    actorId: q.actorId,
    area: q.area,
    search: q.search,
    target: q.targetType && q.targetId ? { type: q.targetType, id: q.targetId } : undefined,
  };
  // Enough of every source to fill this page; the merged list says whether there's more.
  const take = q.page * q.pageSize + 1;
  const active = sources.filter((s) => (!f.area || s.area === f.area) && (!f.target || s.targetTypes?.includes(f.target.type)));
  const batches = await Promise.all([loggedRows(tid, f, take), ...active.map((s) => s.load(tid, f, take))]);
  // An action that now logs itself still marks its record too (a void sets cancelDecidedBy, a cancelled
  // invoice keeps cancelledBy): show it once, as the logged entry, which carries more.
  const logged = batches[0];
  const alsoLogged = (r: Row) => r.fromRecords && r.targetId != null && logged.some((e) => e.targetId === r.targetId && Math.abs(e.occurredAt.getTime() - r.occurredAt.getTime()) < 10_000);
  const merged = batches.flat().filter((r) => !alsoLogged(r)).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  const pageRows = merged.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);

  // Names (and roles) for rows that only carry an employee id.
  const ids = [...new Set(pageRows.filter((r) => r.actorId && !r.actorRole).map((r) => r.actorId!))];
  const people = ids.length ? await prisma.employee.findMany({ where: { tenantId: tid, id: { in: ids } }, select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } } }) : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const entries = pageRows.map((r) => {
    const person = r.actorId ? byId.get(r.actorId) : undefined;
    return { ...r, actorName: r.actorName ?? fullName(person) ?? (r.actorId ? "Removed employee" : "System"), actorRole: r.actorRole ?? person?.role?.name ?? null };
  });
  return { entries, page: q.page, pageSize: q.pageSize, hasMore: merged.length > q.page * q.pageSize };
}

activityRouter.get("/", async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid filters", details: parsed.error.flatten() }); return; }
  res.json(await activityFeed(req.tenantId!, parsed.data));
});
