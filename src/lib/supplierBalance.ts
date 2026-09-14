import type { Prisma, SupplierBalanceEntryType } from "@prisma/client";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function recordSupplierBalanceEntry(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    supplierId: string;
    type: SupplierBalanceEntryType;
    amount: number;
    note?: string | null;
    purchaseId?: string | null;
    goodsReceiptId?: string | null;
    paymentId?: string | null;
    createdBy?: string | null;
  },
) {
  const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId }, select: { balance: true } });
  if (!supplier) throw new Error("Supplier not found");
  const balanceBefore = Number(supplier.balance);
  const amount = round2(input.amount);
  const balanceAfter = round2(balanceBefore + amount);
  await tx.supplier.update({ where: { id: input.supplierId }, data: { balance: balanceAfter } });
  return tx.supplierBalanceEntry.create({
    data: {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      type: input.type,
      amount,
      balanceBefore,
      balanceAfter,
      note: input.note ?? null,
      purchaseId: input.purchaseId ?? null,
      goodsReceiptId: input.goodsReceiptId ?? null,
      paymentId: input.paymentId ?? null,
      createdBy: input.createdBy ?? null,
    },
  });
}
