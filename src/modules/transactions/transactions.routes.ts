import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";

// A unified, read-only ledger of every payment actually made across the
// business. Rows are only ever created as a side effect of a real payment
// elsewhere (reception folio, POS bill settlement) — there is no direct
// write endpoint here.
export const transactionsRouter = Router();

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const listSchema = z.object({
  direction: z.enum(["IN", "OUT"]).optional(),
  source: z.enum(["FOLIO_DEPOSIT", "FOLIO_SETTLEMENT", "POS_SALE", "EXPENSE", "ASSET_PURCHASE", "SUPPLIER_PAYMENT", "SALARY_PAYMENT"]).optional(),
  paymentMethodId: z.string().trim().min(1).optional(),
  locationId: z.string().trim().min(1).optional(),
  search: optionalText(120),
  from: z.preprocess(blankToUndefined, z.coerce.date().optional()),
  to: z.preprocess(blankToUndefined, z.coerce.date().optional()),
  // Cap the rows returned (most recent first) — e.g. the Dashboard's
  // "Latest transactions" widget only wants a handful. Omitted = no cap,
  // matching the page's existing unbounded behaviour.
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const transactionInclude = {
  paymentMethod: { select: { id: true, name: true } },
  customer: { select: { id: true, firstName: true, lastName: true } },
  supplier: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  employee: { select: { id: true, firstName: true, lastName: true } },
} as const;

transactionsRouter.get("/", async (req, res) => {
  const query = listSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid transaction filters", details: query.error.flatten() }); return; }
  const { direction, source, paymentMethodId, locationId, search, from, to, limit } = query.data;
  const tid = tenantId(req);

  const where = {
    tenantId: tid,
    ...(direction ? { direction } : {}),
    ...(source ? { source } : {}),
    ...(paymentMethodId ? { paymentMethodId } : {}),
    ...(locationId ? { locationId } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(search
      ? {
          OR: [
            { transactionNo: { contains: search, mode: "insensitive" as const } },
            { reference: { contains: search, mode: "insensitive" as const } },
            { description: { contains: search, mode: "insensitive" as const } },
            { customer: { firstName: { contains: search, mode: "insensitive" as const } } },
            { customer: { lastName: { contains: search, mode: "insensitive" as const } } },
            { supplier: { name: { contains: search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  // The summary always reflects every matching row, not just the page a
  // `limit` returns — a "latest 8" request shouldn't quietly shrink the
  // in/out totals to just those 8.
  const [transactions, aggregate] = await Promise.all([
    prisma.transaction.findMany({ where, include: transactionInclude, orderBy: { createdAt: "desc" }, ...(limit ? { take: limit } : {}) }),
    prisma.transaction.groupBy({ by: ["direction"], where: { ...where, status: "COMPLETE" }, _sum: { amount: true }, _count: true }),
  ]);

  const totalIn = Number(aggregate.find((a) => a.direction === "IN")?._sum.amount ?? 0);
  const totalOut = Number(aggregate.find((a) => a.direction === "OUT")?._sum.amount ?? 0);
  const totalCount = aggregate.reduce((s, a) => s + a._count, 0);
  res.json({ transactions, summary: { totalIn, totalOut, count: totalCount } });
});
