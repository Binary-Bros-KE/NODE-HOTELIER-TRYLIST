import type { Prisma } from "@prisma/client";

type Numeric = Prisma.Decimal | number | string | null | undefined;

const num = (value: Numeric) => value == null ? null : Number(value);

export function stockQuantityToCostUnits(quantity: Numeric, packSize: Numeric): number {
  const qty = Number(quantity ?? 0);
  const pack = num(packSize);
  return pack && pack > 0 ? qty / pack : qty;
}

export function stockValue(quantity: Numeric, unitCost: Numeric, packSize: Numeric): number | null {
  const cost = num(unitCost);
  if (cost == null) return null;
  return stockQuantityToCostUnits(quantity, packSize) * cost;
}
