import { Router } from "express";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { computeOrderFinancials } from "../../lib/orderTotals.js";
import { resolveEffectiveLocation } from "../../lib/location.js";
import { nextCommercialDocumentPaymentNo, nextInvoiceNo, nextQuotationNo, nextTransactionNo } from "../../lib/sequence.js";

const docTypes = ["QUOTATION", "INVOICE"] as const;
const docStatuses = ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED", "CONVERTED", "ISSUED", "PARTIALLY_PAID", "PAID", "OVERDUE", "VOID"] as const;
const lineSources = ["CUSTOM", "ROOM", "ROOM_STAY", "FOLIO", "SERVICE", "SERVICE_MEMBERSHIP", "POS_ORDER"] as const;
const taxModes = ["INCLUSIVE", "EXCLUSIVE"] as const;
const taxTreatments = ["STANDARD", "ZERO_RATED", "EXEMPT"] as const;
const paymentKinds = ["DEPOSIT", "PAYMENT"] as const;

const optionalText = (max = 500) => z.string().trim().max(max).nullable().optional();
const docType = z.enum(docTypes);
const docStatus = z.enum(docStatuses);

const lineSchema = z.object({
  id: z.string().cuid().optional(),
  source: z.enum(lineSources).default("CUSTOM"),
  sourceRefId: optionalText(120),
  description: z.string().trim().min(1).max(500),
  details: optionalText(1000),
  quantity: z.coerce.number().positive().max(1_000_000).default(1),
  unitLabel: optionalText(60),
  unitPrice: z.coerce.number().min(0).max(100_000_000),
  discount: z.coerce.number().min(0).max(100_000_000).default(0),
  taxRate: z.coerce.number().min(0).max(100).default(16),
  taxMode: z.enum(taxModes).default("INCLUSIVE"),
  taxTreatment: z.enum(taxTreatments).default("STANDARD"),
});

const documentSchema = z.object({
  type: docType,
  status: docStatus.optional(),
  customerId: z.string().cuid().nullable().optional(),
  prospectName: optionalText(120),
  prospectPhone: optionalText(40),
  prospectEmail: optionalText(120),
  prospectAddress: optionalText(1000),
  locationId: z.string().cuid().nullable().optional(),
  title: optionalText(140),
  intro: optionalText(2000),
  expiresAt: z.coerce.date().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  depositRequired: z.coerce.number().min(0).max(100_000_000).default(0),
  lines: z.array(lineSchema).min(1, "Add at least one line"),
});

const statusSchema = z.object({ status: docStatus });
const paymentSchema = z.object({
  kind: z.enum(paymentKinds).default("PAYMENT"),
  paymentMethodId: z.string().trim().min(1),
  amount: z.coerce.number().positive().max(100_000_000),
  reference: z.string().trim().max(120).nullable().optional(),
  note: optionalText(500),
  paidAt: z.coerce.date().optional(),
});

const include = {
  customer: true,
  location: true,
  sourceDocument: { select: { id: true, documentNo: true, type: true, status: true } },
  convertedDocuments: { select: { id: true, documentNo: true, type: true, status: true } },
  lines: { orderBy: { sortOrder: "asc" as const } },
  payments: { include: { paymentMethod: { select: { id: true, name: true, requiresReference: true } } }, orderBy: { paidAt: "asc" as const } },
} as const;

type Tx = typeof prisma;

export const commercialDocumentsRouter = Router();

function tenantId(req: { tenantId?: string }) {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
}

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function taxDefaults(tid: string) {
  const profile = await prisma.businessProfile.findUnique({ where: { tenantId: tid }, select: { taxRate: true, taxMode: true, taxTreatment: true } });
  return {
    taxRate: profile?.taxRate ?? 16,
    taxMode: profile?.taxMode ?? "INCLUSIVE",
    taxTreatment: profile?.taxTreatment ?? "STANDARD",
  } as const;
}

