import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export function normalizePaymentReference(reference: string | null | undefined) {
  const trimmed = reference?.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

export async function assertPaymentReferenceUnused(
  db: Db,
  tenantId: string,
  reference: string | null | undefined,
  options: { excludeTransactionId?: string; label?: string } = {},
) {
  const normalized = normalizePaymentReference(reference);
  if (!normalized) return undefined;
  const existing = await db.transaction.findFirst({
    where: {
      tenantId,
      status: "COMPLETE",
      reference: { equals: normalized, mode: "insensitive" },
      ...(options.excludeTransactionId ? { id: { not: options.excludeTransactionId } } : {}),
    },
    select: { transactionNo: true },
  });
  if (existing) {
    const label = options.label ?? "Transaction code";
    throw Object.assign(new Error(`${label} ${normalized} has already been used on ${existing.transactionNo}`), { status: 400 });
  }
  return normalized;
}

export async function checkedPaymentReference(
  db: Db,
  tenantId: string,
  method: { name: string; requiresReference: boolean },
  reference: string | null | undefined,
  options: { excludeTransactionId?: string } = {},
) {
  const normalized = normalizePaymentReference(reference);
  if (method.requiresReference && !normalized) throw Object.assign(new Error(`${method.name} requires a reference number`), { status: 400 });
  if (!normalized) return undefined;
  return assertPaymentReferenceUnused(db, tenantId, normalized, options);
}
