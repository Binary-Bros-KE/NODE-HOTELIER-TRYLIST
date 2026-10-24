import { z } from "zod";
import { prisma } from "./prisma.js";

// Customer and supplier statements: every bill on the account with what was
// billed, what was paid against it and what is still outstanding. Built from
// the same ledgers that keep Customer.balance / Supplier.balance, where every
// entry names the bill it belongs to (order or folio; purchase). Entries that
// name no bill (an opening balance, a manual adjustment, a general payment)
// become one "account" line, so the bills always add up to the balance.

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
export const statementQuery = z.object({
  from: z.preprocess(blankToUndefined, z.coerce.date().optional()),
  to: z.preprocess(blankToUndefined, z.coerce.date().optional()),
  // owing: only bills with something still outstanding (the default). all: paid ones too.
  show: z.preprocess(blankToUndefined, z.enum(["owing", "all"]).default("owing")),
});
export type StatementQuery = z.infer<typeof statementQuery>;

export type StatementLine = {
  key: string
  kind: "ORDER" | "STAY" | "INVOICE" | "PURCHASE" | "ACCOUNT"
  reference: string
  description: string
  date: string
  billed: number
  paid: number
  outstanding: number
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Applies the owing/all toggle and the bill-date range, newest first, with totals. */
function finish(lines: StatementLine[], q: StatementQuery, balance: number) {
  const to = q.to ? new Date(q.to.getTime() + 24 * 60 * 60 * 1000 - 1) : undefined;
  const shown = lines
    .map((l) => ({ ...l, billed: round2(l.billed), paid: round2(l.paid), outstanding: round2(l.outstanding) }))
    .filter((l) => (q.show === "all" ? Math.abs(l.billed) > 0.004 || Math.abs(l.paid) > 0.004 : Math.abs(l.outstanding) > 0.004))
    .filter((l) => (!q.from || new Date(l.date) >= q.from) && (!to || new Date(l.date) <= to))
    .sort((a, b) => b.date.localeCompare(a.date));
  return {
    lines: shown,
    totals: {
      billed: round2(shown.reduce((s, l) => s + l.billed, 0)),
      paid: round2(shown.reduce((s, l) => s + l.paid, 0)),
      outstanding: round2(shown.reduce((s, l) => s + l.outstanding, 0)),
    },
    // What the account owes right now, whatever the filters.
    balance: round2(balance),
  };
}

/** Group signed ledger entries by bill: positive = billed, negative = paid. */
function accumulate(map: Map<string, StatementLine>, key: string, base: () => StatementLine, amount: number, at: Date) {
  const line = map.get(key) ?? base();
  if (amount >= 0) line.billed += amount;
  else line.paid += -amount;
  line.outstanding += amount;
  if (at.toISOString() < line.date) line.date = at.toISOString();
  map.set(key, line);
}

export async function customerStatement(tenantId: string, customerId: string, q: StatementQuery) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, tenantId },
    select: { id: true, customerNo: true, firstName: true, lastName: true, businessName: true, phone: true, email: true, address: true, balance: true },
  });
  if (!customer) return null;

  const [entries, invoices] = await Promise.all([
    prisma.customerCreditEntry.findMany({
      where: { tenantId, customerId },
      include: { order: { select: { orderNumber: true, createdAt: true, location: { select: { name: true } } } } },
      orderBy: { createdAt: "asc" },
    }),
    // Invoices made in Invoices (or from a quotation). Stay / order invoices are left
    // out: their debt is already on the stay or order above.
    prisma.commercialDocument.findMany({
      where: { tenantId, customerId, type: "INVOICE", source: { in: ["MANUAL", "QUOTATION"] }, status: { notIn: ["DRAFT", "CANCELLED", "VOID"] } },
      select: { id: true, documentNo: true, title: true, issuedAt: true, createdAt: true, total: true, paidAmount: true, balance: true },
    }),
  ]);
  const folioIds = [...new Set(entries.filter((e) => e.folioId).map((e) => e.folioId as string))];
  const folios = folioIds.length ? await prisma.folio.findMany({
    where: { id: { in: folioIds } },
    select: { id: true, folioNo: true, reservation: { select: { reservationNo: true, checkIn: true, checkOut: true, room: { select: { number: true } } } } },
  }) : [];
  const folioById = new Map(folios.map((f) => [f.id, f]));

  const lines = new Map<string, StatementLine>();
  for (const e of entries) {
    const amount = Number(e.amount);
    if (e.orderId) {
      accumulate(lines, `order:${e.orderId}`, () => ({
        key: `order:${e.orderId}`, kind: "ORDER", reference: e.order ? `Order #${e.order.orderNumber}` : "Order",
        description: e.order?.location?.name ? `Sale at ${e.order.location.name}` : "Sale on credit",
        date: (e.order?.createdAt ?? e.createdAt).toISOString(), billed: 0, paid: 0, outstanding: 0,
      }), amount, e.createdAt);
    } else if (e.folioId) {
      const f = folioById.get(e.folioId);
      accumulate(lines, `folio:${e.folioId}`, () => ({
        key: `folio:${e.folioId}`, kind: "STAY", reference: f ? `Stay ${f.reservation.reservationNo}` : "Stay",
        description: f ? `Room ${f.reservation.room.number} · ${f.reservation.checkIn.toISOString().slice(0, 10)} to ${f.reservation.checkOut.toISOString().slice(0, 10)} · Folio ${f.folioNo}` : "Room stay",
        date: e.createdAt.toISOString(), billed: 0, paid: 0, outstanding: 0,
      }), amount, e.createdAt);
    } else {
      accumulate(lines, "account", () => ({
        key: "account", kind: "ACCOUNT", reference: "Account", description: "Adjustments and payments not tied to one bill",
        date: e.createdAt.toISOString(), billed: 0, paid: 0, outstanding: 0,
      }), amount, e.createdAt);
    }
  }
  for (const inv of invoices) {
    lines.set(`invoice:${inv.id}`, {
      key: `invoice:${inv.id}`, kind: "INVOICE", reference: inv.documentNo, description: inv.title || "Invoice",
      date: (inv.issuedAt ?? inv.createdAt).toISOString(),
      billed: Number(inv.total), paid: Number(inv.paidAmount), outstanding: Number(inv.balance),
    });
  }
  const invoiceBalance = invoices.reduce((s, i) => s + Number(i.balance), 0);
  const name = customer.businessName || `${customer.firstName} ${customer.lastName ?? ""}`.trim();
  return {
    party: { id: customer.id, detail: customer.customerNo, name, phone: customer.phone, email: customer.email, address: customer.address },
    ...finish([...lines.values()], q, Number(customer.balance) + invoiceBalance),
  };
}

