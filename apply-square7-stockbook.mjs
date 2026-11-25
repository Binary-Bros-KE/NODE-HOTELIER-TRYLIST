/**
 * Square 7 Lounge — apply the club's real physical stock book (2026-09-15).
 *
 * Three phases, in order:
 *  1. Zero every price/cost (Product.unitCost/sellingPrice, MenuItem.price,
 *     MenuItemVariant.price) — client's own tracking convention going
 *     forward: 0 = "not yet set for real", non-zero = "confirmed real value".
 *  2. Corrections + brand-new items the stock book revealed: a size-label
 *     fix (Smirnoff 375ml -> 350ml), a cosmetic rename (Gordons cans), a new
 *     size added to an existing single-size brand (Captain Morgan 250ml —
 *     converts that MenuItem from a direct product link to variants), a new
 *     13th tot brand (Jameson), and several brand-new products the club
 *     added by hand in the margins.
 *  3. Real opening stock, transcribed from the counter sheet's CLOSING STOCK
 *     column (the physically-verified count) — bottle/can/unit counts are
 *     converted to the ml this system tracks via each product's own
 *     packSize (bottleCount * packSize), tots via a 30ml-per-unit assumption
 *     (the sheet doesn't distinguish single/double, so each counted "tot"
 *     unit is treated as one Single Tot's worth held in the reservoir).
 *
 * Idempotent for phases 2 (skips anything already migrated) and 3 (upserts
 * ProductStock, so re-running just overwrites with the same numbers) — NOT
 * idempotent for phase 1 in the sense that re-running always re-zeroes
 * prices, which is exactly what you'd want if you re-run this after fixing
 * a transcription error.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "square7" } });
const tid = tenant.id;
const barCounter = await prisma.location.findFirstOrThrow({ where: { tenantId: tid, name: "Bar Counter" } });
console.log(`Tenant: ${tenant.name} — location: ${barCounter.name}`);

const mlUnit = await prisma.unitOfMeasure.findFirstOrThrow({ where: { tenantId: tid, name: "Millilitres" } });

// ==================================================================== PHASE 1: zero all prices
console.log("\n=== Phase 1: zero prices/costs ===");
const r1 = await prisma.product.updateMany({ where: { tenantId: tid }, data: { unitCost: 0, sellingPrice: 0 } });
const r2 = await prisma.menuItem.updateMany({ where: { tenantId: tid }, data: { price: 0 } });
const r3 = await prisma.menuItemVariant.updateMany({ where: { tenantId: tid }, data: { price: 0 } });
console.log(`  Products zeroed: ${r1.count}, MenuItems zeroed: ${r2.count}, Variants zeroed: ${r3.count}`);

// ==================================================================== PHASE 2: corrections + new items
console.log("\n=== Phase 2: corrections and new items from the sheet ===");

async function renameProductAndVariant(oldProductName, newProductName, newPackSize, menuItemName, oldVariantName, newVariantName) {
  const product = await prisma.product.findFirst({ where: { tenantId: tid, name: oldProductName } });
  if (!product) { console.log(`  ! rename skipped, not found: ${oldProductName}`); return; }
  if (product.name === newProductName) { console.log(`  = already renamed: ${newProductName}`); return; }
  await prisma.product.update({ where: { id: product.id }, data: { name: newProductName, packSize: newPackSize } });
  const menuItem = await prisma.menuItem.findFirst({ where: { tenantId: tid, name: menuItemName } });
  if (menuItem) {
    await prisma.menuItemVariant.updateMany({
      where: { tenantId: tid, menuItemId: menuItem.id, name: oldVariantName },
      data: { name: newVariantName, stockQtyPerUnit: newPackSize },
    });
  }
  console.log(`  renamed ${oldProductName} -> ${newProductName}`);
}
// Client corrected the label on the physical bottle: 375ml -> 350ml.
await renameProductAndVariant("Smirnoff 375ml", "Smirnoff 350ml", 350, "Smirnoff", "375ml", "350ml");

async function renameSimple(oldName, newName) {
  const product = await prisma.product.findFirst({ where: { tenantId: tid, name: oldName } });
  const menuItem = await prisma.menuItem.findFirst({ where: { tenantId: tid, name: oldName.replace(/ (Bottle|Can)$/, "") } });
  if (product) await prisma.product.update({ where: { id: product.id }, data: { name: newName } });
  if (menuItem) await prisma.menuItem.update({ where: { id: menuItem.id }, data: { name: newName.replace(/ (Bottle|Can)$/, "") } });
  if (product || menuItem) console.log(`  renamed "${oldName}" -> "${newName}"`);
}
// Drop the redundant "(Can)" in the brand name — the "Can" pour label already says that.
await renameSimple("Gordons Gin & Tonic (Can) Can", "Gordons Gin & Tonic Can");
await renameSimple("Gordons Pink Gin & Tonic (Can) Can", "Gordons Pink Gin & Tonic Can");

async function upsertCategory(scope, name) {
  const existing = await prisma.category.findFirst({ where: { tenantId: tid, scope, parentId: null, name } });
  if (existing) return existing;
  return prisma.category.create({ data: { tenantId: tid, scope, name, parentId: null, level: 1 } });
}
function menuCat(name) {
  return prisma.menuCategory.upsert({ where: { tenantId_name: { tenantId: tid, name } }, update: {}, create: { tenantId: tid, name } });
}
async function ensureProduct({ name, categoryId, unit, packSize }) {
  const existing = await prisma.product.findFirst({ where: { tenantId: tid, name } });
  if (existing) return existing;
  return prisma.product.create({ data: { tenantId: tid, categoryId, name, unit, packSize: packSize ?? null, packUnitId: packSize ? mlUnit.id : null, packLabel: packSize ? "Bottle" : null, unitCost: 0, sellingPrice: 0 } });
}

// New brand-new items the club added by hand in the margins.
async function newSimpleItem(storeCategory, menuCategory, name, label, ml) {
  const existing = await prisma.menuItem.findFirst({ where: { tenantId: tid, name } });
  if (existing) { console.log(`  = already exists: ${name}`); return; }
  const cat = await upsertCategory("STORE", storeCategory);
  const legacyCat = await upsertCategory("BAR", storeCategory);
  const mc = await menuCat(menuCategory);
  const product = await ensureProduct({ name: `${name} ${label}`, categoryId: cat.id, unit: ml ? "Bottle" : label, packSize: ml });
  const menuItem = await prisma.menuItem.create({ data: { tenantId: tid, name, menuCategoryId: mc.id, categoryId: legacyCat.id, price: 0, productId: product.id, stockQtyPerUnit: ml ?? 1 } });
  await prisma.menuItem.update({ where: { id: menuItem.id }, data: { locations: { connect: { id: barCounter.id } } } });
  console.log(`  + new item: ${name} (${label})`);
}
// New flavour line, two sizes -> variants (a genuine multi-size brand, not a simple item).
async function newSizedItem(storeCategory, menuCategory, name, sizes) {
  const existing = await prisma.menuItem.findFirst({ where: { tenantId: tid, name } });
  if (existing) { console.log(`  = already exists: ${name}`); return; }
  const cat = await upsertCategory("STORE", storeCategory);
  const legacyCat = await upsertCategory("BAR", storeCategory);
  const mc = await menuCat(menuCategory);
  const menuItem = await prisma.menuItem.create({ data: { tenantId: tid, name, menuCategoryId: mc.id, categoryId: legacyCat.id, price: 0 } });
  let sort = 0;
  for (const { label, ml } of sizes) {
    const product = await ensureProduct({ name: `${name} ${label}`, categoryId: cat.id, unit: "Bottle", packSize: ml });
    await prisma.menuItemVariant.create({ data: { tenantId: tid, menuItemId: menuItem.id, name: label, price: 0, stockProductId: product.id, stockQtyPerUnit: ml, sortOrder: sort++ } });
  }
  await prisma.menuItem.update({ where: { id: menuItem.id }, data: { locations: { connect: { id: barCounter.id } } } });
  console.log(`  + new item: ${name} (${sizes.map((s) => s.label).join("/")})`);
}

await newSizedItem("Rum & Cane Spirits", "Rum & Spirits", "Kenya Cane Ginger", [{ label: "750ml", ml: 750 }, { label: "250ml", ml: 250 }]);
await newSimpleItem("Beer & Cider", "Beer & Cider", "Jinco", "Bottle", null); // replaces the discontinued "Tusker Ndimu" slot
await newSimpleItem("Beer & Cider", "Beer & Cider", "Raspberry", "Bottle", null); // UNCLEAR brand — see report
await newSizedItem("Wine", "Wine", "Expresso", [{ label: "750ml", ml: 750 }]); // UNCLEAR — replaced "Nederburg" on the sheet
await newSizedItem("Wine", "Wine", "Vanilla", [{ label: "750ml", ml: 750 }]); // UNCLEAR — replaced "Black Bird" on the sheet

// Captain Morgan gained a second size (250ml) — convert its MenuItem from a
// direct product link into variants, keeping the original 750ml as one.
async function convertToVariantIfNeeded(menuItemName, existingLabel) {
  const mi = await prisma.menuItem.findFirst({ where: { tenantId: tid, name: menuItemName } });
  if (!mi || !mi.productId) return; // already variant-based, or missing
  const already = await prisma.menuItemVariant.findFirst({ where: { tenantId: tid, menuItemId: mi.id, name: existingLabel } });
  if (already) return;
  await prisma.menuItemVariant.create({ data: { tenantId: tid, menuItemId: mi.id, name: existingLabel, price: 0, stockProductId: mi.productId, stockQtyPerUnit: mi.stockQtyPerUnit ?? 1, sortOrder: 0 } });
  await prisma.menuItem.update({ where: { id: mi.id }, data: { productId: null, stockQtyPerUnit: null } });
  console.log(`  converted ${menuItemName} to variants (kept ${existingLabel} as the first)`);
}
await convertToVariantIfNeeded("Captain Morgan", "750ml");
{
  const cat = await upsertCategory("STORE", "Rum & Cane Spirits");
  const mi = await prisma.menuItem.findFirstOrThrow({ where: { tenantId: tid, name: "Captain Morgan" } });
  const already = await prisma.menuItemVariant.findFirst({ where: { tenantId: tid, menuItemId: mi.id, name: "250ml" } });
  if (!already) {
    const product = await ensureProduct({ name: "Captain Morgan 250ml", categoryId: cat.id, unit: "Bottle", packSize: 250 });
    await prisma.menuItemVariant.create({ data: { tenantId: tid, menuItemId: mi.id, name: "250ml", price: 0, stockProductId: product.id, stockQtyPerUnit: 250, sortOrder: 1 } });
    console.log("  + Captain Morgan 250ml variant added");
  }
}

// A 13th tot brand — Jameson wasn't in the original TOTS list, the club
// added it by hand. Same dedicated-reservoir pattern as the other 12.
async function addTotToExisting(brand) {
  const mi = await prisma.menuItem.findFirst({ where: { tenantId: tid, name: brand }, include: { variants: true } });
  if (!mi) { console.log(`  ! cannot add tot, menu item not found: ${brand}`); return; }
  if (mi.variants.some((v) => v.name.startsWith("Single Tot"))) { console.log(`  = ${brand} already has a tot`); return; }
  const cat = await upsertCategory("STORE", "Whiskey");
  const stockName = `${brand} Tot Stock`;
  let totProduct = await prisma.product.findFirst({ where: { tenantId: tid, name: stockName } });
  if (!totProduct) totProduct = await prisma.product.create({ data: { tenantId: tid, categoryId: cat.id, name: stockName, unit: "Millilitres", unitCost: 0, sellingPrice: 0 } });
  const nextSort = mi.variants.length ? Math.max(...mi.variants.map((v) => v.sortOrder)) + 1 : 0;
  await prisma.menuItemVariant.create({ data: { tenantId: tid, menuItemId: mi.id, name: "Single Tot (30ml)", price: 0, stockProductId: totProduct.id, stockQtyPerUnit: 30, sortOrder: nextSort } });
  await prisma.menuItemVariant.create({ data: { tenantId: tid, menuItemId: mi.id, name: "Double Tot (60ml)", price: 0, stockProductId: totProduct.id, stockQtyPerUnit: 60, sortOrder: nextSort + 1 } });
  console.log(`  + tot added to ${brand}`);
}
await addTotToExisting("Jameson");

// ==================================================================== PHASE 3: real stock counts
console.log("\n=== Phase 3: real opening stock from the counter sheet ===");
const missing = [];
const applied = [];

/** bottleOrUnitCount as physically counted; converts to this system's ml
 * stock automatically via the product's own packSize (1 for whole-unit
 * products, so the count is used as-is for beers/cans/soft drinks/etc). */
