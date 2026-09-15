import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { nextPayslipNo, nextTransactionNo } from "../../lib/sequence.js";

export const employeeSalariesRouter = Router();

const salaryStatuses = ["DRAFT", "COMPLETE", "VOIDED"] as const;
const itemTypes = ["ALLOWANCE", "DEDUCTION"] as const;
const paymentMethods = ["BANK_TRANSFER", "MPESA", "CASH", "CHEQUE", "CARD"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalDate = z.preprocess(blankToUndefined, z.coerce.date().optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());

const salaryLineSchema = z.object({
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
});

const completeSchema = z.object({
  paymentMethod: z.enum(paymentMethods),
  reference: optionalText(120),
  notes: optionalText(500),
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
  const totalDeductions = salary.items.filter((item) => item.type === "DEDUCTION").reduce((sum, item) => sum + Number(item.amount), 0);
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
      await tx.employeeSalaryItem.deleteMany({ where: { salaryId: draft.id } });
      const lines = [
        ...data.data.allowances.map((item) => ({ salaryId: draft.id, type: "ALLOWANCE" as const, label: item.label, amount: toMoney(item.amount) })),
        ...data.data.deductions.map((item) => ({ salaryId: draft.id, type: "DEDUCTION" as const, label: item.label, amount: toMoney(item.amount) })),
      ];
      if (lines.length) await tx.employeeSalaryItem.createMany({ data: lines });
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
      await tx.employeeSalary.update({ where: { id: draft.id }, data: { status: "COMPLETE", paidAt: new Date() } });
      await createSalaryPayment(tx, tid, draft.id, transactionNo, req.userId);
      return tx.employeeSalary.findUniqueOrThrow({ where: { id: draft.id }, include: salaryInclude });
    });
    res.status(201).json({ salary });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
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
      await tx.employeeSalary.update({ where: { id: existing.id }, data: { paymentMethod: data.data.paymentMethod, reference: data.data.reference ?? null, notes: data.data.notes ?? undefined, status: "COMPLETE", paidAt: new Date() } });
      await createSalaryPayment(tx, tid, existing.id, transactionNo, req.userId);
      return tx.employeeSalary.findUniqueOrThrow({ where: { id: existing.id }, include: salaryInclude });
    });
    res.json({ salary });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
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