export async function supplierStatement(tenantId: string, supplierId: string, q: StatementQuery) {
  const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, tenantId } });
  if (!supplier) return null;
  const entries = await prisma.supplierBalanceEntry.findMany({
    where: { tenantId, supplierId },
    include: { purchase: { select: { purchaseNo: true, reference: true, orderDate: true, location: { select: { name: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  const lines = new Map<string, StatementLine>();
  for (const e of entries) {
    const amount = Number(e.amount);
    if (e.purchaseId) {
      const p = e.purchase;
      accumulate(lines, `purchase:${e.purchaseId}`, () => ({
        key: `purchase:${e.purchaseId}`, kind: "PURCHASE", reference: p?.purchaseNo ?? "Purchase",
        description: [p?.reference ? `Supplier ref ${p.reference}` : null, p?.location?.name ? `Delivered to ${p.location.name}` : null].filter(Boolean).join(" · ") || "Goods supplied",
        date: (p?.orderDate ?? e.createdAt).toISOString(), billed: 0, paid: 0, outstanding: 0,
      }), amount, e.createdAt);
    } else {
      accumulate(lines, "account", () => ({
        key: "account", kind: "ACCOUNT", reference: "Account", description: "Opening balance, adjustments and payments not tied to one purchase",
        date: e.createdAt.toISOString(), billed: 0, paid: 0, outstanding: 0,
      }), amount, e.createdAt);
    }
  }
  return {
    party: { id: supplier.id, detail: supplier.contactPerson ? `Attn: ${supplier.contactPerson}` : null, name: supplier.name, phone: supplier.phone, email: supplier.email, address: supplier.address },
    ...finish([...lines.values()], q, Number(supplier.balance)),
  };
}
