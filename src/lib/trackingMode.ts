import type { Prisma } from "@prisma/client";

type Db = Pick<Prisma.TransactionClient, "product">;
type Requirements = Map<string, { quantity: number; name: string }>;

/**
 * A recipe deducts its ingredients like any sale, ISSUE_ONLY products included:
 * "issue only" only changes what the storekeeper's Issue does (used up on handover).
 * A dish sold through a recipe that uses milk deducts the milk - and at a
 * store-dispatch kitchen asks the store for it - like any other ingredient (Omega
 * #1730: Milk Pot needed nothing from the store and stuck). Only PERIODIC_COUNT
 * products, counted at the kitchen when the batch is done, are left out of every
 * deduction, reversal, availability check and dispatch request. Decided by the
 * product's own setting, never by its name or category.
 */
export async function perSaleRequirements(db: Db, tid: string, requirements: Requirements): Promise<Requirements> {
  if (requirements.size === 0) return requirements;
  const untracked = await db.product.findMany({
    where: { tenantId: tid, id: { in: [...requirements.keys()] }, trackingMode: "PERIODIC_COUNT" },
    select: { id: true },
  });
  if (untracked.length === 0) return requirements;
  const skip = new Set(untracked.map((p) => p.id));
  return new Map([...requirements].filter(([productId]) => !skip.has(productId)));
}