function computeLines(lines: z.infer<typeof lineSchema>[], fallback: Awaited<ReturnType<typeof taxDefaults>>) {
  const order = {
    discount: 0,
    items: lines.map((line) => ({
      quantity: line.quantity,
      unitPrice: Math.max(0, line.quantity * line.unitPrice - line.discount) / line.quantity,
      addons: [],
      taxRate: line.taxRate,
      taxMode: line.taxMode,
      taxTreatment: line.taxTreatment,
    })),
  };
  const financials = computeOrderFinancials(order, fallback);
  const computed = lines.map((line, index) => {
    const subtotal = round2(line.quantity * line.unitPrice);
    const effective = Math.max(0, subtotal - line.discount);
    const taxLine = financials.taxLineItems[index];
    return {
      ...line,
      lineSubtotal: subtotal,
      netAmount: taxLine?.net ?? effective,
      taxAmount: taxLine?.tax ?? 0,
      lineTotal: taxLine?.gross ?? effective,
      sortOrder: index,
    };
  });
  return { lines: computed, totals: financials };
}

function nextStatus(type: "QUOTATION" | "INVOICE", total: number, paid: number, dueAt: Date | null | undefined, current?: (typeof docStatuses)[number]): (typeof docStatuses)[number] {
  if (type === "QUOTATION") return current ?? "DRAFT";
  if (current === "VOID" || current === "CANCELLED" || current === "DRAFT") return current;
  if (paid >= total - 0.01) return "PAID";
  if (paid > 0.01) return "PARTIALLY_PAID";
  if (dueAt && dueAt < new Date()) return "OVERDUE";
  return current === "ISSUED" || current === "OVERDUE" ? current : "ISSUED";
}

async function headerFooter(type: "QUOTATION" | "INVOICE", locationId: string | null | undefined) {
  if (!locationId) return { headerText: null, footerText: null };
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { invoiceHeader: true, invoiceFooter: true, quotationHeader: true, quotationFooter: true } });
  return type === "INVOICE"
    ? { headerText: location?.invoiceHeader ?? null, footerText: location?.invoiceFooter ?? null }
    : { headerText: location?.quotationHeader ?? null, footerText: location?.quotationFooter ?? null };
}

async function validateDocument(tid: string, userId: string | undefined, data: z.infer<typeof documentSchema>) {
  const customerId = data.customerId ?? null;
  if (data.type === "INVOICE" && !customerId) return { error: "Choose a customer before creating an invoice" } as const;
  if (data.type === "QUOTATION" && !customerId && !data.prospectName?.trim()) return { error: "Choose a customer or enter the prospect name" } as const;
  if (customerId) {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: tid, status: { not: "BLOCKED" } }, select: { id: true } });
    if (!customer) return { error: "Choose a valid customer" } as const;
  }
  const resolved = await resolveEffectiveLocation(tid, userId, data.locationId ?? null);
  if ("error" in resolved) return resolved;
  return { location: resolved.location } as const;
}

async function refreshDocumentTotals(tx: Tx, documentId: string) {
  const doc = await tx.commercialDocument.findUniqueOrThrow({ where: { id: documentId }, include: { payments: true } });
  const paidAmount = round2(doc.payments.reduce((sum, p) => sum + Number(p.amount), 0));
  const balance = Math.max(0, round2(Number(doc.total) - paidAmount));
  const status = nextStatus(doc.type, Number(doc.total), paidAmount, doc.dueAt, doc.status);
  return tx.commercialDocument.update({
    where: { id: doc.id },
    data: { paidAmount, balance, status },
    include,
  });
}

