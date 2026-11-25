/**
 * Square 7 Lounge — the club's back-of-house STORE stock (a separate
 * physical location from the Bar Counter, using the same blank sheet
 * template but with only the OPENING STOCK column filled in — this is a
 * warehouse snapshot, not a daily counter log). Written to this tenant's
 * existing "Main Store" location, entirely separate from "Bar Counter" —
 * no double counting, ProductStock is already per (product, location).
 *
 * Two sections were NOT entered: the CANS block and the tail of BEERS,
 * where the handwritten numbers overlap too much to read with any real
 * confidence — see the report for exactly which rows and why.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "square7" } });
const tid = tenant.id;
const mainStore = await prisma.location.findFirstOrThrow({ where: { tenantId: tid, name: "Main Store" } });
console.log(`Tenant: ${tenant.name} — location: ${mainStore.name}`);

async function upsertCategory(scope, name) {
  const existing = await prisma.category.findFirst({ where: { tenantId: tid, scope, parentId: null, name } });
  if (existing) return existing;
  return prisma.category.create({ data: { tenantId: tid, scope, name, parentId: null, level: 1 } });
}
function menuCat(name) {
  return prisma.menuCategory.upsert({ where: { tenantId_name: { tenantId: tid, name } }, update: {}, create: { tenantId: tid, name } });
}
async function ensureProduct({ name, categoryId, packSize, unit }) {
  const existing = await prisma.product.findFirst({ where: { tenantId: tid, name } });
  if (existing) return existing;
  const mlUnit = packSize ? await prisma.unitOfMeasure.findFirstOrThrow({ where: { tenantId: tid, name: "Millilitres" } }) : null;
  return prisma.product.create({ data: { tenantId: tid, categoryId, name, unit: unit ?? "Bottle", packSize: packSize ?? null, packUnitId: mlUnit?.id ?? null, packLabel: packSize ? "Bottle" : null, unitCost: 0, sellingPrice: 0 } });
}
async function newSizedItem(storeCategory, menuCategory, name, sizes) {
  const existing = await prisma.menuItem.findFirst({ where: { tenantId: tid, name } });
  if (existing) return existing;
  const cat = await upsertCategory("STORE", storeCategory);
  const legacyCat = await upsertCategory("BAR", storeCategory);
  const mc = await menuCat(menuCategory);
  const menuItem = await prisma.menuItem.create({ data: { tenantId: tid, name, menuCategoryId: mc.id, categoryId: legacyCat.id, price: 0 } });
  let sort = 0;
  for (const { label, ml } of sizes) {
    const product = await ensureProduct({ name: `${name} ${label}`, categoryId: cat.id, packSize: ml });
    await prisma.menuItemVariant.create({ data: { tenantId: tid, menuItemId: menuItem.id, name: label, price: 0, stockProductId: product.id, stockQtyPerUnit: ml, sortOrder: sort++ } });
  }
  const barCounter = await prisma.location.findFirst({ where: { tenantId: tid, name: "Bar Counter" } });
  if (barCounter) await prisma.menuItem.update({ where: { id: menuItem.id }, data: { locations: { connect: { id: barCounter.id } } } });
  console.log(`  + new item: ${name} (${sizes.map((s) => s.label).join("/")})`);
  return menuItem;
}
async function newSimpleItem(storeCategory, menuCategory, name, size, ml) {
  const existing = await prisma.menuItem.findFirst({ where: { tenantId: tid, name } });
  if (existing) return existing;
  const cat = await upsertCategory("STORE", storeCategory);
  const legacyCat = await upsertCategory("BAR", storeCategory);
  const mc = await menuCat(menuCategory);
  const product = await ensureProduct({ name: `${name} ${size}`, categoryId: cat.id, packSize: ml });
  const menuItem = await prisma.menuItem.create({ data: { tenantId: tid, name, menuCategoryId: mc.id, categoryId: legacyCat.id, price: 0, productId: product.id, stockQtyPerUnit: ml ?? 1 } });
  const barCounter = await prisma.location.findFirst({ where: { tenantId: tid, name: "Bar Counter" } });
  if (barCounter) await prisma.menuItem.update({ where: { id: menuItem.id }, data: { locations: { connect: { id: barCounter.id } } } });
  console.log(`  + new item: ${name} ${size}`);
  return menuItem;
}

console.log("\n=== New products this page revealed ===");
await newSimpleItem("Herbal Liqueurs", "Liqueurs", "Bols Amsterdam", "750ml", 750);
await newSizedItem("Rum & Cane Spirits", "Rum & Spirits", "Kenya Cane Pineapple", [{ label: "750ml", ml: 750 }, { label: "250ml", ml: 250 }]);

// -------------------------------------------------------------- real stock
console.log("\n=== Applying Main Store stock ===");
const missing = [];
const applied = [];
async function setStoreStock(productName, count) {
  if (!count) return;
  const product = await prisma.product.findFirst({ where: { tenantId: tid, name: productName } });
  if (!product) { missing.push(productName); return; }
  const qty = count * Number(product.packSize ?? 1);
  await prisma.productStock.upsert({
    where: { tenantId_productId_locationId: { tenantId: tid, productId: product.id, locationId: mainStore.id } },
    update: { quantity: qty },
    create: { tenantId: tid, productId: product.id, locationId: mainStore.id, quantity: qty },
  });
  await prisma.inventoryMovement.create({
    data: { tenantId: tid, productId: product.id, locationId: mainStore.id, type: "OPENING_STOCK", quantity: qty, balanceBefore: 0, balanceAfter: qty, note: "Real Main Store stock count from the club's physical store sheet, entered 2026-09-15" },
  });
  applied.push(productName);
}

// ---- Cognac + Whiskey (All Season -> Bond 7 375ml) — LOW CONFIDENCE OVERALL,
// this whole page was rotated and dense; treat every number here as a
// starting point to spot-check, not a final figure.
await setStoreStock("Martel Blue Swift 700ml", 1);
await setStoreStock("Martel VSOP 700ml", 1);
await setStoreStock("Martel VS 700ml", 1);
await setStoreStock("Martel VS 1 Litre", 1);
await setStoreStock("Hennessy VSOP 700ml", 1);
await setStoreStock("Hennessy VS 700ml", 1);
await setStoreStock("Hennessy VS 350ml", 1);
await setStoreStock("Hennessy VS 1 Litre", 1);
await setStoreStock("Remy Martin VSOP 1 Litre", 1);
await setStoreStock("All Season 750ml", 1);
await setStoreStock("Ballentines 750ml", 1);
await setStoreStock("Bond 7 750ml", 4);
await setStoreStock("Bond 7 375ml", 6);
await setStoreStock("Best Whiskey 750ml", 4);
await setStoreStock("Black & White 750ml", 1);
await setStoreStock("Black & White 375ml", 1);
await setStoreStock("Chivas Regal 12yrs 1 Litre", 1);
await setStoreStock("Chivas Regal 18yrs 750ml", 1);
await setStoreStock("Famous Grouse 750ml", 2);
await setStoreStock("Grants 1 Litre", 3);
await setStoreStock("Grants 750ml", 4);
await setStoreStock("Grants Wood 750ml", 2);
await setStoreStock("Gentleman Jack 1 Litre", 1);
await setStoreStock("Glenfiddich 12yrs 750ml", 1);
await setStoreStock("Glenfiddich 15yrs 750ml", 10);
await setStoreStock("Hamptons 750ml", 11);
await setStoreStock("Jack Daniels 1 Litre", 1);
await setStoreStock("Jack Daniels 700ml", 1);
await setStoreStock("Jack Daniels 350ml", 1);
await setStoreStock("Jack Daniels Honey 1 Litre", 3);
await setStoreStock("Jack Daniels Fire 1 Litre", 1);
await setStoreStock("Jameson 1 Litre", 1);
await setStoreStock("Jameson 750ml", 1);
await setStoreStock("Jameson 350ml", 1);
await setStoreStock("Jameson Black Barrel 750ml", 3);
await setStoreStock("J&B 750ml", 1);
await setStoreStock("JW Black Label 1 Litre", 1);
await setStoreStock("JW Black Label 750ml", 7);
await setStoreStock("JW Black Label 375ml", 4);
await setStoreStock("JW Black Label 250ml", 4);
await setStoreStock("JW Red Label 1 Litre", 1);
await setStoreStock("JW Red Label 750ml", 1);
await setStoreStock("JW Red Label 375ml", 1);
await setStoreStock("JW Song of Fire 750ml", 2);
await setStoreStock("JW Song of Ice 750ml", 1);
await setStoreStock("JW White Walker 750ml", 1);
// Bulleit Bourbon: no legible number -> 0, not entered.

// ---- "JW Double Black" through "JW Blonde": every row on this page was a
// clear dash -> the store holds NONE of these (all sold through / out at
// the counter). Nothing to write (0 is already the default).

// ---- Wine + Champagne
await setStoreStock("4th Street White 750ml", 7);
await setStoreStock("Asconi 750ml", 4);
await setStoreStock("Casa Buena Red 1 Litre", 3); // LOW CONFIDENCE (tally-style mark)
await setStoreStock("Casa Buena White 1 Litre", 10);
await setStoreStock("Caprice Red Sweet 1 Litre", 6);
await setStoreStock("Caprice Red Dry 1 Litre", 3); // LOW CONFIDENCE — a crossed-out "10" replaced with this
await setStoreStock("Caprice White Dry 1 Litre", 9);
await setStoreStock("Cellar Cask White 750ml", 2);
await setStoreStock("Chamdor White 750ml", 3); // LOW CONFIDENCE
await setStoreStock("Drostdy Hof Red 750ml", 4);
await setStoreStock("Drostdy Hof White 750ml", 6);
await setStoreStock("Four Cousins Red 750ml", 11);
await setStoreStock("Four Cousins White 750ml", 1);
await setStoreStock("Robertson Red 750ml", 1);
await setStoreStock("Rosso Chocolate 750ml", 2); // LOW CONFIDENCE — may belong to the row below instead
await setStoreStock("Lolie Red 750ml", 3);
await setStoreStock("Moet Brut 750ml", 1);
// Everything else on these two sections read as a clear dash -> 0.

// ---- Liqueurs / Herbal Liqueurs / Vodka / Brandy
await setStoreStock("Baileys 750ml", 4);
await setStoreStock("Jagermeister 700ml", 3);
await setStoreStock("Bols Amsterdam 750ml", 1); // new
await setStoreStock("Smirnoff 750ml", 10);
await setStoreStock("Smirnoff 350ml", 15);
await setStoreStock("Richot 750ml", 6);
await setStoreStock("Viceroy 375ml", 7);
await setStoreStock("County 750ml", 8);

// ---- Rum & Cane Spirits / Tequila
await setStoreStock("Kenya Cane Pineapple 750ml", 6); // new — annotated "Pineapple" next to Kenya Cane 750ml
await setStoreStock("Kenya Cane Pineapple 250ml", 6); // new — annotated "Pineapple" next to Kenya Cane 250ml
await setStoreStock("Camino Silver 750ml", 1);

// ---- Gin
await setStoreStock("Gilbeys 750ml", 3);
await setStoreStock("Gilbeys 350ml", 9); // LOW CONFIDENCE
await setStoreStock("Tanqueray Dry 750ml", 3);
await setStoreStock("Beefeater 750ml", 1);

// ---- Beers (bottles only — the CANS block and part of this section were
// too ambiguous, see report; these are the ones read with reasonable
// confidence)
await setStoreStock("Black Ice Bottle", 36);
await setStoreStock("Desperados Bottle", 8);
await setStoreStock("Guinness Bottle", 25);
await setStoreStock("Heineken 0.0% Bottle", 12);
await setStoreStock("Heineken Bottle", 24);
await setStoreStock("Hunters Dry Bottle", 12);
await setStoreStock("Hunters Gold Bottle", 36);
await setStoreStock("Pilsner Bottle", 24);
await setStoreStock("Savannah Dry Bottle", 24);
await setStoreStock("Savannah Lemon Bottle", 25);
await setStoreStock("Tusker Lager Bottle", 50);
await setStoreStock("Tusker Malt Bottle", 25);
// Balozi Bottle: overlapping "29/24" -> NOT entered, see report.
// King Fisher, KO, Manyatta: read as dash -> 0.
// Tusker Lite/Cider, Windhoek, White Cap, White Cap Crisp, Tusker Ndimu:
// tiny marks that could be "1" or a dash -> NOT entered, LOW CONFIDENCE.

// ---- Soft Drinks & Juices
await setStoreStock("Branded Water Bottle", 108);
await setStoreStock("Coke Bottle", 264);
await setStoreStock("Krest Bottle", 96);
await setStoreStock("Sprite Bottle", 248);
await setStoreStock("Stoney Bottle", 168);
await setStoreStock("Novida Bottle", 96);
await setStoreStock("Fanta Orange Bottle", 96);
await setStoreStock("Fanta Passion Bottle", 48);
await setStoreStock("Fanta Blackcurrant Bottle", 24);
await setStoreStock("Lime Juice 1.5 Litre", 4);
await setStoreStock("Red Bull Bottle", 24);
await setStoreStock("Minute Maid Bottle", 40);
await setStoreStock("Dasani Water 500ml", 12);
await setStoreStock("Soda Water Bottle", 48);
await setStoreStock("Keringet Mineral Water Bottle", 48);
await setStoreStock("Keringet Sparkling Water Bottle", 12);
await setStoreStock("Predator Bottle", 12);

// ---- Cigarettes
await setStoreStock("Double Switch Pack", 40);
// Everything else on Cigarettes, all of Medicine, and all of Tots: blank on
// this sheet -> 0 (tots especially make sense: they're poured fresh at the
// counter, the store wouldn't hold a "tot reservoir").

console.log(`\nApplied Main Store stock to ${applied.length} products.`);
if (missing.length) console.log("NOT FOUND (check spelling/category):", JSON.stringify(missing));

const [stockCount, prodCount] = await Promise.all([
  prisma.productStock.count({ where: { tenantId: tid, locationId: mainStore.id } }),
  prisma.product.count({ where: { tenantId: tid } }),
]);
console.log(`\nMain Store now carries ${stockCount} products (tenant total products: ${prodCount}).`);
await prisma.$disconnect();