async function setRealStock(productName, count) {
  if (count == null) return;
  const product = await prisma.product.findFirst({ where: { tenantId: tid, name: productName } });
  if (!product) { missing.push(productName); return; }
  const qty = count * Number(product.packSize ?? 1);
  await prisma.productStock.upsert({
    where: { tenantId_productId_locationId: { tenantId: tid, productId: product.id, locationId: barCounter.id } },
    update: { quantity: qty },
    create: { tenantId: tid, productId: product.id, locationId: barCounter.id, quantity: qty },
  });
  await prisma.inventoryMovement.create({
    data: { tenantId: tid, productId: product.id, locationId: barCounter.id, type: "OPENING_STOCK", quantity: qty, balanceBefore: 0, balanceAfter: qty, note: "Real stock count from the club's physical counter sheet, entered 2026-09-15" },
  });
  applied.push(productName);
}

// -------- Whiskey (tail end only — these pages didn't include Cognac or the
// first two-thirds of Whiskey; those stay at 0 until those pages are sent).
await setRealStock("JW Double Black 1 Litre", 0);
await setRealStock("JW Green Label 750ml", 0);
await setRealStock("JW Gold Reserve 750ml", 0);
await setRealStock("John Barr Black 1 Litre", 1);
await setRealStock("John Barr Black 750ml", 1); // LOW CONFIDENCE — faint mark
await setRealStock("John Barr Red 750ml", 1);
await setRealStock("Monkey Shoulder 1 Litre", 2);
await setRealStock("Singleton 12yrs 750ml", 2);
await setRealStock("Singleton 15yrs 750ml", 1); // LOW CONFIDENCE — digit overwritten
await setRealStock("Singleton 18yrs 750ml", 2);
await setRealStock("Vat 69 1 Litre", 4);
await setRealStock("Vat 69 750ml", 1);
await setRealStock("Vat 69 375ml", 3);
await setRealStock("William Lawsons 750ml", 2);
// Southern Comfort (both sizes) and JW Blonde read as blank/dash -> 0, no action needed.

