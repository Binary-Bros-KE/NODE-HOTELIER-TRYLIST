/**
 * Square 7 Lounge — real selling prices, transcribed from the AMOUNT column
 * of the club's counter sheet (repurposed by staff to record price, not
 * daily sale revenue — confirmed by the SALES column being blank on nearly
 * every priced row). Sets MenuItem.price / MenuItemVariant.price ONLY —
 * Product.sellingPrice/unitCost are untouched (irrelevant to Products POS
 * now that sellsDirectly gates that, and this data is menu pricing anyway).
 *
 * Idempotent: safe to re-run, just overwrites with the same numbers.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "square7" } });
const tid = tenant.id;

const notFound = [];
const mismatched = [];
const applied = [];

/** For a brand with NO variants — sets MenuItem.price directly. Errors out
 * (logged, not thrown) if the brand actually has variants, since that would
 * mean the price belongs on one of them instead, not the item's own price. */
async function setDirectPrice(name, price) {
  if (price == null) return;
  const mi = await prisma.menuItem.findFirst({ where: { tenantId: tid, name }, include: { _count: { select: { variants: true } } } });
  if (!mi) { notFound.push(name); return; }
  if (mi._count.variants > 0) { mismatched.push(`${name}: expected direct price but has ${mi._count.variants} variants`); return; }
  await prisma.menuItem.update({ where: { id: mi.id }, data: { price } });
  applied.push(`${name} = KES ${price}`);
}

/** For a brand WITH variants — sets one variant's price by its label. */
async function setVariantPrice(name, variantLabel, price) {
  if (price == null) return;
  const mi = await prisma.menuItem.findFirst({ where: { tenantId: tid, name }, include: { variants: true } });
  if (!mi) { notFound.push(name); return; }
  const variant = mi.variants.find((v) => v.name === variantLabel);
  if (!variant) { mismatched.push(`${name}: no variant named "${variantLabel}" (has: ${mi.variants.map((v) => v.name).join(", ")})`); return; }
  await prisma.menuItemVariant.update({ where: { id: variant.id }, data: { price } });
  applied.push(`${name} [${variantLabel}] = KES ${price}`);
}

// ================================================================= COGNAC
await setDirectPrice("Martel VSOP", 16000);
await setVariantPrice("Martel VS", "700ml", 7500);
await setVariantPrice("Hennessy VS", "700ml", 8000);
await setVariantPrice("Hennessy VS", "1 Litre", 12000);
// Martel Blue Swift, Hennessy VSOP, Martel VS 1 Litre, Hennessy VS 350ml,
// Remy Martin VSOP: no amount on the sheet -> left at 0.

// ================================================================= WHISKEY
await setDirectPrice("All Season", 2000);
await setDirectPrice("Ballentines", 3500);
await setDirectPrice("Best Whiskey", 1800);
await setDirectPrice("Bulleit Bourbon", 6000);
await setDirectPrice("Chivas Regal 12yrs", 7000);
await setDirectPrice("Chivas Regal 18yrs", 7000);
await setDirectPrice("Grants Wood", 5000);
await setDirectPrice("Gentleman Jack", 9000);
await setDirectPrice("Glenfiddich 15yrs", 2300);
await setDirectPrice("Hamptons", 6000);
await setDirectPrice("Jack Daniels Fire", 4000);
await setDirectPrice("Jameson Black Barrel", 5000);
await setDirectPrice("J&B", 2500);
await setDirectPrice("Singleton 12yrs", 7000);
await setDirectPrice("Singleton 15yrs", 7000);
await setDirectPrice("Singleton 18yrs", 10000);
// LOW CONFIDENCE — relative pricing looks backwards (a smaller bottle
// priced higher than a bigger one of the same brand); flagged in the report.
await setVariantPrice("Jack Daniels", "1 Litre", 2500);
await setVariantPrice("Jack Daniels", "700ml", 6000);
await setVariantPrice("Jack Daniels", "350ml", 7000);
await setVariantPrice("John Barr Black", "750ml", 3500);
await setVariantPrice("Southern Comfort", "750ml", 3000);
await setVariantPrice("Vat 69", "750ml", 2250);
await setVariantPrice("Vat 69", "375ml", 1100);
await setVariantPrice("JW Black Label", "750ml", 3500);
await setVariantPrice("JW Black Label", "375ml", 3000);
await setVariantPrice("JW Red Label", "375ml", 1800);
// Everything else in Whiskey (Glenfiddich 12yrs, Jack Daniels Honey, Jameson
// x3 sizes/Black Barrel already priced above are separate — the *plain*
// Jameson variants, JW Double Black/Green Label/Gold Reserve/Blonde, John
// Barr Red, Monkey Shoulder, William Lawsons, JW Song of Fire/Ice, White
// Walker, Bond 7 both sizes, Famous Grouse, Grants both sizes, JW Black
// Label 1L/250ml, JW Red Label 1L/750ml, Vat 69 1L): no legible amount on
// this sheet -> left at 0, not entered.

// ================================================================= BEER (bottle only — no data for cans)
// LOW CONFIDENCE — this whole block was a small, blurry, rotated snippet;
// treat every number here as a starting point to verify, not a final price.
await setVariantPrice("Tusker Lager", "Bottle", 250);
await setVariantPrice("Tusker Malt", "Bottle", 300);
await setVariantPrice("White Cap", "Bottle", 280);
await setVariantPrice("White Cap Crisp", "Bottle", 300);
await setDirectPrice("Jinco", 300);
// Tusker Lite, Tusker Cider, Windhoek: illegible marks, not confident enough
// to enter -> left at 0.

console.log(`Applied ${applied.length} prices:`);
for (const line of applied) console.log("  " + line);
if (mismatched.length) { console.log("\nMISMATCHES (schema assumption wrong, not applied):"); for (const m of mismatched) console.log("  ! " + m); }
if (notFound.length) console.log("\nNOT FOUND:", JSON.stringify(notFound));

await prisma.$disconnect();
