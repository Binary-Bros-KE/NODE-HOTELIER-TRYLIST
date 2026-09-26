import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { hasPermission } from "../../middleware/tenantContext.js";
import { computeOrderFinancials } from "../../lib/orderTotals.js";
import { env } from "../../config/env.js";
import { initiateStkPush, normalizeMsisdn, describeResultCode, queryStkStatus, type MpesaCredentials } from "../../lib/mpesa.js";
import { applyStkResult } from "../../lib/mpesaStk.js";
import { resolveMpesaCredentials } from "../locations/locations.routes.js";
import { hasPendingReturnRequests, orderInclude, ownsOrder, taxSettingsFor } from "../pos/pos.routes.js";
import { hasPendingAdditions } from "../../lib/orderStock.js";

export const mpesaRouter = Router();

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function tenantId(req: { tenantId?: string }): string {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
}

function callbackUrl(): string {
  if (!env.MPESA_CALLBACK_BASE_URL) throw Object.assign(new Error("MPESA_CALLBACK_BASE_URL must be set to take M-Pesa payments (Safaricom needs a public callback URL for this server)"), { status: 500 });
  return `${env.MPESA_CALLBACK_BASE_URL.replace(/\/+$/, "")}/public/mpesa/callback`;
}

const stkSchema = z.object({
  phone: z.string().trim().min(9).max(15),
  amount: z.coerce.number().positive().optional(),
});

mpesaRouter.post("/stk/orders/:orderId", async (req, res, next) => {
  const parsed = stkSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Enter a valid phone number", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const [order, tax] = await Promise.all([
      prisma.posOrder.findFirst({ where: { id: req.params.orderId, tenantId: tid }, include: orderInclude }),
      taxSettingsFor(tid),
    ]);
    if (!order) { res.status(404).json({ error: "Order not found" }); return; }
    if (!order.locationId) { res.status(409).json({ error: "This order has no location, so M-Pesa can't be charged" }); return; }
    const isDebtPayment = order.status === "COMPLETED" && order.paymentStatus !== "PAID";
    if (isDebtPayment) {
      if (!(await hasPermission(tid, req.userId, "CREDIT_COLLECT"))) { res.status(403).json({ error: "You are not allowed to clear customer debts - ask the accountant or a manager" }); return; }
    } else if (!ownsOrder(order, req)) { res.status(403).json({ error: "You can only take payment on your own orders" }); return; }
    if (order.saleType === "COMPLIMENTARY") { res.status(409).json({ error: "Complimentary orders do not take payments" }); return; }
    if (hasPendingReturnRequests(order)) { res.status(409).json({ error: "Approve or reject the pending return before taking payment" }); return; }
    if (hasPendingAdditions(order)) { res.status(409).json({ error: "The kitchen hasn't handed over the items added to this order yet" }); return; }
    const payable = order.status === "SERVED" || isDebtPayment;
    if (!payable) { res.status(409).json({ error: order.status === "COMPLETED" ? "This order is already fully paid" : "The order must be served before it can be paid" }); return; }

    const { total } = computeOrderFinancials(order, tax);
    const alreadyPaid = order.payments.reduce((s, p) => s + Number(p.amount), 0);
    const remaining = round2(total - alreadyPaid);
    const amount = round2(parsed.data.amount ?? remaining);
    if (amount <= 0) { res.status(400).json({ error: "This order has nothing left to pay" }); return; }
    if (amount > remaining + 0.01) { res.status(400).json({ error: `Amount exceeds the remaining balance of ${remaining.toFixed(2)}` }); return; }

    const phone = normalizeMsisdn(parsed.data.phone);
    if (!phone) { res.status(400).json({ error: "Enter a valid Safaricom number, e.g. 0712345678" }); return; }

    const [creds, mpesaMethod] = await Promise.all([
      resolveMpesaCredentials(tid, order.locationId),
      prisma.paymentMethod.findFirst({ where: { tenantId: tid, code: "MPESA", isActive: true } }),
    ]);
    if (!creds) { res.status(409).json({ error: "M-Pesa isn't set up for this location yet - ask a supervisor to configure it under Locations" }); return; }
    if (!mpesaMethod) { res.status(409).json({ error: "No active M-Pesa payment method is set up for this property" }); return; }

    const stkRequest = await prisma.mpesaStkRequest.create({
      data: { tenantId: tid, locationId: order.locationId, purpose: "POS_ORDER", purposeRefId: order.id, phoneNumber: phone, amount, initiatedBy: req.userId },
    });
    try {
      const result = await initiateStkPush(creds as MpesaCredentials, {
        phone, amount, accountRef: `Order${order.orderNumber}`, description: `Order ${order.orderNumber}`.slice(0, 13), callbackUrl: callbackUrl(),
      });
      await prisma.mpesaStkRequest.update({ where: { id: stkRequest.id }, data: { merchantRequestId: result.merchantRequestId, checkoutRequestId: result.checkoutRequestId } });
    } catch (error) {
      await prisma.mpesaStkRequest.update({ where: { id: stkRequest.id }, data: { status: "FAILED", resultDesc: error instanceof Error ? error.message : "Could not reach Safaricom" } });
      res.status(502).json({ error: error instanceof Error ? error.message : "Could not send the STK push" });
      return;
    }
    res.status(201).json({ requestId: stkRequest.id });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

// Frontend polls this every few seconds while waiting for the customer to
// respond. Callbacks are usually fast, but not guaranteed — if one hasn't
// landed a few seconds after the push, nudge Safaricom's query endpoint
// ourselves rather than leaving the cashier staring at a spinner.
const QUERY_FALLBACK_AFTER_MS = 5000;

mpesaRouter.get("/stk/:requestId", async (req, res, next) => {
  const tid = tenantId(req);
  try {
    let row = await prisma.mpesaStkRequest.findFirst({ where: { id: req.params.requestId, tenantId: tid } });
    if (!row) { res.status(404).json({ error: "Request not found" }); return; }
    if (row.status === "PENDING" && row.checkoutRequestId && Date.now() - row.createdAt.getTime() > QUERY_FALLBACK_AFTER_MS) {
      const creds = await resolveMpesaCredentials(tid, row.locationId);
      if (creds) {
        const queried = await queryStkStatus(creds as MpesaCredentials, row.checkoutRequestId).catch(() => null);
        if (queried) await applyStkResult(row.id, { resultCode: queried.resultCode, resultDesc: queried.resultDesc });
      }
      row = await prisma.mpesaStkRequest.findUniqueOrThrow({ where: { id: row.id } });
    }
    res.json({
      status: row.status,
      resultDesc: row.status === "PENDING" ? null : row.resultCode != null ? describeResultCode(row.resultCode) : row.resultDesc,
      purpose: row.purpose,
      purposeRefId: row.purposeRefId,
    });
  } catch (error) {
    next(error);
  }
});