commercialDocumentsRouter.get("/", async (req, res) => {
  const tid = tenantId(req);
  const query = z.object({
    type: docType.optional(),
    status: docStatus.optional(),
    search: z.string().trim().optional(),
  }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid query", details: query.error.flatten() }); return; }
  const { type, status, search } = query.data;
  const where = {
    tenantId: tid,
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
    ...(search ? {
      OR: [
        { documentNo: { contains: search, mode: "insensitive" as const } },
        { prospectName: { contains: search, mode: "insensitive" as const } },
        { customer: { is: { OR: [
          { firstName: { contains: search, mode: "insensitive" as const } },
          { lastName: { contains: search, mode: "insensitive" as const } },
          { businessName: { contains: search, mode: "insensitive" as const } },
        ] } } },
      ],
    } : {}),
  };
  const documents = await prisma.commercialDocument.findMany({ where, include, orderBy: { createdAt: "desc" } });
  const summary = {
    total: documents.length,
    value: round2(documents.reduce((sum, d) => sum + Number(d.total), 0)),
    paid: round2(documents.reduce((sum, d) => sum + Number(d.paidAmount), 0)),
    balance: round2(documents.reduce((sum, d) => sum + Number(d.balance), 0)),
    overdue: documents.filter((d) => d.status === "OVERDUE").length,
  };
  res.json({ documents, summary });
});

commercialDocumentsRouter.get("/options", async (req, res) => {
  const tid = tenantId(req);
  const [customers, locations, paymentMethods, tax] = await Promise.all([
    prisma.customer.findMany({ where: { tenantId: tid, status: { not: "BLOCKED" } }, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    prisma.location.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
    prisma.paymentMethod.findMany({ where: { tenantId: tid, isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    taxDefaults(tid),
  ]);
  res.json({ customers, locations, paymentMethods, tax });
});

commercialDocumentsRouter.get("/:id", async (req, res) => {
  const document = await prisma.commercialDocument.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include });
  if (!document) { res.status(404).json({ error: "Document not found" }); return; }
  res.json({ document });
});

commercialDocumentsRouter.post("/", async (req, res) => {
  const parsed = documentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid document", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const valid = await validateDocument(tid, req.userId, parsed.data);
  if ("error" in valid) { res.status(400).json({ error: valid.error }); return; }
  const fallback = await taxDefaults(tid);
  const computed = computeLines(parsed.data.lines, fallback);
  const docNo = parsed.data.type === "INVOICE" ? await nextInvoiceNo(tid) : await nextQuotationNo(tid);
  const locationId = valid.location?.id ?? null;
  const text = await headerFooter(parsed.data.type, locationId);
  const status = parsed.data.status ?? (parsed.data.type === "INVOICE" ? "DRAFT" : "DRAFT");
  const document = await prisma.commercialDocument.create({
    data: {
      tenantId: tid,
      documentNo: docNo,
      type: parsed.data.type,
      status,
      source: "MANUAL",
      customerId: parsed.data.customerId ?? null,
      prospectName: parsed.data.type === "QUOTATION" ? parsed.data.prospectName ?? null : null,
      prospectPhone: parsed.data.type === "QUOTATION" ? parsed.data.prospectPhone ?? null : null,
      prospectEmail: parsed.data.type === "QUOTATION" ? parsed.data.prospectEmail ?? null : null,
      prospectAddress: parsed.data.type === "QUOTATION" ? parsed.data.prospectAddress ?? null : null,
      locationId,
      title: parsed.data.title ?? null,
      intro: parsed.data.intro ?? null,
      expiresAt: parsed.data.expiresAt ?? null,
      dueAt: parsed.data.dueAt ?? null,
      depositRequired: parsed.data.type === "QUOTATION" ? parsed.data.depositRequired : 0,
      subtotal: computed.totals.subtotal,
      discount: computed.totals.discount,
      net: computed.totals.net,
      taxAmount: computed.totals.taxAmount,
      total: computed.totals.total,
      balance: computed.totals.total,
      headerText: text.headerText,
      footerText: text.footerText,
      createdBy: req.userId,
      updatedBy: req.userId,
      lines: {
        create: computed.lines.map((line) => ({
          tenantId: tid,
          source: line.source,
          sourceRefId: line.sourceRefId ?? null,
          description: line.description,
          details: line.details ?? null,
          quantity: line.quantity,
          unitLabel: line.unitLabel ?? null,
          unitPrice: line.unitPrice,
          discount: line.discount,
          taxRate: line.taxRate,
          taxMode: line.taxMode,
          taxTreatment: line.taxTreatment,
          lineSubtotal: line.lineSubtotal,
          netAmount: line.netAmount,
          taxAmount: line.taxAmount,
          lineTotal: line.lineTotal,
          sortOrder: line.sortOrder,
        })),
      },
    },
    include,
  });
  res.status(201).json({ document });
});

commercialDocumentsRouter.patch("/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.commercialDocument.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { payments: true } });
  if (!current) { res.status(404).json({ error: "Document not found" }); return; }
  if (!["DRAFT", "SENT", "ISSUED"].includes(current.status)) { res.status(409).json({ error: "Only draft/open documents can be edited" }); return; }
  if (current.payments.length) { res.status(409).json({ error: "Documents with payments cannot be edited; void and reissue instead" }); return; }
  const parsed = documentSchema.partial({ type: true, lines: true }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid document", details: parsed.error.flatten() }); return; }
  const merged = { ...current, ...parsed.data, type: current.type, lines: parsed.data.lines ?? [] } as z.infer<typeof documentSchema>;
  if (!parsed.data.lines) { res.status(400).json({ error: "Send the full document lines when editing" }); return; }
  const valid = await validateDocument(tid, req.userId, merged);
  if ("error" in valid) { res.status(400).json({ error: valid.error }); return; }
  const fallback = await taxDefaults(tid);
  const computed = computeLines(parsed.data.lines, fallback);
  const locationId = valid.location?.id ?? null;
  const text = await headerFooter(current.type, locationId);
  const document = await prisma.$transaction(async (tx) => {
    await tx.commercialDocumentLine.deleteMany({ where: { documentId: current.id, tenantId: tid } });
    await tx.commercialDocument.update({
      where: { id: current.id },
      data: {
        customerId: parsed.data.customerId ?? null,
        prospectName: current.type === "QUOTATION" ? parsed.data.prospectName ?? null : null,
        prospectPhone: current.type === "QUOTATION" ? parsed.data.prospectPhone ?? null : null,
        prospectEmail: current.type === "QUOTATION" ? parsed.data.prospectEmail ?? null : null,
        prospectAddress: current.type === "QUOTATION" ? parsed.data.prospectAddress ?? null : null,
        locationId,
        title: parsed.data.title ?? null,
        intro: parsed.data.intro ?? null,
        expiresAt: parsed.data.expiresAt ?? null,
        dueAt: parsed.data.dueAt ?? null,
        depositRequired: current.type === "QUOTATION" ? parsed.data.depositRequired ?? 0 : 0,
        subtotal: computed.totals.subtotal,
        discount: computed.totals.discount,
        net: computed.totals.net,
        taxAmount: computed.totals.taxAmount,
        total: computed.totals.total,
        balance: computed.totals.total,
        headerText: text.headerText,
        footerText: text.footerText,
        updatedBy: req.userId,
        lines: { create: computed.lines.map((line) => ({ tenantId: tid, source: line.source, sourceRefId: line.sourceRefId ?? null, description: line.description, details: line.details ?? null, quantity: line.quantity, unitLabel: line.unitLabel ?? null, unitPrice: line.unitPrice, discount: line.discount, taxRate: line.taxRate, taxMode: line.taxMode, taxTreatment: line.taxTreatment, lineSubtotal: line.lineSubtotal, netAmount: line.netAmount, taxAmount: line.taxAmount, lineTotal: line.lineTotal, sortOrder: line.sortOrder })) },
      },
    });
    return tx.commercialDocument.findUniqueOrThrow({ where: { id: current.id }, include });
  });
  res.json({ document });
});

commercialDocumentsRouter.post("/:id/status", async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid status", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const current = await prisma.commercialDocument.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Document not found" }); return; }
  const allowed = current.type === "QUOTATION"
    ? ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"]
    : ["DRAFT", "ISSUED", "CANCELLED", "VOID"];
  if (!allowed.includes(parsed.data.status)) { res.status(400).json({ error: `That status is not valid for ${current.type.toLowerCase()}s` }); return; }
  const now = new Date();
  const document = await prisma.commercialDocument.update({
    where: { id: current.id },
    data: {
      status: parsed.data.status,
      issuedAt: ["SENT", "ISSUED"].includes(parsed.data.status) ? (current.issuedAt ?? now) : current.issuedAt,
      acceptedAt: parsed.data.status === "ACCEPTED" ? (current.acceptedAt ?? now) : current.acceptedAt,
      updatedBy: req.userId,
    },
    include,
  });
  res.json({ document });
});

