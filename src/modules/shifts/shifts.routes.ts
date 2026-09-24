import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule, requirePermission } from "../../middleware/tenantContext.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { resolveShiftFor, isWithinShift } from "../../lib/shifts.js";
import { computeOrderFinancials, type TaxSettings } from "../../lib/orderTotals.js";

export const shiftsRouter = Router();
shiftsRouter.use(requireModule("HR"));

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

// Must match the POS "Active Orders" meaning. Pending cancellations are
// already out of the waiter's hands and live in the Cancelled/Awaiting
// approval queue, so they should not block end-shift handover.
const ACTIVE_ORDER_STATUSES = ["OPEN", "PREPARING", "READY", "SERVED"] as const;
const shiftInclude = {
  employee: { select: { id: true, firstName: true, lastName: true, jobTitle: true, supervisorId: true, isSupervisor: true } },
  startApprover: { select: { id: true, firstName: true, lastName: true } },
  endApprover: { select: { id: true, firstName: true, lastName: true } },
} as const;

const noteSchema = z.object({ note: z.string().trim().max(300).optional() });
const approvalSchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(300).optional(),
});
// End-shift review is where a cash handover actually happens — start
// requests never touch money, so this input is end-approval only.
const endApprovalSchema = approvalSchema.extend({
  cashVariance: z.coerce.number().min(-1_000_000).max(1_000_000).optional(),
  varianceNote: z.string().trim().max(500).optional(),
});
// A non-zero variance is a claim that something is wrong — it needs an
// explanation on the record. Zero/absent means the shift is simply cleared.
const varianceNeedsNote = (v: { cashVariance?: number; varianceNote?: string }) =>
  Math.abs(v.cashVariance ?? 0) < 0.005 || Boolean(v.varianceNote);
const VARIANCE_NOTE_ERROR = "Add a note explaining the discrepancy";

const localDate = (date: Date) => new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));

async function currentEmployee(tid: string, userId: string | undefined) {
  if (!userId) throw Object.assign(new Error("Sign in required"), { status: 401 });
  const employee = await prisma.employee.findFirst({
    where: { id: userId, tenantId: tid, status: "ACTIVE" },
    select: { id: true, firstName: true, lastName: true, supervisorId: true, isSupervisor: true, role: { select: { name: true } } },
  });
  if (!employee) throw Object.assign(new Error("Sign in required"), { status: 401 });
  return employee;
}

function isSuperAdmin(employee: { role: { name: string } | null }) {
  return employee.role?.name === "Super Admin";
}

async function assertCanApprove(tid: string, approverId: string | undefined, target: { employeeId: string; employee: { supervisorId: string | null; isSupervisor: boolean } }) {
  const approver = await currentEmployee(tid, approverId);
  if (isSuperAdmin(approver) || target.employee.supervisorId === approver.id || (target.employeeId === approver.id && approver.isSupervisor)) return approver;
  throw Object.assign(new Error("Only this employee's supervisor can approve this shift"), { status: 403 });
}

// Looser than assertCanApprove: read-only access to a shift's detail also
// covers the employee looking at their own past shift, not just supervisors.
async function assertCanView(tid: string, actorId: string | undefined, target: { employeeId: string; employee: { supervisorId: string | null; isSupervisor: boolean } }) {
  const actor = await currentEmployee(tid, actorId);
  if (isSuperAdmin(actor) || target.employee.supervisorId === actor.id || target.employeeId === actor.id) return actor;
  throw Object.assign(new Error("You cannot view this employee's shift"), { status: 403 });
}

