import { prisma } from "./prisma.js";
import { nextTransactionNo } from "./sequence.js";
import { taxSettingsFor, orderInclude, applyOrderPayment } from "../modules/pos/pos.routes.js";
import { computeOrderFinancials } from "./orderTotals.js";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type StkOutcome = { resultCode: number; resultDesc: string; mpesaReceiptNumber?: string };

/** The one place an STK result (from the Safaricom callback, or the poll-time
 * query fallback) turns into a real payment — shared so the two paths can
 * never disagree about what "success" means. Idempotent: a request already
 * in a terminal state is left alone, since Safaricom can retry callbacks. */
export async function applyStkResult(requestId: string, outcome: StkOutcome): Promise<void> {
  const row = await prisma.mpesaStkRequest.findUnique({ where: { id: requestId } });
  if (!row || row.status !== "PENDING") return;

  if (outcome.resultCode !== 0) {
    const status = outcome.resultCode === 1032 ? "CANCELLED" : outcome.resultCode === 1037 || outcome.resultCode === 1019 ? "TIMEOUT" : "FAILED";
    await prisma.mpesaStkRequest.update({ where: { id: row.id }, data: { status, resultCode: outcome.resultCode, resultDesc: outcome.resultDesc } });
    return;
  }

  if (row.purpose !== "POS_ORDER") {
    // Reserved for phase 2 (folio deposits/settlement, group checkout, membership payments) — record the
    // success but don't fabricate a completion path for a purpose this build doesn't wire up yet.
    await prisma.mpesaStkRequest.update({ where: { id: row.id }, data: { status: "SUCCESS", resultCode: 0, resultDesc: outcome.resultDesc, mpesaReceiptNumber: outcome.mpesaReceiptNumber } });
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      const order = await tx.posOrder.findUniqueOrThrow({ where: { id: row.purposeRefId }, include: orderInclude });
      const tax = await taxSettingsFor(row.tenantId);
      const { total } = computeOrderFinancials(order, tax);
      const alreadyPaid = order.payments.reduce((s, p) => s + Number(p.amount), 0);
      const remaining = round2(total - alreadyPaid);
      // The order may have changed since the push was sent (another payment landed, it was cancelled...).
      // Cap at what's actually still owed rather than overpaying it.
      const amount = Math.min(Number(row.amount), Math.max(remaining, 0));
      if (amount <= 0) throw new Error("This order no longer has a balance to apply the payment to");
      const mpesaMethod = await tx.paymentMethod.findFirstOrThrow({ where: { tenantId: row.tenantId, code: "MPESA" } });
      const transactionNo = await nextTransactionNo(row.tenantId);
      await applyOrderPayment(tx, {
        tenantId: row.tenantId, order, total, alreadyPaid, paymentMethodId: mpesaMethod.id, amount,
        reference: outcome.mpesaReceiptNumber, employeeId: row.initiatedBy ?? undefined, transactionNo,
        description: `M-Pesa STK — order #${order.orderNumber}`,
      });
      await tx.mpesaStkRequest.update({ where: { id: row.id }, data: { status: "SUCCESS", resultCode: 0, resultDesc: outcome.resultDesc, mpesaReceiptNumber: outcome.mpesaReceiptNumber } });
    });
  } catch (error) {
    // The money DID arrive at Safaricom — never silently drop that. Record the receipt/result on the STK
    // row even though it couldn't be auto-applied, so a supervisor can see it and settle it by hand.
    await prisma.mpesaStkRequest.update({
      where: { id: row.id },
      data: { status: "SUCCESS", resultCode: 0, resultDesc: `Paid but could not auto-apply: ${error instanceof Error ? error.message : "unknown error"}`, mpesaReceiptNumber: outcome.mpesaReceiptNumber },
    });
  }
}