// -------- Wine
await setRealStock("4th Street Red 750ml", 1);
await setRealStock("4th Street White 750ml", 3);
await setRealStock("Asconi 750ml", 2);
await setRealStock("Casa Buena Red 1 Litre", 2);
await setRealStock("Casa Buena White 1 Litre", 8);
await setRealStock("Caprice Red Dry 1 Litre", 17);
await setRealStock("Caprice White Dry 1 Litre", 22);
await setRealStock("Cellar Cask Red 750ml", 2);
await setRealStock("Cellar Cask White 750ml", 2);
await setRealStock("Chamdor Red 750ml", 3);
await setRealStock("Drostdy Hof Red 750ml", 2);
await setRealStock("Drostdy Hof White 750ml", 3);
await setRealStock("Four Cousins Red 750ml", 3);
await setRealStock("Four Cousins White 750ml", 2);
await setRealStock("Robertson Red 750ml", 2);
await setRealStock("Robertson White 750ml", 2);
await setRealStock("Rosso Chocolate 750ml", 2);
await setRealStock("Rosso Nobile Cherry 750ml", 1); // LOW CONFIDENCE
await setRealStock("Mucho Mas 750ml", 4);
await setRealStock("Hamsini Red 750ml", 1);
await setRealStock("Hamsini White 750ml", 3);
await setRealStock("Lolie Red 750ml", 3);
await setRealStock("Lolie White 750ml", 1);
await setRealStock("Expresso 750ml", 1); // new — replaced "Nederburg" on the sheet
await setRealStock("Vanilla 750ml", 1); // new — replaced "Black Bird" on the sheet
// Caprice red/white sweet, Casa Buena white variety, Chamdor white read blank -> 0.