async function shiftSummary(tid: string, employeeId: string, from: Date, to: Date) {
  const [tax, transactions, orders, folioLines, folioCredits, pending] = await Promise.all([
    prisma.businessProfile.findUnique({ where: { tenantId: tid }, select: { taxRate: true, taxMode: true, taxTreatment: true } }),
    prisma.transaction.findMany({
      where: {
        tenantId: tid,
        employeeId,
        status: "COMPLETE",
        createdAt: { gte: from, lte: to },
        NOT: { direction: "OUT", source: { in: ["POS_SALE", "FOLIO_DEPOSIT", "FOLIO_SETTLEMENT"] } },
      },
      include: { paymentMethod: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.posOrder.findMany({
      where: { tenantId: tid, createdBy: employeeId, status: { notIn: ["CANCELLED", "PENDING_CANCELLATION"] }, createdAt: { gte: from, lte: to } },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paymentStatus: true,
        saleType: true,
        complimentaryOrderRole: true,
        complimentaryRecipientName: true,
        discount: true,
        createdAt: true,
        updatedAt: true,
        payments: { include: { paymentMethod: { select: { name: true } } } },
        items: { select: { quantity: true, unitPrice: true, taxRate: true, taxMode: true, taxTreatment: true, addons: { select: { quantity: true, unitPrice: true } } } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.folioLineItem.findMany({
      where: { tenantId: tid, createdBy: employeeId, source: { not: "POS_ORDER" }, createdAt: { gte: from, lte: to }, folio: { reservation: { status: { notIn: ["CANCELLED", "NO_SHOW"] } } } },
      select: {
        id: true,
        source: true,
        label: true,
        amount: true,
        quantity: true,
        taxRate: true,
        taxMode: true,
        taxTreatment: true,
        createdAt: true,
        folio: {
          select: {
            folioNo: true,
            reservation: {
              select: {
                reservationNo: true,
                customer: { select: { firstName: true, lastName: true } },
                room: { select: { number: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.customerCreditEntry.findMany({
      where: { tenantId: tid, createdBy: employeeId, type: "CREDIT", folioId: { not: null }, createdAt: { gte: from, lte: to } },
      select: { amount: true },
    }),
    prisma.posOrder.count({ where: { tenantId: tid, createdBy: employeeId, status: { in: [...ACTIVE_ORDER_STATUSES] } } }),
  ]);
  const byPaymentMethod = new Map<string, { paymentMethodId: string | null; name: string; total: number; count: number }>();
  const incomingTransactions = transactions.filter((t) => t.direction === "IN" && t.status === "COMPLETE");
  for (const t of incomingTransactions) {
    const key = t.paymentMethodId ?? "unknown";
    const bucket = byPaymentMethod.get(key) ?? { paymentMethodId: t.paymentMethodId, name: t.paymentMethod?.name ?? "Unknown", total: 0, count: 0 };
    bucket.total += Number(t.amount);
    bucket.count += 1;
    byPaymentMethod.set(key, bucket);
  }
  const taxSettings = tax as TaxSettings;
  const sales = orders.map((o) => {
    const fin = computeOrderFinancials({
      discount: o.discount,
      saleType: o.saleType,
      items: o.items.map((item) => ({
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        addons: item.addons,
        taxRate: item.taxRate,
        taxMode: item.taxMode,
        taxTreatment: item.taxTreatment,
      })),
    }, taxSettings);
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      paymentStatus: o.paymentStatus,
      saleType: o.saleType,
      complimentaryOrderRole: o.complimentaryOrderRole,
      complimentaryRecipientName: o.complimentaryRecipientName,
      createdAt: o.createdAt,
      total: fin.total,
      complimentaryValue: fin.complimentaryValue,
      paid: o.payments.reduce((s, p) => s + Number(p.amount), 0),
    };
  });
  const folioFinancials = computeOrderFinancials({
    discount: 0,
    items: folioLines.map((line) => ({
      quantity: Number(line.quantity),
      unitPrice: line.amount,
      addons: [],
      taxRate: line.taxRate,
      taxMode: line.taxMode,
      taxTreatment: line.taxTreatment,
    })),
  }, taxSettings);
  const folioLineSales = folioLines.map((line, index) => {
    const customer = line.folio.reservation.customer;
    const gross = folioFinancials.taxLineItems.find((item) => item.index === index)?.gross ?? Number(line.amount) * Number(line.quantity);
    return {
      id: line.id,
      kind: "FOLIO" as const,
      label: line.label,
      source: line.source,
      reservationNo: line.folio.reservation.reservationNo,
      folioNo: line.folio.folioNo,
      roomNumber: line.folio.reservation.room.number,
      guestName: `${customer.firstName} ${customer.lastName ?? ""}`.trim(),
      createdAt: line.createdAt,
      total: gross,
      paid: 0,
    };
  });
  const folioSales = [...folioLineSales.reduce((map, line) => {
    const key = line.folioNo;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...line, id: key, source: "ROOM", total: line.total, label: line.source === "ROOM" ? line.label : `Room ${line.roomNumber}` });
    } else {
      existing.total += line.total;
      if (line.source === "ROOM") existing.label = line.label;
      if (line.createdAt < existing.createdAt) existing.createdAt = line.createdAt;
    }
    return map;
  }, new Map<string, typeof folioLineSales[number]>()).values()].filter((line) => line.total > 0.01);
  const totalSales = sales.reduce((s, o) => s + o.total, 0) + folioLineSales.reduce((s, line) => s + line.total, 0);
  const totalPaid = incomingTransactions.reduce((s, t) => s + Number(t.amount), 0);
  const complimentarySales = sales.filter((o) => o.saleType === "COMPLIMENTARY");
  const complimentaryTotal = complimentarySales.reduce((s, o) => s + o.complimentaryValue, 0);
  const creditOrders = sales.filter((o) => o.saleType !== "COMPLIMENTARY" && o.total - o.paid > 0.01);
  const folioCreditSales = folioCredits.reduce((s, entry) => s + Number(entry.amount), 0);
  const creditSales = creditOrders.reduce((s, o) => s + (o.total - o.paid), 0) + folioCreditSales;
  // Credit and complimentary sales never post a Transaction (nothing was
  // collected), so they'd otherwise be invisible here — appended as their
  // own rows only when non-zero, same as any other unused payment method.
  const byPaymentMethodRows = [...byPaymentMethod.values()];
  if (creditSales > 0.01) byPaymentMethodRows.push({ paymentMethodId: null, name: "Credit", total: creditSales, count: creditOrders.length });
  if (complimentaryTotal > 0.01) byPaymentMethodRows.push({ paymentMethodId: null, name: "Complimentary", total: complimentaryTotal, count: complimentarySales.length });
  return {
    from,
    to,
    hours: Math.max(0, (to.getTime() - from.getTime()) / 36e5),
    totalSales,
    totalPaid,
    complimentaryTotal,
    complimentaryCount: complimentarySales.length,
    creditSales,
    pendingOrders: pending,
    byPaymentMethod: byPaymentMethodRows,
    transactions: transactions.map((t) => ({
      id: t.id,
      transactionNo: t.transactionNo,
      direction: t.direction,
      source: t.source,
      amount: Number(t.amount),
      paymentMethod: t.paymentMethod?.name ?? null,
      reference: t.reference,
      description: t.description,
      createdAt: t.createdAt,
    })),
    sales: [
      ...sales.map((sale) => ({ ...sale, kind: "POS_ORDER" as const })),
      ...folioSales,
    ],
  };
}

async function safeShiftSummary(tid: string, employeeId: string, from: Date, to: Date) {
  try {
    return await shiftSummary(tid, employeeId, from, to);
  } catch (error) {
    console.error("Could not build shift summary", { tenantId: tid, employeeId, from, to, error });
    return null;
  }
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:mm, e.g. 06:00");

const templateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  startTime: hhmm,
  endTime: hhmm,
  graceMinutesBefore: z.coerce.number().int().min(0).max(180).default(15),
  graceMinutesAfter: z.coerce.number().int().min(0).max(180).default(15),
  isActive: z.boolean().default(true),
});
const updateTemplateSchema = partialNoDefaults(templateSchema);

shiftsRouter.get("/current", async (req, res, next) => {
  const tid = tenantId(req);
  try {
    const employee = await currentEmployee(tid, req.userId);
    const session = await prisma.shiftSession.findFirst({
      where: { tenantId: tid, employeeId: employee.id, status: { in: ["REQUESTED_START", "ACTIVE", "REQUESTED_END"] } },
      include: shiftInclude,
      orderBy: { requestedStartAt: "desc" },
    });
    const summary = session?.approvedStartAt ? await shiftSummary(tid, employee.id, session.approvedStartAt, session.requestedEndAt ?? new Date()) : null;
    res.json({ serverNow: new Date(), user: employee, session, summary });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

shiftsRouter.get("/approvals", async (req, res, next) => {
  const tid = tenantId(req);
  try {
    const actor = await currentEmployee(tid, req.userId);
    const sessions = await prisma.shiftSession.findMany({
      where: {
        tenantId: tid,
        status: { in: ["REQUESTED_START", "REQUESTED_END"] },
        ...(isSuperAdmin(actor) ? {} : { employee: { supervisorId: actor.id } }),
      },
      include: shiftInclude,
      orderBy: { updatedAt: "asc" },
    });
    const enriched = await Promise.all(sessions.map(async (s) => ({
      ...s,
      summary: s.approvedStartAt ? await safeShiftSummary(tid, s.employeeId, s.approvedStartAt, s.requestedEndAt ?? new Date()) : null,
    })));
    res.json({ sessions: enriched });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

shiftsRouter.get("/active-supervised", async (req, res, next) => {
  const tid = tenantId(req);
  try {
    const actor = await currentEmployee(tid, req.userId);
    const sessions = await prisma.shiftSession.findMany({
      where: {
        tenantId: tid,
        status: "ACTIVE",
        employeeId: { not: actor.id },
        ...(isSuperAdmin(actor) ? {} : { employee: { supervisorId: actor.id } }),
      },
      include: shiftInclude,
      orderBy: { approvedStartAt: "asc" },
    });
    const enriched = await Promise.all(sessions.map(async (s) => ({
      ...s,
      summary: s.approvedStartAt ? await safeShiftSummary(tid, s.employeeId, s.approvedStartAt, new Date()) : null,
    })));
    res.json({ sessions: enriched });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

shiftsRouter.get("/history", async (req, res, next) => {
  const tid = tenantId(req);
  try {
    const employee = await currentEmployee(tid, req.userId);
    if (isSuperAdmin(employee)) { res.json({ sessions: [] }); return; }
    const sessions = await prisma.shiftSession.findMany({
      where: { tenantId: tid, employeeId: employee.id, status: "ENDED", approvedStartAt: { not: null }, approvedEndAt: { not: null } },
      include: shiftInclude,
      orderBy: { approvedStartAt: "desc" },
      take: 32,
    });
    const enriched = await Promise.all(sessions.map(async (s) => ({
      ...s,
      summary: s.approvedStartAt && s.approvedEndAt ? await safeShiftSummary(tid, s.employeeId, s.approvedStartAt, s.approvedEndAt) : null,
    })));
    res.json({ sessions: enriched });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

shiftsRouter.post("/start-request", async (req, res, next) => {
  const tid = tenantId(req);
  const data = noteSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid shift request", details: data.error.flatten() }); return; }
  try {
    const employee = await currentEmployee(tid, req.userId);
    if (isSuperAdmin(employee)) { res.status(400).json({ error: "Super Admin does not need a shift session" }); return; }
    const existing = await prisma.shiftSession.findFirst({ where: { tenantId: tid, employeeId: employee.id, status: { in: ["REQUESTED_START", "ACTIVE", "REQUESTED_END"] } } });
    if (existing) { res.status(409).json({ error: "You already have an open shift request or active shift" }); return; }
    const now = new Date();
    const autoApprove = employee.isSupervisor;
    const session = await prisma.shiftSession.create({
      data: {
        tenantId: tid,
        employeeId: employee.id,
        status: autoApprove ? "ACTIVE" : "REQUESTED_START",
        startNote: data.data.note,
        ...(autoApprove ? { approvedStartAt: now, startApprovedBy: employee.id } : {}),
      },
      include: shiftInclude,
    });
    res.status(201).json({ session });
  } catch (error) {
    // Belt-and-suspenders for the findFirst-then-create race above (a slow
    // connection double-tapping this before either request's create
    // commits) — the partial unique index on ShiftSession rejects the
    // second INSERT outright; report it the same as the check above would.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      res.status(409).json({ error: "You already have an open shift request or active shift" });
      return;
    }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

shiftsRouter.post("/:id/start-approval", async (req, res, next) => {
  const tid = tenantId(req);
  const data = approvalSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid approval", details: data.error.flatten() }); return; }
  try {
    const session = await prisma.shiftSession.findFirst({ where: { id: req.params.id, tenantId: tid, status: "REQUESTED_START" }, include: shiftInclude });
    if (!session) { res.status(404).json({ error: "Start request not found" }); return; }
    const approver = await assertCanApprove(tid, req.userId, session);
    const updated = await prisma.shiftSession.update({
      where: { id: session.id },
      data: data.data.action === "APPROVE"
        ? { status: "ACTIVE", approvedStartAt: new Date(), startApprovedBy: approver.id, rejectionReason: null }
        : { status: "REJECTED_START", rejectionReason: data.data.note ?? null },
      include: shiftInclude,
    });
    res.json({ session: updated });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

shiftsRouter.post("/end-request", async (req, res, next) => {
  const tid = tenantId(req);
  const data = noteSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid shift request", details: data.error.flatten() }); return; }
  try {
    const employee = await currentEmployee(tid, req.userId);
    const pendingOrders = await prisma.posOrder.count({ where: { tenantId: tid, createdBy: employee.id, status: { in: [...ACTIVE_ORDER_STATUSES] } } });
    if (pendingOrders > 0) { res.status(409).json({ error: `${pendingOrders} active sale${pendingOrders === 1 ? "" : "s"} must be completed first.` }); return; }
    const session = await prisma.shiftSession.findFirst({ where: { tenantId: tid, employeeId: employee.id, status: "ACTIVE" }, include: shiftInclude, orderBy: { approvedStartAt: "desc" } });
    if (!session?.approvedStartAt) { res.status(404).json({ error: "No active shift found" }); return; }
    const now = new Date();
    const autoApprove = employee.isSupervisor;
    const updated = await prisma.shiftSession.update({
      where: { id: session.id },
      data: {
        status: autoApprove ? "ENDED" : "REQUESTED_END",
        requestedEndAt: now,
        endNote: data.data.note,
        ...(autoApprove ? { approvedEndAt: now, endApprovedBy: employee.id } : {}),
      },
      include: shiftInclude,
    });
    if (autoApprove) {
      await prisma.attendanceRecord.upsert({
        where: { employeeId_date: { employeeId: employee.id, date: localDate(session.approvedStartAt) } },
        create: { tenantId: tid, employeeId: employee.id, date: localDate(session.approvedStartAt), status: "PRESENT", notes: "Marked automatically from approved shift.", markedBy: employee.id },
        update: { status: "PRESENT", notes: "Marked automatically from approved shift.", markedBy: employee.id },
      });
    }
    res.json({ session: updated, summary: await shiftSummary(tid, employee.id, session.approvedStartAt, now) });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

shiftsRouter.post("/:id/end-approval", async (req, res, next) => {
  const tid = tenantId(req);
  const data = endApprovalSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid approval", details: data.error.flatten() }); return; }
  try {
    const session = await prisma.shiftSession.findFirst({ where: { id: req.params.id, tenantId: tid, status: "REQUESTED_END" }, include: shiftInclude });
    if (!session?.approvedStartAt || !session.requestedEndAt) { res.status(404).json({ error: "End request not found" }); return; }
    const approver = await assertCanApprove(tid, req.userId, session);
    const summary = await shiftSummary(tid, session.employeeId, session.approvedStartAt, session.requestedEndAt);
    if (summary.pendingOrders > 0) { res.status(409).json({ error: "This employee still has pending sales" }); return; }
    if (!varianceNeedsNote(data.data)) { res.status(400).json({ error: VARIANCE_NOTE_ERROR }); return; }
    const flagged = Math.abs(data.data.cashVariance ?? 0) >= 0.005;
    // Cleared = nothing wrong: no variance, no note stored.
    const cashVariance = flagged ? data.data.cashVariance ?? null : null;
    const varianceNote = flagged ? data.data.varianceNote ?? null : null;
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.shiftSession.update({
        where: { id: session.id },
        data: data.data.action === "APPROVE"
          ? { status: "ENDED", approvedEndAt: new Date(), endApprovedBy: approver.id, rejectionReason: null, cashVariance, varianceNote }
          : { status: "REJECTED_END", rejectionReason: data.data.note ?? null, cashVariance, varianceNote },
        include: shiftInclude,
      });
      if (data.data.action === "APPROVE") {
        await tx.attendanceRecord.upsert({
          where: { employeeId_date: { employeeId: session.employeeId, date: localDate(session.approvedStartAt!) } },
          create: { tenantId: tid, employeeId: session.employeeId, date: localDate(session.approvedStartAt!), status: "PRESENT", notes: "Marked automatically from approved shift.", markedBy: approver.id },
          update: { status: "PRESENT", notes: "Marked automatically from approved shift.", markedBy: approver.id },
        });
      }
      return row;
    });
    res.json({ session: updated, summary });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

// A supervisor / Super Admin closing someone's shift outright — for staff who
// forgot (or can't) request their own end. Skips the handover request step
// but keeps the same rule that active sales must be settled first.
shiftsRouter.post("/:id/force-end", async (req, res, next) => {
  const tid = tenantId(req);
  const data = noteSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid request", details: data.error.flatten() }); return; }
  try {
    const session = await prisma.shiftSession.findFirst({ where: { id: req.params.id, tenantId: tid, status: { in: ["ACTIVE", "REQUESTED_END"] } }, include: shiftInclude });
    if (!session?.approvedStartAt) { res.status(404).json({ error: "No active shift found" }); return; }
    const approver = await assertCanApprove(tid, req.userId, session);
    if (session.employeeId === approver.id) { res.status(400).json({ error: "Use End shift on your own shift card" }); return; }
    const pendingOrders = await prisma.posOrder.count({ where: { tenantId: tid, createdBy: session.employeeId, status: { in: [...ACTIVE_ORDER_STATUSES] } } });
    if (pendingOrders > 0) { res.status(409).json({ error: `${pendingOrders} active sale${pendingOrders === 1 ? "" : "s"} must be completed first.` }); return; }
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.shiftSession.update({
        where: { id: session.id },
        data: {
          status: "ENDED",
          requestedEndAt: session.requestedEndAt ?? now,
          approvedEndAt: now,
          endApprovedBy: approver.id,
          endNote: data.data.note ?? "Ended by supervisor",
          rejectionReason: null,
        },
        include: shiftInclude,
      });
      await tx.attendanceRecord.upsert({
        where: { employeeId_date: { employeeId: session.employeeId, date: localDate(session.approvedStartAt!) } },
        create: { tenantId: tid, employeeId: session.employeeId, date: localDate(session.approvedStartAt!), status: "PRESENT", notes: "Marked automatically from approved shift.", markedBy: approver.id },
        update: { status: "PRESENT", notes: "Marked automatically from approved shift.", markedBy: approver.id },
      });
      return row;
    });
    res.json({ session: updated, summary: await shiftSummary(tid, session.employeeId, session.approvedStartAt, now) });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

// Edit the outcome of a shift that was already decided (cleared or
// rejected): flip the status, and record/replace the cash discrepancy. Needs
// SHIFT_REVIEW rather than being the employee's supervisor — this is the HR /
// payroll correction path, not the live handover.
const reviewSchema = z.object({
  status: z.enum(["ENDED", "REJECTED_END"]),
  reason: z.string().trim().min(3, "Give a reason for the change").max(500),
  cashVariance: z.coerce.number().min(-1_000_000).max(1_000_000).optional(),
  varianceNote: z.string().trim().max(500).optional(),
});

shiftsRouter.patch("/:id/review", requirePermission("SHIFT_REVIEW"), async (req, res, next) => {
  const tid = tenantId(req);
  const data = reviewSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: data.error.issues[0]?.message ?? "Invalid review", details: data.error.flatten() }); return; }
  try {
    const session = await prisma.shiftSession.findFirst({ where: { id: req.params.id as string, tenantId: tid, status: { in: ["ENDED", "REJECTED_END"] } }, include: shiftInclude });
    if (!session) { res.status(404).json({ error: "Only a cleared or rejected shift can be reviewed" }); return; }
    if (!varianceNeedsNote(data.data)) { res.status(400).json({ error: VARIANCE_NOTE_ERROR }); return; }
    const flagged = Math.abs(data.data.cashVariance ?? 0) >= 0.005;
    const now = new Date();
    const cleared = data.data.status === "ENDED";
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.shiftSession.update({
        where: { id: session.id },
        data: {
          status: data.data.status,
          // A shift that becomes cleared needs an end time to report against.
          ...(cleared ? { approvedEndAt: session.approvedEndAt ?? session.requestedEndAt ?? now, endApprovedBy: req.userId ?? null, rejectionReason: null } : { rejectionReason: data.data.reason }),
          cashVariance: flagged ? data.data.cashVariance ?? null : null,
          varianceNote: flagged ? data.data.varianceNote ?? null : null,
          reviewedBy: req.userId ?? null,
          reviewedAt: now,
          reviewReason: data.data.reason,
        },
        include: shiftInclude,
      });
      if (cleared && session.approvedStartAt) {
        await tx.attendanceRecord.upsert({
          where: { employeeId_date: { employeeId: session.employeeId, date: localDate(session.approvedStartAt) } },
          create: { tenantId: tid, employeeId: session.employeeId, date: localDate(session.approvedStartAt), status: "PRESENT", notes: "Marked automatically from approved shift.", markedBy: req.userId },
          update: {},
        });
      }
      return row;
    });
    res.json({ session: updated });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

const shiftStatusEnum = z.enum(["REQUESTED_START", "ACTIVE", "REQUESTED_END", "ENDED", "REJECTED_START", "REJECTED_END"]);
const sessionsQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  employeeId: z.string().trim().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  // Accepts one value (?status=ENDED), several as repeated keys
  // (?status=ENDED&status=REJECTED_END), or a comma-separated list — the
  // dashboard's "recent shifts" list needs ended AND rejected together.
  status: z.preprocess(
    (value) => (typeof value === "string" && value.includes(",") ? value.split(",") : value),
    z.union([shiftStatusEnum, z.array(shiftStatusEnum)]),
  ).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
  // The dashboard's recent list shows sales/collected per row — opt-in so
  // long report-style lists don't pay for it.
  withSummary: z.enum(["true", "false"]).optional(),
});

shiftsRouter.get("/sessions", async (req, res, next) => {
  const query = sessionsQuerySchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid filters", details: query.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const actor = await currentEmployee(tid, req.userId);
    const from = query.data.from ?? (query.data.year && query.data.month ? new Date(Date.UTC(query.data.year, query.data.month - 1, 1)) : undefined);
    const to = query.data.to ?? (query.data.year && query.data.month ? new Date(Date.UTC(query.data.month === 12 ? query.data.year + 1 : query.data.year, query.data.month === 12 ? 0 : query.data.month, 1)) : undefined);
    const employeeFilter = query.data.employeeId ? { employeeId: query.data.employeeId } : {};
    const supervisorFilter = isSuperAdmin(actor) ? {} : { employee: { supervisorId: actor.id } };
    const sessions = await prisma.shiftSession.findMany({
      where: {
        tenantId: tid,
        ...employeeFilter,
        ...supervisorFilter,
        ...(query.data.status ? { status: Array.isArray(query.data.status) ? { in: query.data.status } : query.data.status } : {}),
        ...(from || to ? { requestedStartAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
      },
      include: shiftInclude,
      orderBy: { requestedStartAt: "desc" },
      ...(query.data.take ? { take: query.data.take } : {}),
    });
    if (query.data.withSummary === "true") {
      const enriched = await Promise.all(sessions.map(async (s) => {
        const end = s.approvedEndAt ?? s.requestedEndAt;
        return { ...s, summary: s.approvedStartAt && end ? await safeShiftSummary(tid, s.employeeId, s.approvedStartAt, end) : null };
      }));
      res.json({ sessions: enriched });
      return;
    }
    res.json({ sessions });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

/** On-demand summary for one shift — used by "click a shift to see what
 * this employee did" in the dashboard's recent/active-staff lists, where
 * eagerly computing every session's summary (like /approvals and
 * /active-supervised do for their naturally small lists) would be wasteful
 * for a longer history list. */
shiftsRouter.get("/:id/summary", async (req, res, next) => {
  const tid = tenantId(req);
  try {
    const session = await prisma.shiftSession.findFirst({ where: { id: req.params.id, tenantId: tid }, include: shiftInclude });
    if (!session) { res.status(404).json({ error: "Shift not found" }); return; }
    await assertCanView(tid, req.userId, session);
    if (!session.approvedStartAt) { res.json({ session, summary: null }); return; }
    const summary = await shiftSummary(tid, session.employeeId, session.approvedStartAt, session.approvedEndAt ?? session.requestedEndAt ?? new Date());
    res.json({ session, summary });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

const reportQuerySchema = z.object({ from: z.coerce.date(), to: z.coerce.date() });

shiftsRouter.get("/employees/:employeeId/report", async (req, res, next) => {
  const query = reportQuerySchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Choose report dates", details: query.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const actor = await currentEmployee(tid, req.userId);
    const employee = await prisma.employee.findFirst({ where: { id: req.params.employeeId, tenantId: tid }, select: { id: true, firstName: true, lastName: true, jobTitle: true, supervisorId: true } });
    if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
    const canView = isSuperAdmin(actor) || actor.role?.name === "Accountant" || employee.supervisorId === actor.id || employee.id === actor.id;
    if (!canView) { res.status(403).json({ error: "You cannot view this employee report" }); return; }
    // Rejected shifts belong in this report too — an accountant reviewing a
    // month needs to see what got rejected and why, not just what cleared.
    // requestedStartAt (always set) anchors the date range instead of
    // approvedStartAt/approvedEndAt, which a rejected session may lack.
    const sessions = await prisma.shiftSession.findMany({
      where: {
        tenantId: tid,
        employeeId: employee.id,
        status: { in: ["ENDED", "REJECTED_START", "REJECTED_END"] },
        requestedStartAt: { gte: query.data.from, lte: query.data.to },
      },
      include: shiftInclude,
      orderBy: { requestedStartAt: "asc" },
    });
    const summaries = await Promise.all(sessions.map((s) => (
      s.approvedStartAt ? shiftSummary(tid, employee.id, s.approvedStartAt, s.approvedEndAt ?? s.requestedEndAt ?? new Date()) : null
    )));
    res.json({
      employee,
      from: query.data.from,
      to: query.data.to,
      totals: {
        shifts: sessions.filter((s) => s.status === "ENDED").length,
        rejected: sessions.filter((s) => s.status !== "ENDED").length,
        hours: summaries.reduce((sum, s) => sum + (s?.hours ?? 0), 0),
        sales: summaries.reduce((sum, s) => sum + (s?.totalSales ?? 0), 0),
        paid: summaries.reduce((sum, s) => sum + (s?.totalPaid ?? 0), 0),
        creditSales: summaries.reduce((sum, s) => sum + (s?.creditSales ?? 0), 0),
      },
      sessions: sessions.map((session, index) => ({ ...session, summary: summaries[index] })),
    });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

shiftsRouter.get("/templates", async (req, res) => {
  const templates = await prisma.shiftTemplate.findMany({ where: { tenantId: tenantId(req) }, orderBy: { name: "asc" } });
  res.json({ templates });
});

/** Every employee's configured rotation, for the management list — an
 * employee with none simply doesn't appear here (unrestricted). */
shiftsRouter.get("/rotations", async (req, res) => {
  const rotations = await prisma.employeeShiftRotation.findMany({
    where: { tenantId: tenantId(req) },
    include: {
      employee: { select: { id: true, firstName: true, lastName: true, jobTitle: true } },
      slots: { include: { shiftTemplate: true }, orderBy: { position: "asc" } },
    },
  });
  res.json({ rotations });
});

shiftsRouter.post("/templates", requirePermission("SHIFT_MANAGE"), async (req, res, next) => {
  const data = templateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid shift", details: data.error.flatten() }); return; }
  try {
    const template = await prisma.shiftTemplate.create({ data: { tenantId: tenantId(req), ...data.data } });
    res.status(201).json({ template });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A shift with this name already exists" }); return; }
    next(error);
  }
});

shiftsRouter.patch("/templates/:id", requirePermission("SHIFT_MANAGE"), async (req, res, next) => {
  const data = updateTemplateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid shift", details: data.error.flatten() }); return; }
  try {
    const id = req.params.id as string;
    const updated = await prisma.shiftTemplate.updateMany({ where: { id, tenantId: tenantId(req) }, data: data.data });
    if (!updated.count) { res.status(404).json({ error: "Shift not found" }); return; }
    const template = await prisma.shiftTemplate.findUniqueOrThrow({ where: { id } });
    res.json({ template });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A shift with this name already exists" }); return; }
    next(error);
  }
});

shiftsRouter.delete("/templates/:id", requirePermission("SHIFT_MANAGE"), async (req, res) => {
  const tid = tenantId(req);
  const existing = await prisma.shiftTemplate.findFirst({ where: { id: req.params.id as string, tenantId: tid } });
  if (!existing) { res.status(404).json({ error: "Shift not found" }); return; }
  const inUse = await prisma.rotationSlot.findFirst({ where: { shiftTemplateId: existing.id } });
  if (inUse) { res.status(409).json({ error: "This shift is assigned to at least one employee's rotation — remove it from their rotation first" }); return; }
  await prisma.shiftTemplate.delete({ where: { id: existing.id } });
  res.status(204).send();
});

const slotSchema = z.object({ shiftTemplateId: z.string().trim().min(1), days: z.coerce.number().int().min(1).max(90) });
const rotationSchema = z.object({
  anchorDate: z.coerce.date(),
  slots: z.array(slotSchema).min(1).max(20),
});

/** An employee's rotation, resolved for display: config plus what shift
 * applies right now (null = unrestricted, no rotation configured). */
shiftsRouter.get("/employees/:employeeId/rotation", async (req, res) => {
  const tid = tenantId(req);
  const employee = await prisma.employee.findFirst({ where: { id: req.params.employeeId as string, tenantId: tid }, select: { id: true } });
  if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
  const rotation = await prisma.employeeShiftRotation.findUnique({
    where: { employeeId: employee.id },
    include: { slots: { include: { shiftTemplate: true }, orderBy: { position: "asc" } } },
  });
  const currentShift = await resolveShiftFor(tid, employee.id);
  res.json({ rotation, currentShift, currentlyClockedIn: currentShift ? isWithinShift(currentShift) : null });
});

/** Replaces the employee's whole rotation in one call — rotations are edited
 * as a unit (change the pattern, not one slot at a time). */
shiftsRouter.put("/employees/:employeeId/rotation", requirePermission("SHIFT_MANAGE"), async (req, res, next) => {
  const tid = tenantId(req);
  const employee = await prisma.employee.findFirst({ where: { id: req.params.employeeId as string, tenantId: tid }, select: { id: true } });
  if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
  const data = rotationSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid rotation", details: data.error.flatten() }); return; }
  const templateIds = data.data.slots.map((s) => s.shiftTemplateId);
  const validTemplates = await prisma.shiftTemplate.count({ where: { id: { in: templateIds }, tenantId: tid } });
  if (validTemplates !== new Set(templateIds).size) { res.status(400).json({ error: "One or more shifts in this rotation were not found" }); return; }

  try {
    const cycleLengthDays = data.data.slots.reduce((sum, s) => sum + s.days, 0);
    let position = 0;
    const slotRows = data.data.slots.map((s) => {
      const row = { shiftTemplateId: s.shiftTemplateId, position, days: s.days };
      position += s.days;
      return row;
    });
    const rotation = await prisma.$transaction(async (tx) => {
      await tx.employeeShiftRotation.upsert({
        where: { employeeId: employee.id },
        create: { tenantId: tid, employeeId: employee.id, anchorDate: data.data.anchorDate, cycleLengthDays },
        update: { anchorDate: data.data.anchorDate, cycleLengthDays },
      });
      const current = await tx.employeeShiftRotation.findUniqueOrThrow({ where: { employeeId: employee.id } });
      await tx.rotationSlot.deleteMany({ where: { rotationId: current.id } });
      await tx.rotationSlot.createMany({ data: slotRows.map((row) => ({ ...row, rotationId: current.id })) });
      return tx.employeeShiftRotation.findUniqueOrThrow({
        where: { id: current.id },
        include: { slots: { include: { shiftTemplate: true }, orderBy: { position: "asc" } } },
      });
    });
    res.json({ rotation });
  } catch (error) {
    next(error);
  }
});

shiftsRouter.delete("/employees/:employeeId/rotation", requirePermission("SHIFT_MANAGE"), async (req, res) => {
  const tid = tenantId(req);
  const employee = await prisma.employee.findFirst({ where: { id: req.params.employeeId as string, tenantId: tid }, select: { id: true } });
  if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
  await prisma.employeeShiftRotation.deleteMany({ where: { employeeId: employee.id } });
  res.status(204).send();
});

const overrideSchema = z.object({ date: z.coerce.date(), shiftTemplateId: z.string().trim().min(1).nullable(), reason: z.string().trim().max(200).optional() });

/** Sets (or clears, with shiftTemplateId: null) a one-day exception to the
 * employee's computed rotation, without disturbing the rotation itself. */
shiftsRouter.put("/employees/:employeeId/overrides", requirePermission("SHIFT_MANAGE"), async (req, res, next) => {
  const tid = tenantId(req);
  const employee = await prisma.employee.findFirst({ where: { id: req.params.employeeId as string, tenantId: tid }, select: { id: true } });
  if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
  const data = overrideSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid override", details: data.error.flatten() }); return; }
  if (data.data.shiftTemplateId) {
    const ok = await prisma.shiftTemplate.findFirst({ where: { id: data.data.shiftTemplateId, tenantId: tid }, select: { id: true } });
    if (!ok) { res.status(400).json({ error: "Shift not found" }); return; }
  }
  try {
    const override = await prisma.employeeShiftOverride.upsert({
      where: { employeeId_date: { employeeId: employee.id, date: data.data.date } },
      create: { tenantId: tid, employeeId: employee.id, date: data.data.date, shiftTemplateId: data.data.shiftTemplateId, reason: data.data.reason },
      update: { shiftTemplateId: data.data.shiftTemplateId, reason: data.data.reason },
      include: { shiftTemplate: true },
    });
    res.json({ override });
  } catch (error) {
    next(error);
  }
});