commercialDocumentsRouter.post("/:id/convert-to-invoice", async (req, res) => {
  const tid = tenantId(req);
  const quote = await prisma.commercialDocument.findFirst({ where: { id: req.params.id, tenantId: tid, type: "QUOTATION" }, include });
  if (!quote) { res.status(404).json({ error: "Quotation not found" }); return; }
  if (!quote.customerId) { res.status(400).json({ error: "Attach a customer before converting this quotation to an invoice" }); return; }
  const existing = quote.convertedDocuments.find((d) => d.type === "INVOICE");
  if (existing) { res.status(409).json({ error: `Already converted to ${existing.documentNo}` }); return; }
  const invoiceNo = await nextInvoiceNo(tid);
  const invoice = await prisma.$transaction(async (tx) => {
    const created = await tx.commercialDocument.create({
      data: {
        tenantId: tid,
        documentNo: invoiceNo,
        type: "INVOICE",
        status: "ISSUED",
        source: "QUOTATION",
        sourceDocumentId: quote.id,
        customerId: quote.customerId,
        locationId: quote.locationId,
        title: quote.title,
        intro: quote.intro,
        headerText: quote.location?.invoiceHeader ?? null,
        footerText: quote.location?.invoiceFooter ?? null,
        issuedAt: new Date(),
        dueAt: quote.dueAt,
        subtotal: quote.subtotal,
        discount: quote.discount,
        net: quote.net,
        taxAmount: quote.taxAmount,
        total: quote.total,
        paidAmount: quote.paidAmount,
        balance: quote.balance,
        createdBy: req.userId,
        updatedBy: req.userId,
        lines: { create: quote.lines.map((l) => ({ tenantId: tid, source: l.source, sourceRefId: l.sourceRefId, description: l.description, details: l.details, quantity: l.quantity, unitLabel: l.unitLabel, unitPrice: l.unitPrice, discount: l.discount, taxRate: l.taxRate, taxMode: l.taxMode, taxTreatment: l.taxTreatment, lineSubtotal: l.lineSubtotal, netAmount: l.netAmount, taxAmount: l.taxAmount, lineTotal: l.lineTotal, sortOrder: l.sortOrder })) },
      },
    });
    await tx.commercialDocument.update({ where: { id: quote.id }, data: { status: "CONVERTED", updatedBy: req.userId } });
    for (const p of quote.payments) {
      await tx.commercialDocumentPayment.create({
        data: { tenantId: tid, documentId: created.id, paymentNo: await nextCommercialDocumentPaymentNo(tid), kind: "DEPOSIT", paymentMethodId: p.paymentMethodId, amount: p.amount, reference: p.reference, note: `Deposit carried from ${quote.documentNo}`, paidAt: p.paidAt, createdBy: req.userId },
      });
    }
    return refreshDocumentTotals(tx as Tx, created.id);
  });
  res.status(201).json({ document: invoice });
});

