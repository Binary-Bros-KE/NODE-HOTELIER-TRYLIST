import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { applyStkResult } from "../../lib/mpesaStk.js";

/**
 * Public, unauthenticated M-Pesa STK callback — Safaricom posts the real
 * transaction outcome here, any time after the push was sent. Mounted before
 * tenantContext exactly like public-receipts.routes.ts: there's no tenant
 * header to read, so the request identifies itself entirely by Safaricom's
 * own globally-unique CheckoutRequestID (looked up against MpesaStkRequest).
 *
 * Always responds 200 with the exact shape Daraja expects, regardless of our
 * internal outcome — a non-200 or unexpected body makes Safaricom retry the
 * callback repeatedly, which we don't want.
 */
export const mpesaCallbackRouter = Router();

type StkCallbackItem = { Name: string; Value?: string | number };
type StkCallbackBody = {
  Body?: {
    stkCallback?: {
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      ResultCode?: number;
      ResultDesc?: string;
      CallbackMetadata?: { Item?: StkCallbackItem[] };
    };
  };
};

const ACK = { ResultCode: 0, ResultDesc: "Accepted" };

mpesaCallbackRouter.post("/callback", async (req, res) => {
  res.status(200).json(ACK); // acknowledge immediately; Safaricom doesn't need to wait on our processing
  try {
    const callback = (req.body as StkCallbackBody)?.Body?.stkCallback;
    if (!callback?.CheckoutRequestID || callback.ResultCode === undefined) return;
    const row = await prisma.mpesaStkRequest.findUnique({ where: { checkoutRequestId: callback.CheckoutRequestID }, select: { id: true } });
    if (!row) return; // unknown/stale request — nothing to update
    const items = callback.CallbackMetadata?.Item ?? [];
    const find = (name: string) => items.find((i) => i.Name === name)?.Value;
    const mpesaReceiptNumber = find("MpesaReceiptNumber") != null ? String(find("MpesaReceiptNumber")) : undefined;
    await applyStkResult(row.id, {
      resultCode: callback.ResultCode,
      resultDesc: callback.ResultDesc ?? "",
      mpesaReceiptNumber,
    });
  } catch {
    // Already acknowledged Safaricom above; a failure here just means the row stays PENDING and the
    // frontend's own query-fallback poll (mpesa.routes.ts) will pick it up on the next check.
  }
});