// -------- Champagne
await setRealStock("Belaire Rose 750ml", 1);
await setRealStock("Belaire Gold 750ml", 2);
await setRealStock("Moet Brut 750ml", 1);
// Lex, Fragrance, Strawberry Lips blank -> 0.

// -------- Liqueurs / Herbal Liqueurs
await setRealStock("Amarula 750ml", 2);
await setRealStock("Baileys 750ml", 2);
await setRealStock("Best Cream 750ml", 2);
await setRealStock("Jagermeister 1 Litre", 2);
await setRealStock("Jagermeister 700ml", 1);
await setRealStock("V & A 750ml", 1);
await setRealStock("Martini Bianco 750ml", 1);
await setRealStock("Martini Extra Dry 750ml", 1); // LOW CONFIDENCE — no closing tick visible
// Sheridan creme read as sold out (dash) -> 0.

// -------- Vodka (Smirnoff already renamed to 350ml above)
await setRealStock("Smirnoff 750ml", 3);
await setRealStock("Smirnoff 350ml", 4);
// Absolut, Best Vodka, Stolichnaya all blank -> 0.

// -------- Brandy
await setRealStock("Richot 750ml", 2);
await setRealStock("Richot 350ml", 5);
await setRealStock("Viceroy 750ml", 4);
await setRealStock("Viceroy 375ml", 10);
await setRealStock("County 750ml", 5);

