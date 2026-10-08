import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { nextPayslipNo, nextTransactionNo } from "../../lib/sequence.js";
import { nairobiParts } from "../../lib/shifts.js";
import { requirePermission } from "../../middleware/tenantContext.js";
import { assertPaymentReferenceUnused, normalizePaymentReference } from "../../lib/paymentReferences.js";

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
  allowances: z.array(salaryLineSchema).default([]),
  deductions: z.array(salaryLineSchema).default([]),
  notes: optionalText(500),
}).refine((value) => value.allowances.length + value.deductions.length > 0, { message: "Add at least one allowance or deduction" });

const defaultsSchema = z.object({
  items: z.array(z.object({
    id: z.string().trim().min(1).optional(),
    type: z.enum(itemTypes),
    label: z.string().trim().min(1).max(120),
    amount: z.coerce.number().min(0),
  })),
});

const reportSchema = z.object({
  from: optionalDate,
  to: optionalDate,
  month: z.preprocess(blankToUndefined, z.string().regex(/^\d{4}-\d{2}$/).optional()),
  locationId: optionalId,
  departmentId: optionalId,
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
      jobTitle: true,
      phone: true,
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
  const existing = await tx.transaction.findFirst({ where: { tenantId: tid, source: "SALARY_PAYMENT", sourceRefId: salaryId }, select: { id: true, status: true } });
  if (existing) {
    if (existing.status !== "COMPLETE") await tx.transaction.update({ where: { id: existing.id }, data: { status: "COMPLETE", amount: salary.netPay } });
    return;
  }
  const reference = salary.reference ? await assertPaymentReferenceUnused(tx, tid, salary.reference) : undefined;
  await tx.transaction.create({
    data: {
      tenantId: tid,
      transactionNo,
      direction: "OUT",
      source: "SALARY_PAYMENT",
      amount: salary.netPay,
      reference,
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
  const created = await tx.employeeSalary.create({
    data: { tenantId: tid, payslipNo, employeeId, payPeriod, createdBy: by },
    select: { id: true, status: true },
  });
  await applyDefaults(tx, tid, created.id, employeeId);
  return created;
}

/** Copies the employee's default allowances and deductions onto a salary as lines,
 * alongside whatever is already there: nothing on the draft is replaced. A default
 * already copied (by defaultId) is never copied twice. With `since`, only defaults
 * added after that moment are copied, so one removed from a draft stays removed. */
async function applyDefaults(tx: Prisma.TransactionClient, tid: string, salaryId: string, employeeId: string, since?: Date) {
  const defaults = await tx.employeeSalaryDefault.findMany({
    where: { tenantId: tid, employeeId, ...(since ? { createdAt: { gt: since } } : {}) },
    orderBy: { createdAt: "asc" },
  });
  if (!defaults.length) return;
  const copied = new Set((await tx.employeeSalaryItem.findMany({ where: { salaryId, defaultId: { not: null } }, select: { defaultId: true } })).map((i) => i.defaultId));
  const missing = defaults.filter((d) => !copied.has(d.id));
  if (!missing.length) return;
  await tx.employeeSalaryItem.createMany({
    data: missing.map((d) => ({ salaryId, type: d.type, label: d.label, amount: d.amount, defaultId: d.id })),
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
  const live = aggregate.filter((row) => row.status !== "VOIDED");
  res.json({
    salaries,
    summary: {
      count: live.reduce((sum, row) => sum + row._count, 0),
      netPay: live.reduce((sum, row) => sum + Number(row._sum.netPay ?? 0), 0),
      allowances: live.reduce((sum, row) => sum + Number(row._sum.totalAllowances ?? 0), 0),
      deductions: live.reduce((sum, row) => sum + Number(row._sum.totalDeductions ?? 0), 0),
      byStatus: aggregate.map((row) => ({ status: row.status, count: row._count, netPay: Number(row._sum.netPay ?? 0) })),
    },
  });
});

employeeSalariesRouter.get("/defaults/:employeeId", requirePermission("SALARY_MANAGE"), async (req, res) => {
  const items = await prisma.employeeSalaryDefault.findMany({ where: { tenantId: tenantId(req), employeeId: String(req.params.employeeId) }, orderBy: { createdAt: "asc" } });
  res.json({ items });
});

employeeSalariesRouter.put("/defaults/:employeeId", requirePermission("SALARY_MANAGE"), async (req, res, next) => {
  const data = defaultsSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid allowances and deductions", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const employeeId = String(req.params.employeeId);
  try {
    await assertEmployee(tid, employeeId);
    const items = await prisma.$transaction(async (tx) => {
      const existing = await tx.employeeSalaryDefault.findMany({ where: { tenantId: tid, employeeId }, select: { id: true } });
      const existingIds = new Set(existing.map((row) => row.id));
      const keep = data.data.items.flatMap((item) => (item.id && existingIds.has(item.id) ? [item.id] : []));
      await tx.employeeSalaryDefault.deleteMany({ where: { tenantId: tid, employeeId, id: { notIn: keep } } });
      for (const item of data.data.items) {
        if (item.id && existingIds.has(item.id)) {
          await tx.employeeSalaryDefault.update({ where: { id: item.id }, data: { type: item.type, label: item.label, amount: toMoney(item.amount) } });
        } else {
          await tx.employeeSalaryDefault.create({ data: { tenantId: tid, employeeId, type: item.type, label: item.label, amount: toMoney(item.amount) } });
        }
      }
      return tx.employeeSalaryDefault.findMany({ where: { tenantId: tid, employeeId }, orderBy: { createdAt: "asc" } });
    });
    res.json({ items });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

const round2Report = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Groups salary rows by a key and totals each group. */
function groupSalaries<T extends { basicSalary: unknown; totalAllowances: unknown; totalDeductions: unknown; grossPay: unknown; netPay: unknown }>(rows: T[], keyOf: (row: T) => { key: string; name: string }) {
  const groups = new Map<string, { key: string; name: string; count: number; basic: number; allowances: number; deductions: number; gross: number; net: number }>();
  for (const row of rows) {
    const { key, name } = keyOf(row);
    const group = groups.get(key) ?? { key, name, count: 0, basic: 0, allowances: 0, deductions: 0, gross: 0, net: 0 };
    group.count += 1;
    group.basic += Number(row.basicSalary);
    group.allowances += Number(row.totalAllowances);
    group.deductions += Number(row.totalDeductions);
    group.gross += Number(row.grossPay);
    group.net += Number(row.netPay);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, basic: round2Report(g.basic), allowances: round2Report(g.allowances), deductions: round2Report(g.deductions), gross: round2Report(g.gross), net: round2Report(g.net) }))
    .sort((a, b) => b.net - a.net);
}

/** Completed salaries for a period, totalled overall and by employee, location, department and month. */
employeeSalariesRouter.get("/report", requirePermission("SALARY_MANAGE"), async (req, res, next) => {
  const query = reportSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid report filters", details: query.error.flatten() }); return; }
  const { locationId, departmentId } = query.data;
  // Pay periods are whole months, so the range is taken in months: a day in the middle of a month still includes that month.
  const from = query.data.month ? new Date(Date.UTC(Number(query.data.month.slice(0, 4)), Number(query.data.month.slice(5, 7)) - 1, 1)) : query.data.from ? monthStart(query.data.from) : undefined;
  const to = query.data.month ? new Date(Date.UTC(Number(query.data.month.slice(0, 4)), Number(query.data.month.slice(5, 7)), 0)) : query.data.to ? monthStart(query.data.to) : undefined;
  const tid = tenantId(req);
  const employeeWhere: Prisma.EmployeeWhereInput = {
    ...(departmentId ? { departmentId } : {}),
    ...(locationId ? { OR: [{ defaultLocationId: locationId }, { locations: { some: { id: locationId } } }] } : {}),
  };
  try {
    const rows = await prisma.employeeSalary.findMany({
      where: {
        tenantId: tid,
        status: "COMPLETE",
        ...(from || to ? { payPeriod: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        ...(Object.keys(employeeWhere).length ? { employee: employeeWhere } : {}),
      },
      include: { employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true, department: { select: { id: true, name: true } }, defaultLocation: { select: { id: true, name: true } } } } },
      orderBy: { payPeriod: "asc" },
    });
    const totals = groupSalaries(rows, () => ({ key: "all", name: "All employees" }))[0] ?? { count: 0, basic: 0, allowances: 0, deductions: 0, gross: 0, net: 0 };
    res.json({
      range: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
      totals,
      byEmployee: groupSalaries(rows, (r) => ({ key: r.employee.id, name: `${r.employee.firstName} ${r.employee.lastName}`.trim() })),
      byLocation: groupSalaries(rows, (r) => ({ key: r.employee.defaultLocation?.id ?? "unassigned", name: r.employee.defaultLocation?.name ?? "Works anywhere" })),
      byDepartment: groupSalaries(rows, (r) => ({ key: r.employee.department?.id ?? "none", name: r.employee.department?.name ?? "No department" })),
      byMonth: groupSalaries(rows, (r) => ({ key: r.payPeriod.toISOString().slice(0, 7), name: `${MONTH_NAMES[r.payPeriod.getUTCMonth()]} ${r.payPeriod.getUTCFullYear()}` })).sort((a, b) => a.key.localeCompare(b.key)),
    });
  } catch (error) {
    next(error);
  }
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
        data: [
          ...data.data.allowances.map((item) => ({ salaryId: draft.id, type: "ALLOWANCE" as const, label: item.label, amount: toMoney(item.amount) })),
          ...data.data.deductions.map((item) => ({ salaryId: draft.id, type: "DEDUCTION" as const, label: item.label, amount: toMoney(item.amount) })),
        ],
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
      const draftRow = await tx.employeeSalary.findUniqueOrThrow({ where: { id: draft.id }, select: { createdAt: true } });
      await applyDefaults(tx, tid, draft.id, data.data.employeeId, draftRow.createdAt);
      await tx.employeeSalary.update({
        where: { id: draft.id },
        data: {
          basicSalary: toMoney(data.data.basicSalary),
          paymentMethod: data.data.paymentMethod ?? null,
          reference: normalizePaymentReference(data.data.reference) ?? null,
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
      await tx.employeeSalary.update({ where: { id: existing.id }, data: { paymentMethod: data.data.paymentMethod, reference: normalizePaymentReference(data.data.reference) ?? null, notes: data.data.notes ?? undefined, status: "COMPLETE", paidAt: new Date() } });
      await createSalaryPayment(tx, tid, existing.id, transactionNo, req.userId);
      return tx.employeeSalary.findUniqueOrThrow({ where: { id: existing.id }, include: salaryInclude });
    });
    res.json({ salary });
  } catch (error) {
    if (sendSalaryError(res, error)) return;
    next(error);
  }
});

employeeSalariesRouter.post("/:id/void", async (req, res, next) => {
  const data = voidSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid void reason", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const salary = await prisma.$transaction(async (tx) => {
      const existing = await tx.employeeSalary.findFirst({ where: { id: req.params.id, tenantId: tid, status: { not: "VOIDED" } }, select: { id: true, carriedOverAmount: true } });
      if (!existing) throw Object.assign(new Error("Salary record not found"), { status: 404 });
      if (Number(existing.carriedOverAmount) > 0) {
        // The deductions this payslip pushed onto next month's draft go with it.
        const carry = await tx.employeeSalaryItem.findFirst({ where: { carriedFromSalaryId: existing.id }, select: { id: true, salary: { select: { id: true, status: true } } } });
        if (carry && carry.salary.status !== "DRAFT") throw Object.assign(new Error("Void next month's payslip first - it already carries these deductions"), { status: 409 });
        if (carry) {
          await tx.employeeSalaryItem.delete({ where: { id: carry.id } });
          await recalculateSalary(tx, carry.salary.id);
        }
      }
      await tx.employeeSalary.update({
        where: { id: existing.id },
        data: { status: "VOIDED", voidReason: data.data.reason, voidedBy: req.userId ?? null, carriedOverAmount: toMoney(0) },
      });
      await recalculateSalary(tx, existing.id);
      await tx.transaction.updateMany({ where: { tenantId: tid, source: "SALARY_PAYMENT", sourceRefId: existing.id }, data: { status: "VOIDED" } });
      return tx.employeeSalary.findUniqueOrThrow({ where: { id: existing.id }, include: salaryInclude });
    });
    res.json({ salary });
  } catch (error) {
    if (sendSalaryError(res, error)) return;
    next(error);
  }
});

// Returns a voided payslip. A paid one comes back as paid; if its deductions now
// exceed its gross it comes back as a draft to be completed again (with carry-over).
employeeSalariesRouter.post("/:id/unvoid", async (req, res, next) => {
  const tid = tenantId(req);
  try {
    const salary = await prisma.$transaction(async (tx) => {
      const row = await tx.employeeSalary.findFirst({ where: { id: req.params.id, tenantId: tid, status: "VOIDED" }, select: { id: true, paidAt: true, netPay: true } });
      if (!row) throw Object.assign(new Error("Voided payslip not found"), { status: 404 });
      const back = row.paidAt && Number(row.netPay) >= 0 ? "COMPLETE" : "DRAFT";
      await tx.employeeSalary.update({ where: { id: row.id }, data: { status: back, voidReason: null, voidedBy: null } });
      if (back === "COMPLETE") await tx.transaction.updateMany({ where: { tenantId: tid, source: "SALARY_PAYMENT", sourceRefId: row.id }, data: { status: "COMPLETE" } });
      return tx.employeeSalary.findUniqueOrThrow({ where: { id: row.id }, include: salaryInclude });
    });
    res.json({ salary });
  } catch (error) {
    if (sendSalaryError(res, error)) return;
    next(error);
  }
});

// Moves a payslip to another month. Refused when it carries deductions into the next
// month (they'd no longer line up) or when that employee already has a payslip for it.
employeeSalariesRouter.patch("/:id/period", async (req, res, next) => {
  const data = z.object({ payPeriod: z.coerce.date() }).safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Choose a month" }); return; }
  const tid = tenantId(req);
  const target = monthStart(data.data.payPeriod);
  try {
    const salary = await prisma.$transaction(async (tx) => {
      const row = await tx.employeeSalary.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, employeeId: true, payPeriod: true, carriedOverAmount: true } });
      if (!row) throw Object.assign(new Error("Salary record not found"), { status: 404 });
      if (row.payPeriod.getTime() === target.getTime()) return tx.employeeSalary.findUniqueOrThrow({ where: { id: row.id }, include: salaryInclude });
      const carries = Number(row.carriedOverAmount) > 0 || (await tx.employeeSalaryItem.count({ where: { carriedFromSalaryId: row.id } })) > 0;
      if (carries) throw Object.assign(new Error("This payslip carries deductions into the next month - void it to move it"), { status: 409 });
      const clash = await tx.employeeSalary.findUnique({ where: { tenantId_employeeId_payPeriod: { tenantId: tid, employeeId: row.employeeId, payPeriod: target } }, select: { id: true } });
      if (clash) throw Object.assign(new Error(`This employee already has a payslip for ${MONTH_NAMES[target.getUTCMonth()]} ${target.getUTCFullYear()}`), { status: 409 });
      await tx.employeeSalary.update({ where: { id: row.id }, data: { payPeriod: target } });
      return tx.employeeSalary.findUniqueOrThrow({ where: { id: row.id }, include: salaryInclude });
    });
    res.json({ salary });
  } catch (error) {
    if (sendSalaryError(res, error)) return;
    next(error);
  }
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
