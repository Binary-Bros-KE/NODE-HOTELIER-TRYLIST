/**
 * Square 7 Lounge — second round of real selling prices, this time from the
 * BREAKAGES column (the client's actual per-unit price, confirmed against
 * AMOUNT = SALES x price wherever both were legible — that arithmetic check
 * is what most of these numbers are based on, not a direct read of a messy
 * breakage cell). Bracketed/grouped rows on the sheet (several Delmonte
 * flavours sharing one price, several sodas sharing one price) get that same
 * price applied to each item individually — the catalog still keeps them as
 * separate stock-tracked products, only the price is shared.
 *
 * Tots: per the client, every tot brand shares one flat rate — Single Tot
 * 200, Double Tot 400 (exactly double) — applied uniformly to all 13 tot
 * brands (the original 12 plus Jameson).
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

async function setDirectPrice(name, price) {
  if (price == null) return;
  const mi = await prisma.menuItem.findFirst({ where: { tenantId: tid, name }, include: { _count: { select: { variants: true } } } });
  if (!mi) { notFound.push(name); return; }
  if (mi._count.variants > 0) { mismatched.push(`${name}: expected direct price but has ${mi._count.variants} variants`); return; }
  await prisma.menuItem.update({ where: { id: mi.id }, data: { price } });
  applied.push(`${name} = KES ${price}`);
}
async function setVariantPrice(name, variantLabel, price) {
  if (price == null) return;
  const mi = await prisma.menuItem.findFirst({ where: { tenantId: tid, name }, include: { variants: true } });
  if (!mi) { notFound.push(name); return; }
  const variant = mi.variants.find((v) => v.name === variantLabel);
  if (!variant) { mismatched.push(`${name}: no variant named "${variantLabel}" (has: ${mi.variants.map((v) => v.name).join(", ")})`); return; }
  await prisma.menuItemVariant.update({ where: { id: variant.id }, data: { price } });
  applied.push(`${name} [${variantLabel}] = KES ${price}`);
}

// ================================================================= BEERS (bottle)
await setVariantPrice("Balozi", "Bottle", 250);
await setVariantPrice("Black Ice", "Bottle", 250);
await setDirectPrice("Desperados", 350); // bottle-only brand, no variants
await setVariantPrice("Guinness", "Bottle", 300);
await setDirectPrice("Guinness Smooth", 350);
await setVariantPrice("Heineken", "Bottle", 300);
await setDirectPrice("Heineken 0.0%", 350);
await setDirectPrice("Hunters Gold", 300);
await setDirectPrice("King Fisher", 350);
await setVariantPrice("Manyatta", "Bottle", 250);
await setVariantPrice("Pilsner", "Bottle", 350);
await setDirectPrice("Savannah Dry", 250);
await setDirectPrice("Savannah Lemon", 300);
await setVariantPrice("Smirnoff Ice Pineapple", "Bottle", 250);
// Tusker Lager/Malt/White Cap/White Cap Crisp bottle prices already set last
// round (250/300/280/300) and unchanged by this sheet — not re-applied.
// Jinco: this sheet reads more clearly than last time — correcting the
// earlier low-confidence 300 guess to 550.
await setDirectPrice("Jinco", 550);

// ================================================================= BEERS/RTD (can)
await setDirectPrice("Gordons Gin & Tonic", 300);
await setDirectPrice("Gordons Pink Gin & Tonic", 350);
await setDirectPrice("Guarana", 400);
await setVariantPrice("Pilsner", "Can", 300);
await setVariantPrice("Tusker Lager", "Can", 350);
await setVariantPrice("Tusker Malt", "Can", 350);

// ================================================================= SOFT DRINKS & JUICES
// Bracketed group on the sheet: these 5 Delmonte flavours share one price.
for (const flavour of ["Apple", "Mixed Berry", "Passion", "Pineapple", "Tropical"]) {
  await setDirectPrice(`Delmonte ${flavour}`, 350);
}
for (const flavour of ["Cranberry", "Mango"]) {
  await setDirectPrice(`Delmonte ${flavour}`, 100);
}
await setDirectPrice("Coke", 100);
// Bracketed group: Krest/Sprite/Stoney/Novida/Fanta Orange/Fanta Passion
// share one price on the sheet.
await setDirectPrice("Krest", 100);
await setDirectPrice("Sprite", 100);
await setDirectPrice("Stoney", 100);
await setDirectPrice("Novida", 100);
await setDirectPrice("Fanta Orange", 100);
await setDirectPrice("Fanta Passion", 100);
await setDirectPrice("Branded Water", 150);
await setVariantPrice("Lime Juice", "1.5 Litre", 300);
await setVariantPrice("Lime Juice", "500ml", 100);
await setDirectPrice("Lemonade", 300); // LOW CONFIDENCE — see report
await setDirectPrice("Red Bull", 100);
await setDirectPrice("Tonic Pet", 50); // LOW CONFIDENCE — unusually cheap, see report
await setDirectPrice("Minute Maid", 100);
await setDirectPrice("Soda Water", 200);
await setDirectPrice("Keringet Mineral Water", 250);

// ================================================================= CIGARETTES
await setDirectPrice("Double Switch", 40);
await setDirectPrice("Single Switch", 40);

// ================================================================= GIN / RUM / TEQUILA
await setDirectPrice("Hendricks", 3000);
await setDirectPrice("Tanqueray Sevilla", 4500);
await setDirectPrice("Tanqueray Dry", 4500);
await setDirectPrice("Beefeater", 3500);
await setDirectPrice("Bombay", 3500);
await setVariantPrice("Malibu", "700ml", 3500); // LOW CONFIDENCE — unusually high vs typical, see report
await setVariantPrice("Camino Gold", "750ml", 3500);
await setVariantPrice("Don Julio Blanco", "750ml", 9500);
await setDirectPrice("Don Julio Reposado", 10500);
// Camino Silver: the sheet's number for this row was indistinguishable from
// a stock figure -> not entered, see report.

// ================================================================= TOTS — flat rate across every brand
const TOT_BRANDS = [
  "Jack Daniels", "JW Black Label", "Camino Gold", "Camino Silver",
  "Jose Cuervo Gold", "Jose Cuervo Silver", "Don Julio Blanco",
  "Jagermeister", "Sheridans", "Gilbeys", "Smirnoff", "Malibu", "Jameson",
];
for (const brand of TOT_BRANDS) {
  await setVariantPrice(brand, "Single Tot (30ml)", 200);
  await setVariantPrice(brand, "Double Tot (60ml)", 400);
}

console.log(`Applied ${applied.length} prices:`);
for (const line of applied) console.log("  " + line);
if (mismatched.length) { console.log("\nMISMATCHES (schema assumption wrong, not applied):"); for (const m of mismatched) console.log("  ! " + m); }
if (notFound.length) console.log("\nNOT FOUND:", JSON.stringify(notFound));

await prisma.$disconnect();