commercialDocumentsRouter.post("/:id/payments", async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid payment", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const document = await prisma.commercialDocument.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { customer: true } });
  if (!document) { res.status(404).json({ error: "Document not found" }); return; }
  if (["CANCELLED", "VOID", "REJECTED", "EXPIRED"].includes(document.status)) { res.status(409).json({ error: "This document cannot receive payments" }); return; }
  if (document.type === "INVOICE" && document.status === "DRAFT") { res.status(409).json({ error: "Issue this invoice before recording payment" }); return; }
  const method = await prisma.paymentMethod.findFirst({ where: { id: parsed.data.paymentMethodId, tenantId: tid, isActive: true } });
  if (!method) { res.status(400).json({ error: "Choose an active payment method" }); return; }
  if (method.requiresReference && !parsed.data.reference) { res.status(400).json({ error: `${method.name} requires a reference code` }); return; }
  if (document.type === "INVOICE" && Number(document.balance) > 0 && parsed.data.amount > Number(document.balance) + 0.01) {
    res.status(400).json({ error: "Payment cannot exceed the invoice balance" }); return;
  }
  const paymentNo = await nextCommercialDocumentPaymentNo(tid);
  const transactionNo = await nextTransactionNo(tid);
  const updated = await prisma.$transaction(async (tx) => {
    const payment = await tx.commercialDocumentPayment.create({
      data: { tenantId: tid, documentId: document.id, paymentNo, kind: parsed.data.kind, paymentMethodId: method.id, amount: parsed.data.amount, reference: parsed.data.reference ?? null, note: parsed.data.note ?? null, paidAt: parsed.data.paidAt ?? new Date(), createdBy: req.userId },
    });
    const transaction = await tx.transaction.create({
      data: {
        tenantId: tid,
        transactionNo,
        direction: "IN",
        source: "COMMERCIAL_DOCUMENT_PAYMENT",
        amount: parsed.data.amount,
        paymentMethodId: method.id,
        reference: parsed.data.reference ?? null,
        customerId: document.customerId,
        locationId: document.locationId,
        employeeId: req.userId,
        description: `${document.documentNo} ${parsed.data.kind === "DEPOSIT" ? "deposit" : "payment"}`,
        sourceRefId: payment.id,
      },
    });
    await tx.commercialDocumentPayment.update({ where: { id: payment.id }, data: { transactionId: transaction.id } });
    return refreshDocumentTotals(tx as Tx, document.id);
  });
  res.status(201).json({ document: updated });
});
