/**
 * Square 7 Lounge — Wine page prices, from the AMOUNT column this time (no
 * SALES quantity is present anywhere on this page, so amount can't be
 * sales x price here — it's a direct per-bottle price, same convention as
 * the very first Cognac/Whiskey pass). The recurring "11" mark scattered
 * down the BREAKAGE column on this page is the same artifact seen on the
 * beer/soda pages before — not a real price, excluded.
 *
 * Also fixes a duplication bug from an earlier pass: "Nederburg" and
 * "Black Bird" were crossed out on the physical sheet and relabelled
 * "Expresso" / "Vanilla" — but I created those as brand-new separate items
 * instead of renaming the originals, leaving two rows for what's really one
 * product each. This merges them: keeps the ORIGINAL item (with its real
 * stock history) and just renames it, then deletes the empty duplicate.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "square7" } });
const tid = tenant.id;

// ============================================================ merge duplicates
async function mergeRenamedDuplicate(originalName, newName) {
  const original = await prisma.menuItem.findFirst({ where: { tenantId: tid, name: originalName }, include: { product: true } });
  const duplicate = await prisma.menuItem.findFirst({ where: { tenantId: tid, name: newName }, include: { product: true } });
  if (!original) { console.log(`  ! original "${originalName}" not found — nothing to merge`); return; }
  if (!duplicate) { console.log(`  = no duplicate "${newName}" found — already clean`); return; }

  // Move the original's real stock (if any) onto itself under the new name;
  // the duplicate's product never had stock recorded (created fresh, empty).
  await prisma.menuItem.update({ where: { id: original.id }, data: { name: newName } });
  if (original.productId) await prisma.product.update({ where: { id: original.productId }, data: { name: `${newName} 750ml` } });

  // The duplicate's product carries no stock/history — safe to delete both.
  await prisma.menuItem.delete({ where: { id: duplicate.id } });
  if (duplicate.productId) await prisma.product.delete({ where: { id: duplicate.productId } }).catch(() => {});
  console.log(`  merged "${originalName}" -> "${newName}" (deleted the empty duplicate)`);
}
console.log("=== Merging renamed duplicates ===");
await mergeRenamedDuplicate("Nederburg", "Expresso");
await mergeRenamedDuplicate("Black Bird", "Vanilla");

// ============================================================ prices
console.log("\n=== Applying wine prices ===");
async function setDirectPrice(name, price) {
  const mi = await prisma.menuItem.findFirst({ where: { tenantId: tid, name } });
  if (!mi) { console.log(`  ! not found: ${name}`); return; }
  await prisma.menuItem.update({ where: { id: mi.id }, data: { price } });
  console.log(`  ${name} = KES ${price}`);
}
await setDirectPrice("4th Street Red", 1500);
await setDirectPrice("4th Street White", 1500);
await setDirectPrice("Asconi", 3500);
await setDirectPrice("Casa Buena Red", 1500);
await setDirectPrice("Casa Buena White", 1200);
await setDirectPrice("Drostdy Hof Red", 1500);
await setDirectPrice("Robertson Red", 2500);
await setDirectPrice("Rosso Nobile Cherry", 1500);
await setDirectPrice("Expresso", 1500);
await setDirectPrice("Mucho Mas", 1500);
await setDirectPrice("Lolie White", 2500);
// NOT entered — see report: Caprice Red/White Sweet/Dry, Cellar Cask Red/
// White, Chamdor Red/White, Drostdy Hof White, Four Cousins Red/White,
// Robertson White, Rosso Chocolate, Hamsini Red/White, Lolie Red (all just
// showed the "11" artifact, no real amount) — and the whole bottom cluster
// (Vanilla, Belaire Rose, Belaire Gold, Moet Brut, Lex, Fragrance,
// Strawberry Lips), where several amounts sit stacked close together the
// same way the Jack Daniels ones did — too much row-shift risk to guess.

await prisma.$disconnect();
