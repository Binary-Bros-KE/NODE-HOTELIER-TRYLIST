import type { Prisma, StockMovementType } from "@prisma/client";
import { stockValue } from "./stockValuation.js";

// The single choke point for changing a product's stock. Every buy, sale,
// transfer, adjustment, loss — anything — goes through here so that:
//   * ProductStock stays the one live per-(product, location) balance, and
//   * the stock ledger (InventoryMovement) gets one immutable row with the
//     signed quantity, the balance before/after, and a cash value.
// There is deliberately no code path that writes InventoryMovement directly.

export class InsufficientStockError extends Error {
  status = 400;
  constructor(public readonly label: string) {
    super(`Not enough ${label} at this location for this movement`);
    this.name = "InsufficientStockError";
  }
}

type RecordStockMovementInput = {
  tenantId: string;
  productId: string;
  locationId: string;
  type: StockMovementType;
  /** Signed change: positive = stock in, negative = stock out. */
  quantity: number;
  /** Per commercial unit cost for the cash `value`. For pack-tracked stock,
   *  quantity is converted through product.packSize before costing. Falls
   *  back to the product's valuation `unitCost` when omitted. */
  unitCost?: number | null;
  note?: string | null;
  sourceType?: string | null;
  sourceRefId?: string | null;
  performedBy?: string | null;
  occurredAt?: Date;
  /** Allow the resulting balance to go below zero (kept false everywhere
   *  for now — every real caller guards its own stock first). */
  allowNegative?: boolean;
  /** Friendly noun for the "not enough X" error (usually the product name). */
  label?: string;
};

export async function recordStockMovement(tx: Prisma.TransactionClient, input: RecordStockMovementInput) {
  const {
    tenantId, productId, locationId, type, quantity,
    note = null, sourceType = null, sourceRefId = null, performedBy = null,
    occurredAt, allowNegative = false, label = "stock",
  } = input;

  const key = { tenantId_productId_locationId: { tenantId, productId, locationId } };

  let balanceAfter: number;
  if (quantity < 0 && !allowNegative) {
    // Guarded decrement — only succeeds if the location has enough on hand,
    // which also makes concurrent sales safe without an explicit lock.
    const dec = await tx.productStock.updateMany({
      where: { tenantId, productId, locationId, quantity: { gte: -quantity } },
      data: { quantity: { increment: quantity } },
    });
    if (!dec.count) throw new InsufficientStockError(label);
    const row = await tx.productStock.findUniqueOrThrow({ where: key, select: { quantity: true } });
    balanceAfter = Number(row.quantity);
  } else {
    const row = await tx.productStock.upsert({
      where: key,
      create: { tenantId, productId, locationId, quantity },
      update: { quantity: { increment: quantity } },
      select: { quantity: true },
    });
    balanceAfter = Number(row.quantity);
  }
  const balanceBefore = balanceAfter - quantity;

  let unitCost = input.unitCost ?? null;
  let packSize: Prisma.Decimal | number | null = null;
  if (unitCost == null) {
    const product = await tx.product.findUnique({ where: { id: productId }, select: { unitCost: true, packSize: true } });
    unitCost = product?.unitCost != null ? Number(product.unitCost) : null;
    packSize = product?.packSize ?? null;
  } else {
    const product = await tx.product.findUnique({ where: { id: productId }, select: { packSize: true } });
    packSize = product?.packSize ?? null;
  }
  const value = stockValue(Math.abs(quantity), unitCost, packSize);

  return tx.inventoryMovement.create({
    data: {
      tenantId,
      productId,
      locationId,
      type,
      quantity,
      balanceBefore,
      balanceAfter,
      unitCost: unitCost ?? undefined,
      value: value ?? undefined,
      note,
      sourceType,
      sourceRefId,
      performedBy: performedBy ?? undefined,
      occurredAt,
    },
  });
}
