import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { nextExpenseNo, nextTransactionNo } from "../../lib/sequence.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { checkedPaymentReference } from "../../lib/paymentReferences.js";

// Day-to-day incidental spending recorded by staff (tape, fare, a
// replacement part) — full CRUD on the category, but an expense itself is
// never hard-deleted, only archived, matching the append-only discipline
// already used for Reservation/Folio records.
export const expensesRouter = Router();

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());

const createSchema = z.object({
  categoryId: z.string().trim().min(1),
  expenseDate: z.coerce.date().optional(),
  amount: z.coerce.number().positive(),
  paymentMethodId: z.string().trim().min(1),
  reference: optionalText(120),
  description: optionalText(500),
  locationId: optionalId,
});
// status/expenseNo/paymentMethodId changes go through resolvePaymentMethod
// below rather than the generic partial schema, since the reference
// requirement must be re-checked whenever the method or reference changes.
const updateSchema = partialNoDefaults(createSchema).extend({ status: z.enum(["ACTIVE", "ARCHIVED"]).optional() });

const listSchema = z.object({
  categoryId: z.string().trim().optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  search: optionalText(120),
  from: z.preprocess(blankToUndefined, z.coerce.date().optional()),
  to: z.preprocess(blankToUndefined, z.coerce.date().optional()),
});

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const expenseInclude = {
  category: { select: { id: true, name: true } },
  paymentMethod: { select: { id: true, name: true, requiresReference: true } },
  location: { select: { id: true, name: true } },
  createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
} as const;

async function resolvePaymentMethod(tid: string, paymentMethodId: string, reference: string | undefined, options: { excludeTransactionId?: string } = {}) {
  const method = await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, tenantId: tid, isActive: true } });
  if (!method) throw Object.assign(new Error("Choose a valid, active payment method"), { status: 400 });
  const cleanReference = await checkedPaymentReference(prisma, tid, method, reference, options);
  return { method, reference: cleanReference };
}

async function assertCategoryInTenant(categoryId: string, tid: string) {
  const category = await prisma.expenseCategory.findFirst({ where: { id: categoryId, tenantId: tid, isActive: true } });
  if (!category) throw Object.assign(new Error("Choose a valid, active expense category"), { status: 400 });
  return category;
}

expensesRouter.get("/", async (req, res) => {
  const query = listSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid expense filters", details: query.error.flatten() }); return; }
  const { categoryId, status, search, from, to } = query.data;
  const tid = tenantId(req);
  const expenses = await prisma.expense.findMany({
    where: {
      tenantId: tid,
      ...(categoryId ? { categoryId } : {}),
      ...(status ? { status } : {}),
      ...(from || to ? { expenseDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(search
        ? { OR: [
            { expenseNo: { contains: search, mode: "insensitive" } },
            { reference: { contains: search, mode: "insensitive" } },
            { description: { contains: search, mode: "insensitive" } },
            { category: { name: { contains: search, mode: "insensitive" } } },
          ] }
        : {}),
    },
    include: expenseInclude,
    orderBy: { expenseDate: "desc" },
  });
  const total = expenses.filter((e) => e.status === "ACTIVE").reduce((s, e) => s + Number(e.amount), 0);
  const byCategory = new Map<string, { name: string; count: number; total: number }>();
  for (const e of expenses.filter((e) => e.status === "ACTIVE")) {
    const bucket = byCategory.get(e.categoryId) ?? { name: e.category.name, count: 0, total: 0 };
    bucket.count += 1;
    bucket.total += Number(e.amount);
    byCategory.set(e.categoryId, bucket);
  }
  res.json({ expenses, summary: { total, byCategory: [...byCategory.values()].sort((a, b) => b.total - a.total) } });
});

expensesRouter.post("/", async (req, res) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid expense", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  await assertCategoryInTenant(data.data.categoryId, tid);
  const resolvedPayment = await resolvePaymentMethod(tid, data.data.paymentMethodId, data.data.reference);
  const category = await prisma.expenseCategory.findUniqueOrThrow({ where: { id: data.data.categoryId }, select: { name: true } });
  const expenseNo = await nextExpenseNo(tid);
  const transactionNo = await nextTransactionNo(tid);
  const expense = await prisma.$transaction(async (tx) => {
    const created = await tx.expense.create({
      data: { tenantId: tid, expenseNo, createdBy: req.userId, ...data.data, reference: resolvedPayment.reference },
      include: expenseInclude,
    });
    await tx.transaction.create({
      data: {
        tenantId: tid,
        transactionNo,
        direction: "OUT",
        source: "EXPENSE",
        amount: data.data.amount,
        paymentMethodId: data.data.paymentMethodId,
        reference: resolvedPayment.reference,
        locationId: data.data.locationId,
        employeeId: req.userId,
        description: `Expense — ${category.name}${data.data.description ? `: ${data.data.description}` : ""}`,
        sourceRefId: created.id,
      },
    });
    return created;
  });
  res.status(201).json({ expense });
});

expensesRouter.patch("/:id", async (req, res) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid expense", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const existing = await prisma.expense.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!existing) { res.status(404).json({ error: "Expense not found" }); return; }
  if (data.data.categoryId) await assertCategoryInTenant(data.data.categoryId, tid);
  const nextPaymentMethodId = data.data.paymentMethodId ?? existing.paymentMethodId;
  const nextReference = data.data.reference !== undefined ? data.data.reference : (existing.reference ?? undefined);
  const existingTransaction = data.data.paymentMethodId || data.data.reference !== undefined
    ? await prisma.transaction.findFirst({ where: { tenantId: tid, source: "EXPENSE", sourceRefId: existing.id }, select: { id: true } })
    : null;
  const resolvedPayment = data.data.paymentMethodId || data.data.reference !== undefined ? await resolvePaymentMethod(tid, nextPaymentMethodId, nextReference, { excludeTransactionId: existingTransaction?.id }) : null;
  const updateData = resolvedPayment ? { ...data.data, reference: resolvedPayment.reference } : data.data;
  const expense = await prisma.$transaction(async (tx) => {
    const updated = await tx.expense.update({ where: { id: existing.id }, data: updateData, include: expenseInclude });
    if (data.data.amount !== undefined || data.data.paymentMethodId || data.data.reference !== undefined || data.data.locationId !== undefined) {
      await tx.transaction.updateMany({
        where: { tenantId: tid, source: "EXPENSE", sourceRefId: existing.id },
        data: {
          ...(data.data.amount !== undefined ? { amount: data.data.amount } : {}),
          ...(data.data.paymentMethodId ? { paymentMethodId: data.data.paymentMethodId } : {}),
          ...(resolvedPayment ? { reference: resolvedPayment.reference } : {}),
          ...(data.data.locationId !== undefined ? { locationId: data.data.locationId } : {}),
        },
      });
    }
    return updated;
  });
  res.json({ expense });
});
