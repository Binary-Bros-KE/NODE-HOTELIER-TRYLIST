import type { Prisma } from "@prisma/client";

type Db = Pick<Prisma.TransactionClient, "product">;
type Requirements = Map<string, { quantity: number; name: string }>;

/**
 * Recipe deductions only apply to products tracked per sale. A product set to
 * ISSUE_ONLY or PERIODIC_COUNT leaves a location by issue and count instead, so
 * its recipe lines are dropped from every deduction, reversal, availability
 * check and dispatch request. Decided by the product's own setting, never by
 * its name or category.
 */
export async function perSaleRequirements(db: Db, tid: string, requirements: Requirements): Promise<Requirements> {
  if (requirements.size === 0) return requirements;
  const untracked = await db.product.findMany({
    where: { tenantId: tid, id: { in: [...requirements.keys()] }, trackingMode: { not: "PER_SALE" } },
    select: { id: true },
  });
  if (untracked.length === 0) return requirements;
  const skip = new Set(untracked.map((p) => p.id));
  return new Map([...requirements].filter(([productId]) => !skip.has(productId)));
}
