import { prisma } from "./prisma.js";

// Atomic per-tenant, per-key counter — safe under concurrent creates since
// this compiles to a single UPDATE ... SET "lastNumber" = "lastNumber" + 1
// at the DB level (or an INSERT on first use), not a read-then-write race
// like count()+1 would be. One TenantSequence row per (tenantId, key):
// "customer" backs Customer.customerNo, "reservation" backs
// Reservation.reservationNo, "folio" backs Folio.folioNo, and so on.
export async function nextSequenceNo(tenantId: string, key: string, prefix: string, padding: number): Promise<string> {
  const seq = await prisma.tenantSequence.upsert({
    where: { tenantId_key: { tenantId, key } },
    create: { tenantId, key, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });
  return `${prefix}-${String(seq.lastNumber).padStart(padding, "0")}`;
}

export async function nextCustomerNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "customer", "CUST", 6);
}

export async function nextReservationNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "reservation", "RES", 6);
}

export async function nextFolioNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "folio", "FOL", 6);
}

export async function nextGroupNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "reservationgroup", "GRP", 6);
}

export async function nextTransactionNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "transaction", "TXN", 6);
}

export async function nextExpenseNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "expense", "EXP", 6);
}

export async function nextLostFoundNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "lostfound", "LF", 6);
}

export async function nextHousekeepingTaskNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "housekeeping", "HK", 6);
}

export async function nextAssetNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "asset", "AST", 6);
}

export async function nextPurchaseNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "purchase", "PO", 6);
}

export async function nextRequisitionNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "requisition", "PR", 6);
}

export async function nextGoodsReceiptNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "goodsreceipt", "GRN", 6);
}

export async function nextSupplierPaymentNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "supplierpayment", "SPMT", 6);
}

export async function nextStockTransferNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "stocktransfer", "TRF", 6);
}

export async function nextStockReceiptNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "stockreceipt", "GRN", 6);
}

export async function nextPayslipNo(tenantId: string): Promise<string> {
  return nextSequenceNo(tenantId, "payslip", "PAY", 6);
}