// -------- Rum & Cane Spirits / Rum
await setRealStock("Captain Morgan 750ml", 6);
await setRealStock("Captain Morgan Dark 1 Litre", 2);
await setRealStock("Captain Morgan Spiced 750ml", 1);
await setRealStock("Captain Morgan 250ml", 3); // new size
await setRealStock("Kenya Cane 750ml", 2);
await setRealStock("Kenya Cane 250ml", 0); // LOW CONFIDENCE, read as sold out
await setRealStock("Kenya Cane Ginger 750ml", 5); // new
await setRealStock("Kenya Cane Ginger 250ml", 6); // new
await setRealStock("Hunters Choice 750ml", 1);
await setRealStock("Hunters Choice 375ml", 6);
await setRealStock("Malibu 700ml", 1);
// Kenya Cane 350ml, Bacardi blank -> 0.

// -------- Gin
await setRealStock("Best Gin 750ml", 3);
await setRealStock("Gilbeys 750ml", 3);
await setRealStock("Gilbeys 350ml", 2);
await setRealStock("Gibson 1 Litre", 1);
await setRealStock("Gibson 750ml", 1);
await setRealStock("Gibson Pink 750ml", 3);
await setRealStock("Gordons Dry 750ml", 2);
await setRealStock("Hendricks 750ml", 2);
await setRealStock("Tanqueray Dry 750ml", 1);
await setRealStock("Beefeater 750ml", 4);
await setRealStock("Bombay 750ml", 2);
// Gordons Pink (bottle, not the can), Tanqueray Sevilla blank -> 0.
// An illegible extra handwritten gin brand ("Hothers"?) with count 1 was NOT
// entered — see report; couldn't read the brand name confidently.

// -------- Tequila
await setRealStock("Don Julio Blanco 750ml", 1);
await setRealStock("Don Julio Reposado 750ml", 1);
// Camino Gold/Silver, Jose Cuervo Gold/Silver all blank -> 0.

// -------- Beer & Cider (bottles)
await setRealStock("Balozi Bottle", 55);
await setRealStock("Black Ice Bottle", 33);
await setRealStock("Desperados Bottle", 15);
await setRealStock("Guinness Bottle", 4);
await setRealStock("Guinness Smooth Bottle", 23);
await setRealStock("Heineken 0.0% Bottle", 30);
await setRealStock("Heineken Bottle", 38);
await setRealStock("Hunters Dry Bottle", 25);
await setRealStock("Hunters Gold Bottle", 18);
await setRealStock("King Fisher Bottle", 13);
await setRealStock("KO Bottle", 36);
await setRealStock("Manyatta Bottle", 46);
await setRealStock("Pilsner Bottle", 28);
await setRealStock("Savannah Dry Bottle", 27);
await setRealStock("Savannah Lemon Bottle", 44);
await setRealStock("Smirnoff Ice Pineapple Bottle", 27);
await setRealStock("Tusker Lager Bottle", 72);
await setRealStock("Tusker Malt Bottle", 57); // LOW CONFIDENCE — a correction mark on this digit
await setRealStock("Tusker Lite Bottle", 40);
await setRealStock("Tusker Cider Bottle", 76);
await setRealStock("White Cap Bottle", 63);
await setRealStock("White Cap Crisp Bottle", 2);
await setRealStock("Jinco Bottle", 14); // new — replaces the crossed-out "Tusker Ndimu" row
await setRealStock("Raspberry Bottle", 84); // new, UNCLEAR brand — see report
// Snapp blank -> 0. Windhoek blank -> 0.

