import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { nextSupplierPaymentNo, nextTransactionNo } from "../../lib/sequence.js";
import { recordSupplierBalanceEntry } from "../../lib/supplierBalance.js";
import { checkedPaymentReference } from "../../lib/paymentReferences.js";

// Suppliers/vendors the property buys stock from. A plain definitional
// lookup for now — Purchases / Goods Received will consume it later — so
// no requireModule gate, matching assets/expenses/payment-methods.
export const suppliersRouter = Router();

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalEmail = z.preprocess(blankToUndefined, z.email().optional());
const optionalNumber = z.preprocess(blankToUndefined, z.coerce.number().finite().optional());

const createSchema = z.object({
  name: z.string().trim().min(1).max(150),
  contactPerson: optionalText(120),
  phone: optionalText(40),
  email: optionalEmail,
  address: optionalText(255),
  city: optionalText(80),
  taxPin: optionalText(40),
  paymentTerms: optionalText(120),
  notes: optionalText(500),
  // Opening balance only — once purchases/payments drive this, it stops
  // being user-editable, so it's deliberately left out of updateSchema.
  balance: optionalNumber,
  isActive: z.boolean().default(true),
});
const updateSchema = partialNoDefaults(createSchema.omit({ balance: true }));

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const supplierInclude = {
  createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
  updatedByEmployee: { select: { id: true, firstName: true, lastName: true } },
} as const;

suppliersRouter.get("/", async (req, res) => {
  const query = z.object({
    search: optionalText(120),
    active: z.enum(["true", "false"]).optional(),
  }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid supplier filters", details: query.error.flatten() }); return; }
  const { search, active } = query.data;
  const where: Prisma.SupplierWhereInput = {
    tenantId: tenantId(req),
    ...(active ? { isActive: active === "true" } : {}),
    ...(search ? { OR: [
      { name: { contains: search, mode: "insensitive" } },
      { contactPerson: { contains: search, mode: "insensitive" } },
      { phone: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    ] } : {}),
  };
  const suppliers = await prisma.supplier.findMany({ where, include: supplierInclude, orderBy: { name: "asc" } });
  const totalBalance = suppliers.reduce((sum, s) => sum + Number(s.balance), 0);
  res.json({ suppliers, summary: { total: suppliers.length, active: suppliers.filter((s) => s.isActive).length, totalBalance } });
});

suppliersRouter.get("/:id", async (req, res) => {
  const supplier = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: supplierInclude });
  if (!supplier) { res.status(404).json({ error: "Supplier not found" }); return; }
  res.json({ supplier });
});

suppliersRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid supplier", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const supplier = await prisma.$transaction(async (tx) => {
      const created = await tx.supplier.create({
        data: { tenantId: tid, createdBy: req.userId, ...data.data },
        include: supplierInclude,
      });
      if (data.data.balance && data.data.balance !== 0) {
        await tx.supplierBalanceEntry.create({
          data: {
            tenantId: tid,
            supplierId: created.id,
            type: "OPENING_BALANCE",
            amount: data.data.balance,
            balanceBefore: 0,
            balanceAfter: data.data.balance,
            note: "Opening supplier balance",
            createdBy: req.userId,
          },
        });
      }
      return created;
    });
    res.status(201).json({ supplier });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A supplier with this name already exists" }); return; }
    next(error);
  }
});

suppliersRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid supplier", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const updated = await prisma.supplier.updateMany({ where: { id: req.params.id, tenantId: tid }, data: { ...data.data, updatedBy: req.userId } });
    if (!updated.count) { res.status(404).json({ error: "Supplier not found" }); return; }
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: req.params.id }, include: supplierInclude });
    res.json({ supplier });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A supplier with this name already exists" }); return; }
    next(error);
  }
});

const paymentSchema = z.object({
  amount: z.coerce.number().positive(),
  paymentMethodId: z.string().trim().min(1),
  purchaseId: z.string().trim().min(1).optional(),
  reference: optionalText(120),
  note: optionalText(500),
  paidAt: z.preprocess(blankToUndefined, z.coerce.date().optional()),
});

const paymentInclude = {
  paymentMethod: { select: { id: true, name: true, requiresReference: true } },
  purchase: { select: { id: true, purchaseNo: true } },
  createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
} as const;

async function resolvePaymentMethod(tid: string, paymentMethodId: string, reference: string | undefined) {
  const method = await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, tenantId: tid, isActive: true } });
  if (!method) throw Object.assign(new Error("Choose a valid, active payment method"), { status: 400 });
  const cleanReference = await checkedPaymentReference(prisma, tid, method, reference);
  return { method, reference: cleanReference };
}

function paymentStatusFrom(paid: number, owed: number) {
  if (owed <= 0.0005 || paid <= 0.0005) return "UNPAID";
  if (paid >= owed - 0.0005) return "PAID";
  return "PARTIAL";
}

async function recomputePurchasePaymentStatus(tx: Prisma.TransactionClient, purchaseId: string) {
  const [owedAgg, paidAgg] = await Promise.all([
    tx.supplierBalanceEntry.aggregate({ where: { purchaseId, type: "GOODS_RECEIPT" }, _sum: { amount: true } }),
    tx.supplierPayment.aggregate({ where: { purchaseId }, _sum: { amount: true } }),
  ]);
  const owed = Number(owedAgg._sum.amount ?? 0);
  const paid = Number(paidAgg._sum.amount ?? 0);
  return tx.purchase.update({ where: { id: purchaseId }, data: { paymentStatus: paymentStatusFrom(paid, owed) } });
}

