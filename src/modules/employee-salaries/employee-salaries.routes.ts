import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { nextPayslipNo, nextTransactionNo } from "../../lib/sequence.js";
import { nairobiParts } from "../../lib/shifts.js";
import { requirePermission } from "../../middleware/tenantContext.js";

export const employeeSalariesRouter = Router();

const salaryStatuses = ["DRAFT", "COMPLETE", "VOIDED"] as const;
const itemTypes = ["ALLOWANCE", "DEDUCTION"] as const;
const paymentMethods = ["BANK_TRANSFER", "MPESA", "CASH", "CHEQUE", "CARD"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalDate = z.preprocess(blankToUndefined, z.coerce.date().optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());

const salaryLineSchema = z.object({
  // Present when the line already exists on the draft — lets a save update
  // it in place (keeping its link to the shift/salary that produced it)
  // instead of deleting and re-creating it.
  id: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).max(120),
  amount: z.coerce.number().min(0),
});

const listSchema = z.object({
  search: optionalText(120),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  from: optionalDate,
  to: optionalDate,
  employeeId: optionalId,
  locationId: optionalId,
  status: z.enum(salaryStatuses).optional(),
});

const advanceSchema = z.object({
  employeeId: z.string().trim().min(1),
  payPeriod: z.coerce.date(),
  deductions: z.array(salaryLineSchema).min(1),
  notes: optionalText(500),
});

const processSchema = z.object({
  employeeId: z.string().trim().min(1),
  payPeriod: z.coerce.date(),
  basicSalary: z.coerce.number().min(0),
  allowances: z.array(salaryLineSchema).default([]),
  deductions: z.array(salaryLineSchema).default([]),
  paymentMethod: z.enum(paymentMethods).optional(),
  reference: optionalText(120),
  notes: optionalText(500),
  complete: z.boolean().default(false),
  carryOverDeductions: z.boolean().default(false),
});

const completeSchema = z.object({
  paymentMethod: z.enum(paymentMethods),
  reference: optionalText(120),
  notes: optionalText(500),
  carryOverDeductions: z.boolean().default(false),
});

const fromShiftSchema = z.object({
  shiftSessionId: z.string().trim().min(1),
  type: z.enum(itemTypes),
  amount: z.coerce.number().positive(),
  label: optionalText(120),
  // Defaults to the month the shift was worked in.
  payPeriod: z.preprocess(blankToUndefined, z.coerce.date().optional()),
});

const itemSchema = z.object({
  type: z.enum(itemTypes),
  label: z.string().trim().min(1).max(120),
  amount: z.coerce.number().min(0),
});

const voidSchema = z.object({ reason: z.string().trim().min(1).max(500) });

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const salaryInclude = {
  employee: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeCode: true,
      salaryAmount: true,
      salaryType: true,
      paymentMethod: true,
      department: { select: { id: true, name: true } },
      defaultLocation: { select: { id: true, name: true } },
      locations: { select: { id: true, name: true } },
    },
  },
  createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
  voidedByEmployee: { select: { id: true, firstName: true, lastName: true } },
  items: { orderBy: { createdAt: "asc" as const } },
} as const;

