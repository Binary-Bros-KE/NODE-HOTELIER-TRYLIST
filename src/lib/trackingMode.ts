import type { Prisma } from "@prisma/client";

type Db = Pick<Prisma.TransactionClient, "product">;
type Requirements = Map<string, { quantity: number; name: string }>;

/**
 * A recipe deducts every ingredient on sale - and at a store-dispatch kitchen asks
 * the store for it - whatever the product's tracking setting. "Issued and used up"
 * and "Counted at close" only change what the storekeeper's Issue does with it;
 * they never keep a product out of a recipe (Omega #1730: Milk Pot's milk was
 * skipped, so the order needed nothing from the store and stuck). Every deduction,
 * reversal, availability check and dispatch request goes through here, so this is
 * the one place that would ever leave a product out.
 */
export async function perSaleRequirements(_db: Db, _tid: string, requirements: Requirements): Promise<Requirements> {
  return requirements;
}