/** Payment history for one supplier — the only thing that ever brings
 * Supplier.balance back down (Goods Received only ever raises it). */
suppliersRouter.get("/:id/payments", async (req, res, next) => {
  try {
    const tid = tenantId(req);
    const supplier = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!supplier) { res.status(404).json({ error: "Supplier not found" }); return; }
    const payments = await prisma.supplierPayment.findMany({ where: { supplierId: supplier.id, tenantId: tid }, include: paymentInclude, orderBy: { paidAt: "desc" } });
    res.json({ payments });
  } catch (error) {
    next(error);
  }
});

suppliersRouter.get("/:id/balance-entries", async (req, res, next) => {
  try {
    const tid = tenantId(req);
    const supplier = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!supplier) { res.status(404).json({ error: "Supplier not found" }); return; }
    const entries = await prisma.supplierBalanceEntry.findMany({
      where: { supplierId: supplier.id, tenantId: tid },
      include: {
        purchase: { select: { id: true, purchaseNo: true } },
        goodsReceipt: { select: { id: true, receiptNo: true } },
        payment: { select: { id: true, paymentNo: true } },
        createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ entries });
  } catch (error) {
    next(error);
  }
});

/** Records real cash paid to a supplier — decrements balance and writes a
 * Transaction (the single unified cash ledger), same as Expense does. */
suppliersRouter.post("/:id/payments", async (req, res, next) => {
  const data = paymentSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid payment", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const supplier = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!supplier) { res.status(404).json({ error: "Supplier not found" }); return; }
    const resolvedPayment = await resolvePaymentMethod(tid, data.data.paymentMethodId, data.data.reference);
    if (data.data.purchaseId) {
      const purchase = await prisma.purchase.findFirst({ where: { id: data.data.purchaseId, tenantId: tid, supplierId: supplier.id }, select: { id: true, status: true } });
      if (!purchase) { res.status(400).json({ error: "That purchase does not belong to this supplier" }); return; }
      if (purchase.status === "DRAFT" || purchase.status === "ORDERED" || purchase.status === "CANCELLED") {
        res.status(409).json({ error: "Receive goods before recording a payment for this purchase" });
        return;
      }
      const [owedAgg, paidAgg] = await Promise.all([
        prisma.supplierBalanceEntry.aggregate({ where: { purchaseId: purchase.id, type: "GOODS_RECEIPT" }, _sum: { amount: true } }),
        prisma.supplierPayment.aggregate({ where: { purchaseId: purchase.id }, _sum: { amount: true } }),
      ]);
      const outstanding = Number(owedAgg._sum.amount ?? 0) - Number(paidAgg._sum.amount ?? 0);
      if (data.data.amount > outstanding + 0.0005) {
        res.status(400).json({ error: "This payment is more than the outstanding purchase balance" });
        return;
      }
    }
    if (data.data.amount > Number(supplier.balance) + 0.0005) {
      res.status(400).json({ error: "This payment is more than the supplier balance" });
      return;
    }

    const paymentNo = await nextSupplierPaymentNo(tid);
    const transactionNo = await nextTransactionNo(tid);
    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.supplierPayment.create({
        data: {
          tenantId: tid,
          paymentNo,
          supplierId: supplier.id,
          purchaseId: data.data.purchaseId,
          amount: data.data.amount,
          paymentMethodId: data.data.paymentMethodId,
          reference: resolvedPayment.reference,
          note: data.data.note,
          createdBy: req.userId,
          ...(data.data.paidAt ? { paidAt: data.data.paidAt } : {}),
        },
        include: paymentInclude,
      });
      await recordSupplierBalanceEntry(tx, {
        tenantId: tid,
        supplierId: supplier.id,
        type: "PAYMENT",
        amount: -data.data.amount,
        note: data.data.note ?? `Payment ${paymentNo}`,
        purchaseId: data.data.purchaseId ?? null,
        paymentId: created.id,
        createdBy: req.userId ?? null,
      });
      await tx.transaction.create({
        data: {
          tenantId: tid,
          transactionNo,
          direction: "OUT",
          source: "SUPPLIER_PAYMENT",
          amount: data.data.amount,
          paymentMethodId: data.data.paymentMethodId,
          reference: resolvedPayment.reference,
          supplierId: supplier.id,
          employeeId: req.userId,
          description: `Payment to ${supplier.name}`,
          sourceRefId: created.id,
        },
      });
      if (data.data.purchaseId) await recomputePurchasePaymentStatus(tx, data.data.purchaseId);
      return created;
    });
    const updatedSupplier = await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id }, include: supplierInclude });
    res.status(201).json({ payment, supplier: updatedSupplier });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

suppliersRouter.delete("/:id", async (req, res) => {
  const supplier = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: { id: true } });
  if (!supplier) { res.status(404).json({ error: "Supplier not found" }); return; }
  await prisma.supplier.delete({ where: { id: supplier.id } });
  res.status(204).send();
});