function monthStart(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function toMoney(value: number) {
  return new Prisma.Decimal(value.toFixed(2));
}

async function assertEmployee(tid: string, employeeId: string) {
  const employee = await prisma.employee.findFirst({ where: { id: employeeId, tenantId: tid }, select: { id: true, firstName: true, lastName: true } });
  if (!employee) throw Object.assign(new Error("Employee not found"), { status: 400 });
  return employee;
}

async function recalculateSalary(tx: Prisma.TransactionClient, salaryId: string) {
  const salary = await tx.employeeSalary.findUniqueOrThrow({ where: { id: salaryId }, include: { items: true } });
  const totalAllowances = salary.items.filter((item) => item.type === "ALLOWANCE").reduce((sum, item) => sum + Number(item.amount), 0);
  // Deductions carried to next month were never taken from this one.
  const totalDeductions = salary.items.filter((item) => item.type === "DEDUCTION").reduce((sum, item) => sum + Number(item.amount), 0) - Number(salary.carriedOverAmount);
  const basicSalary = Number(salary.basicSalary);
  const grossPay = basicSalary + totalAllowances;
  const netPay = grossPay - totalDeductions;
  return tx.employeeSalary.update({
    where: { id: salaryId },
    data: {
      totalAllowances: toMoney(totalAllowances),
      totalDeductions: toMoney(totalDeductions),
      grossPay: toMoney(grossPay),
      netPay: toMoney(netPay),
    },
    include: salaryInclude,
  });
}

async function createSalaryPayment(tx: Prisma.TransactionClient, tid: string, salaryId: string, transactionNo: string, by: string | undefined) {
  const salary = await tx.employeeSalary.findUniqueOrThrow({ where: { id: salaryId }, include: { employee: true } });
  // Everything was absorbed by carried-over deductions: nothing to pay out
  // this month, and no cash movement to record.
  if (Number(salary.netPay) <= 0 && Number(salary.carriedOverAmount) > 0) return;
  if (Number(salary.netPay) <= 0) throw Object.assign(new Error("Net pay must be above zero before completing salary"), { status: 400 });
  const existing = await tx.transaction.findFirst({ where: { tenantId: tid, source: "SALARY_PAYMENT", sourceRefId: salaryId }, select: { id: true } });
  if (existing) return;
  await tx.transaction.create({
    data: {
      tenantId: tid,
      transactionNo,
      direction: "OUT",
      source: "SALARY_PAYMENT",
      amount: salary.netPay,
      reference: salary.reference,
      employeeId: by,
      description: `Salary payment ${salary.payslipNo} - ${salary.employee.firstName} ${salary.employee.lastName}`,
      sourceRefId: salary.id,
    },
  });
}

async function getOrCreateDraft(tx: Prisma.TransactionClient, tid: string, employeeId: string, payPeriod: Date, payslipNo: string, by: string | undefined) {
  const existing = await tx.employeeSalary.findUnique({
    where: { tenantId_employeeId_payPeriod: { tenantId: tid, employeeId, payPeriod } },
    select: { id: true, status: true },
  });
  if (existing) {
    if (existing.status !== "DRAFT") throw Object.assign(new Error("This month's salary is already closed"), { status: 409 });
    return existing;
  }
  return tx.employeeSalary.create({
    data: { tenantId: tid, payslipNo, employeeId, payPeriod, createdBy: by },
    select: { id: true, status: true },
  });
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Completing a salary whose deductions exceed its gross pay would leave a
 * negative net. Without carryOver that's refused with a machine-readable
 * DEDUCTIONS_EXCEED so the UI can ask; with it, the excess is moved onto
 * next month's draft (created if needed) as a "[Month] carry over
 * deductions" line, and this month nets to zero. */
async function settleExcessDeductions(tx: Prisma.TransactionClient, tid: string, salaryId: string, carryOver: boolean, by: string | undefined) {
  const salary = await tx.employeeSalary.findUniqueOrThrow({ where: { id: salaryId }, include: { items: true } });
  const gross = Number(salary.basicSalary) + salary.items.filter((i) => i.type === "ALLOWANCE").reduce((sum, i) => sum + Number(i.amount), 0);
  const deductions = salary.items.filter((i) => i.type === "DEDUCTION").reduce((sum, i) => sum + Number(i.amount), 0);
  const excess = round2(deductions - gross);
  if (excess <= 0.004) return;
  if (!carryOver) {
    throw Object.assign(new Error("Deductions exceed basic salary"), { status: 409, code: "DEDUCTIONS_EXCEED", excess, gross: round2(gross), deductions: round2(deductions) });
  }
  const next = new Date(Date.UTC(salary.payPeriod.getUTCFullYear(), salary.payPeriod.getUTCMonth() + 1, 1));
  const existingNext = await tx.employeeSalary.findUnique({ where: { tenantId_employeeId_payPeriod: { tenantId: tid, employeeId: salary.employeeId, payPeriod: next } }, select: { id: true } });
  const draft = await getOrCreateDraft(tx, tid, salary.employeeId, next, existingNext ? "" : await nextPayslipNo(tid), by);
  await tx.employeeSalaryItem.create({
    data: { salaryId: draft.id, type: "DEDUCTION", label: `${MONTH_NAMES[salary.payPeriod.getUTCMonth()]} carry over deductions`, amount: toMoney(excess), carriedFromSalaryId: salary.id },
  });
  await recalculateSalary(tx, draft.id);
  await tx.employeeSalary.update({ where: { id: salary.id }, data: { carriedOverAmount: toMoney(excess) } });
  await recalculateSalary(tx, salary.id);
}

function sendSalaryError(res: import("express").Response, error: unknown) {
  if (!(error instanceof Error) || !("status" in error)) return false;
  const { status, code, excess, gross, deductions } = error as Error & { status: number; code?: string; excess?: number; gross?: number; deductions?: number };
  res.status(status).json({ error: error.message, ...(code ? { code, excess, gross, deductions } : {}) });
  return true;
}

employeeSalariesRouter.get("/", async (req, res) => {
  const query = listSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid salary filters", details: query.error.flatten() }); return; }
  const { search, year, from, to, employeeId, locationId, status } = query.data;
  const tid = tenantId(req);
  const start = from ?? (year ? new Date(Date.UTC(year, 0, 1)) : undefined);
  const end = to ?? (year ? new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)) : undefined);
  const where: Prisma.EmployeeSalaryWhereInput = {
    tenantId: tid,
    ...(employeeId ? { employeeId } : {}),
    ...(status ? { status } : {}),
    ...(start || end ? { payPeriod: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } } : {}),
    ...(locationId ? { employee: { OR: [{ defaultLocationId: locationId }, { locations: { some: { id: locationId } } }] } } : {}),
    ...(search
      ? {
          OR: [
            { payslipNo: { contains: search, mode: "insensitive" } },
            { employee: { firstName: { contains: search, mode: "insensitive" } } },
            { employee: { lastName: { contains: search, mode: "insensitive" } } },
            { employee: { employeeCode: { contains: search, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [salaries, aggregate] = await Promise.all([
    prisma.employeeSalary.findMany({ where, include: salaryInclude, orderBy: [{ payPeriod: "desc" }, { createdAt: "desc" }] }),
    prisma.employeeSalary.groupBy({ by: ["status"], where, _sum: { netPay: true, totalDeductions: true, totalAllowances: true }, _count: true }),
  ]);
  res.json({
    salaries,
    summary: {
      count: aggregate.reduce((sum, row) => sum + row._count, 0),
      netPay: aggregate.reduce((sum, row) => sum + Number(row._sum.netPay ?? 0), 0),
      allowances: aggregate.reduce((sum, row) => sum + Number(row._sum.totalAllowances ?? 0), 0),
      deductions: aggregate.reduce((sum, row) => sum + Number(row._sum.totalDeductions ?? 0), 0),
      byStatus: aggregate.map((row) => ({ status: row.status, count: row._count, netPay: Number(row._sum.netPay ?? 0) })),
    },
  });
});

employeeSalariesRouter.get("/:id", async (req, res) => {
  const salary = await prisma.employeeSalary.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: salaryInclude });
  if (!salary) { res.status(404).json({ error: "Salary record not found" }); return; }
  res.json({ salary });
});

employeeSalariesRouter.post("/advance", async (req, res, next) => {
  const data = advanceSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid salary advance", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const payPeriod = monthStart(data.data.payPeriod);
  try {
    await assertEmployee(tid, data.data.employeeId);
    const payslipNo = await nextPayslipNo(tid);
    const salary = await prisma.$transaction(async (tx) => {
      const draft = await getOrCreateDraft(tx, tid, data.data.employeeId, payPeriod, payslipNo, req.userId);
      await tx.employeeSalary.update({ where: { id: draft.id }, data: { ...(data.data.notes ? { notes: data.data.notes } : {}) } });
      await tx.employeeSalaryItem.createMany({
        data: data.data.deductions.map((item) => ({ salaryId: draft.id, type: "DEDUCTION", label: item.label, amount: toMoney(item.amount) })),
      });
      return recalculateSalary(tx, draft.id);
    });
    res.status(201).json({ salary });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

employeeSalariesRouter.post("/process", async (req, res, next) => {
  const data = processSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid salary", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const payPeriod = monthStart(data.data.payPeriod);
  try {
    await assertEmployee(tid, data.data.employeeId);
    const payslipNo = await nextPayslipNo(tid);
    const transactionNo = data.data.complete ? await nextTransactionNo(tid) : "";
    const salary = await prisma.$transaction(async (tx) => {
      const draft = await getOrCreateDraft(tx, tid, data.data.employeeId, payPeriod, payslipNo, req.userId);
      // Sync lines by id: existing ones are updated in place (so a line that
      // came from a shift keeps that link), new ones created, and anything
      // the form no longer lists is deleted.
      const existingItems = await tx.employeeSalaryItem.findMany({ where: { salaryId: draft.id }, select: { id: true } });
      const existingIds = new Set(existingItems.map((i) => i.id));
      const incoming = [
        ...data.data.allowances.map((item) => ({ ...item, type: "ALLOWANCE" as const })),
        ...data.data.deductions.map((item) => ({ ...item, type: "DEDUCTION" as const })),
      ];
      const keepIds = new Set(incoming.flatMap((item) => (item.id && existingIds.has(item.id) ? [item.id] : [])));
      await tx.employeeSalaryItem.deleteMany({ where: { salaryId: draft.id, id: { notIn: [...keepIds] } } });
      for (const item of incoming) {
        if (item.id && existingIds.has(item.id)) {
          await tx.employeeSalaryItem.update({ where: { id: item.id }, data: { type: item.type, label: item.label, amount: toMoney(item.amount) } });
        } else {
          await tx.employeeSalaryItem.create({ data: { salaryId: draft.id, type: item.type, label: item.label, amount: toMoney(item.amount) } });
        }
      }
      await tx.employeeSalary.update({
        where: { id: draft.id },
        data: {
          basicSalary: toMoney(data.data.basicSalary),
          paymentMethod: data.data.paymentMethod ?? null,
          reference: data.data.reference ?? null,
          notes: data.data.notes ?? null,
        },
      });
      const recalculated = await recalculateSalary(tx, draft.id);
      if (!data.data.complete) return recalculated;
      if (!data.data.paymentMethod) throw Object.assign(new Error("Choose a payment method before completing salary"), { status: 400 });
      await settleExcessDeductions(tx, tid, draft.id, data.data.carryOverDeductions, req.userId);
      await tx.employeeSalary.update({ where: { id: draft.id }, data: { status: "COMPLETE", paidAt: new Date() } });
      await createSalaryPayment(tx, tid, draft.id, transactionNo, req.userId);
      return tx.employeeSalary.findUniqueOrThrow({ where: { id: draft.id }, include: salaryInclude });
    });
    res.status(201).json({ salary });
  } catch (error) {
    if (sendSalaryError(res, error)) return;
    next(error);
  }
});

employeeSalariesRouter.post("/:id/items", async (req, res, next) => {
  const data = itemSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid salary item", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const existing = await prisma.employeeSalary.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, status: true } });
    if (!existing) { res.status(404).json({ error: "Salary record not found" }); return; }
    if (existing.status !== "DRAFT") { res.status(409).json({ error: "Only draft salaries can be changed" }); return; }
    const salary = await prisma.$transaction(async (tx) => {
      await tx.employeeSalaryItem.create({ data: { salaryId: existing.id, type: data.data.type, label: data.data.label, amount: toMoney(data.data.amount) } });
      return recalculateSalary(tx, existing.id);
    });
    res.status(201).json({ salary });
  } catch (error) { next(error); }
});

employeeSalariesRouter.delete("/:id/items/:itemId", async (req, res, next) => {
  const tid = tenantId(req);
  try {
    const existing = await prisma.employeeSalary.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, status: true } });
    if (!existing) { res.status(404).json({ error: "Salary record not found" }); return; }
    if (existing.status !== "DRAFT") { res.status(409).json({ error: "Only draft salaries can be changed" }); return; }
    const salary = await prisma.$transaction(async (tx) => {
      await tx.employeeSalaryItem.deleteMany({ where: { id: req.params.itemId, salaryId: existing.id } });
      return recalculateSalary(tx, existing.id);
    });
    res.json({ salary });
  } catch (error) { next(error); }
});

employeeSalariesRouter.post("/:id/complete", async (req, res, next) => {
  const data = completeSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid payment details", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const existing = await prisma.employeeSalary.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, status: true } });
    if (!existing) { res.status(404).json({ error: "Salary record not found" }); return; }
    if (existing.status !== "DRAFT") { res.status(409).json({ error: "Only draft salaries can be completed" }); return; }
    const transactionNo = await nextTransactionNo(tid);
    const salary = await prisma.$transaction(async (tx) => {
      await settleExcessDeductions(tx, tid, existing.id, data.data.carryOverDeductions, req.userId);
      await tx.employeeSalary.update({ where: { id: existing.id }, data: { paymentMethod: data.data.paymentMethod, reference: data.data.reference ?? null, notes: data.data.notes ?? undefined, status: "COMPLETE", paidAt: new Date() } });
      await createSalaryPayment(tx, tid, existing.id, transactionNo, req.userId);
      return tx.employeeSalary.findUniqueOrThrow({ where: { id: existing.id }, include: salaryInclude });
    });
    res.json({ salary });
  } catch (error) {
    if (sendSalaryError(res, error)) return;
    next(error);
  }
});

employeeSalariesRouter.post("/:id/void", async (req, res) => {
  const data = voidSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid void reason", details: data.error.flatten() }); return; }
  const salary = await prisma.employeeSalary.updateMany({
    where: { id: req.params.id, tenantId: tenantId(req), status: { not: "VOIDED" } },
    data: { status: "VOIDED", voidReason: data.data.reason, voidedBy: req.userId ?? null },
  });
  if (!salary.count) { res.status(404).json({ error: "Salary record not found" }); return; }
  res.json({ salary: await prisma.employeeSalary.findUniqueOrThrow({ where: { id: req.params.id }, include: salaryInclude }) });
});

/** What's already been recorded against this shift, if anything — so the
 * shift screen can show it (and edit it in place) instead of double-booking. */
employeeSalariesRouter.get("/by-shift/:shiftSessionId", requirePermission("SALARY_MANAGE"), async (req, res, next) => {
  const tid = tenantId(req);
  try {
    const item = await prisma.employeeSalaryItem.findFirst({
      where: { shiftSessionId: req.params.shiftSessionId as string, salary: { tenantId: tid, status: { not: "VOIDED" } } },
      include: { salary: { select: { id: true, payslipNo: true, payPeriod: true, status: true } } },
    });
    res.json({ item });
  } catch (error) { next(error); }
});

/** Record a deduction or allowance from a shift's discrepancy onto the
 * employee's salary for that month: add to the draft if one exists, spawn
 * one if not. Calling it again for the same shift edits the same line. */
employeeSalariesRouter.post("/from-shift", requirePermission("SALARY_MANAGE"), async (req, res, next) => {
  const data = fromShiftSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid adjustment", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const shift = await prisma.shiftSession.findFirst({ where: { id: data.data.shiftSessionId, tenantId: tid }, select: { id: true, employeeId: true, approvedStartAt: true, requestedStartAt: true } });
    if (!shift) { res.status(404).json({ error: "Shift not found" }); return; }
    const worked = shift.approvedStartAt ?? shift.requestedStartAt;
    const parts = nairobiParts(worked);
    const payPeriod = data.data.payPeriod ? monthStart(data.data.payPeriod) : new Date(Date.UTC(parts.year, parts.month - 1, 1));
    const label = data.data.label ?? `Shift ${data.data.type === "DEDUCTION" ? "shortage" : "overage"} - ${parts.day} ${MONTH_NAMES[parts.month - 1]}`;
    const existing = await prisma.employeeSalaryItem.findFirst({
      where: { shiftSessionId: shift.id, salary: { tenantId: tid, status: { not: "VOIDED" } } },
      include: { salary: { select: { id: true, status: true } } },
    });
    if (existing && existing.salary.status !== "DRAFT") { res.status(409).json({ error: "This shift's adjustment is already on a completed salary" }); return; }
    const needsNew = !existing;
    const payslipNo = needsNew ? await nextPayslipNo(tid) : "";
    const salary = await prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.employeeSalaryItem.update({ where: { id: existing.id }, data: { type: data.data.type, label, amount: toMoney(data.data.amount) } });
        return recalculateSalary(tx, existing.salary.id);
      }
      const draft = await getOrCreateDraft(tx, tid, shift.employeeId, payPeriod, payslipNo, req.userId);
      await tx.employeeSalaryItem.create({ data: { salaryId: draft.id, type: data.data.type, label, amount: toMoney(data.data.amount), shiftSessionId: shift.id } });
      return recalculateSalary(tx, draft.id);
    });
    res.status(existing ? 200 : 201).json({ salary });
  } catch (error) {
    if (sendSalaryError(res, error)) return;
    next(error);
  }
});
