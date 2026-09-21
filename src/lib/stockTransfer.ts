import type { Prisma } from "@prisma/client";

import { recordStockMovement } from "./stockLedger.js";

/**
 * Moves stock between two locations inside the caller's transaction and
 * records one StockTransfer with the frozen before/after balance at both ends
 * of every line. Shared by the Store page's "Distribute Stock" flow and the
 * kitchen dispatch approval, so both move stock identically through the ledger.
 *
 * The OUT side runs first (the guarded one), so an insufficient balance throws
 * InsufficientStockError before anything is credited to the destination.
 * `transferNo` is allocated by the caller (nextStockTransferNo) before opening
 * the transaction.
 */
export async function performStockTransfer(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    transferNo: string;
    fromLocationId: string;
    toLocationId: string;
    items: { productId: string; quantity: number; name?: string }[];
    note: string | null;
    ledgerNote: string;
    performedBy: string | null | undefined;
  },
) {
  const { tenantId, transferNo, fromLocationId, toLocationId, items, note, ledgerNote, performedBy } = args;
  const created = await tx.stockTransfer.create({
    data: { tenantId, transferNo, fromLocationId, toLocationId, note, createdBy: performedBy ?? null },
  });
  for (const item of items) {
    const out = await recordStockMovement(tx, {
      tenantId, productId: item.productId, locationId: fromLocationId, type: "TRANSFER_OUT",
      quantity: -item.quantity, note: ledgerNote, sourceType: "STOCK_TRANSFER", sourceRefId: created.id,
      performedBy: performedBy ?? null, label: item.name ?? "stock",
    });
    const into = await recordStockMovement(tx, {
      tenantId, productId: item.productId, locationId: toLocationId, type: "TRANSFER_IN",
      quantity: item.quantity, note: ledgerNote, sourceType: "STOCK_TRANSFER", sourceRefId: created.id,
      performedBy: performedBy ?? null,
    });
    await tx.stockTransferItem.create({
      data: {
        transferId: created.id,
        productId: item.productId,
        quantity: item.quantity,
        fromQtyBefore: out.balanceBefore ?? 0,
        fromQtyAfter: out.balanceAfter ?? 0,
        toQtyBefore: into.balanceBefore ?? 0,
        toQtyAfter: into.balanceAfter ?? 0,
      },
    });
  }
  return created;
}