// -------- Cans
await setRealStock("Balozi Can", 17);
await setRealStock("Black Ice Can", 26);
await setRealStock("Faxe Can", 4);
await setRealStock("Gordons Gin & Tonic Can", 11);
await setRealStock("Gordons Pink Gin & Tonic Can", 19);
await setRealStock("Guarana Bottle", 11); // "Guarana" was modelled as a soft drink, U("Bottle") — sheet counted it among cans
await setRealStock("Guinness Can", 16);
await setRealStock("Heineken Can", 22);
await setRealStock("Smirnoff Ice Pineapple Can", 7);
await setRealStock("Tusker Lager Can", 16);
await setRealStock("Tusker Malt Can", 11);
await setRealStock("Tusker Lite Can", 14);
await setRealStock("Tusker Cider Can", 17);
await setRealStock("White Cap Can", 15);
await setRealStock("White Cap Crisp Can", 10);
// Manyatta Can, KO Can, Pilsner Can, Snapp Can blank -> 0.

// -------- Soft Drinks & Juices
await setRealStock("Branded Water Bottle", 28);
await setRealStock("Delmonte Apple Carton", 5);
await setRealStock("Delmonte Mixed Berry Carton", 4);
await setRealStock("Delmonte Tropical Carton", 3);
await setRealStock("Delmonte Mango Carton", 6);
await setRealStock("Coke Bottle", 48);
await setRealStock("Krest Bottle", 50);
await setRealStock("Sprite Bottle", 50);
await setRealStock("Stoney Bottle", 51);
await setRealStock("Novida Bottle", 30);
await setRealStock("Fanta Orange Bottle", 53);
await setRealStock("Fanta Passion Bottle", 28);
await setRealStock("Fanta Blackcurrant Bottle", 77);
await setRealStock("Lemonade Bottle", 17);
await setRealStock("Red Bull Bottle", 42);
await setRealStock("Tonic Pet Bottle", 8);
await setRealStock("Minute Maid Bottle", 14);
await setRealStock("Dasani Water 1 Litre", 11);
// Dasani Water 500ml: the photo was cut off right at this row — NOT entered, see report.
await setRealStock("Soda Water Bottle", 14);
await setRealStock("Keringet Mineral Water Bottle", 7); // LOW CONFIDENCE — this row and the one below may be swapped
await setRealStock("Keringet Sparkling Water Bottle", 0); // LOW CONFIDENCE
// Delmonte Passion/Pineapple/Cranberry, Lime Juice both sizes, Monster, Predator blank -> 0.

// -------- Cigarettes & Tobacco
await setRealStock("Double Switch Pack", 16);
// Single Switch, Embassy, all Vape sizes, Velo blank -> 0.

// -------- Tots (counted in single-tot units on the sheet -> ml = count * 30)
async function setTotStock(brand, count) {
  if (!count) return;
  const productName = `${brand} Tot Stock`;
  const product = await prisma.product.findFirst({ where: { tenantId: tid, name: productName } });
  if (!product) { missing.push(productName); return; }
  const qty = count * 30;
  await prisma.productStock.upsert({
    where: { tenantId_productId_locationId: { tenantId: tid, productId: product.id, locationId: barCounter.id } },
    update: { quantity: qty },
    create: { tenantId: tid, productId: product.id, locationId: barCounter.id, quantity: qty },
  });
  await prisma.inventoryMovement.create({
    data: { tenantId: tid, productId: product.id, locationId: barCounter.id, type: "OPENING_STOCK", quantity: qty, balanceBefore: 0, balanceAfter: qty, note: `Real tot-reservoir count from the counter sheet (${count} single-tot units assumed), entered 2026-09-15` },
  });
  applied.push(productName);
}
await setTotStock("Jack Daniels", 8);
await setTotStock("Camino Silver", 10);
await setTotStock("Jose Cuervo Gold", 1);
await setTotStock("Gilbeys", 23);
await setTotStock("Smirnoff", 2);
await setTotStock("Jameson", 4); // the club's new 13th tot brand
// Black Label, Camino Gold, Jose Cuervo Silver, Don Julio Blanco, Jagermeister, Sheridans, Malibu tots: blank -> 0.

console.log(`\nApplied real stock to ${applied.length} products/reservoirs.`);
if (missing.length) console.log("Could not find these products (name mismatch — check manually):", JSON.stringify(missing));

const [prodCount, menuCount, variantCount, stockCount] = await Promise.all([
  prisma.product.count({ where: { tenantId: tid } }),
  prisma.menuItem.count({ where: { tenantId: tid } }),
  prisma.menuItemVariant.count({ where: { tenantId: tid } }),
  prisma.productStock.count({ where: { tenantId: tid } }),
]);
console.log(`\nTenant totals: products=${prodCount} menuItems=${menuCount} variants=${variantCount} stockRows=${stockCount}`);
await prisma.$disconnect();
