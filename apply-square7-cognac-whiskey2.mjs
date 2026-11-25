/**
 * Square 7 Lounge — the previously-missing pages: full Cognac + Whiskey
 * "All Season" through "Bond 7 375ml" (everything before "JW Double Black",
 * which was already entered in apply-square7-stockbook.mjs — deliberately
 * NOT re-touched here to avoid overwriting possibly-since-changed figures
 * with a stale re-read of a page already processed).
 *
 * Corrections + new items this page revealed:
 *  - "Jack Daniels Honey" is actually a 1 Litre bottle, not 700ml (crossed
 *    out and corrected on the sheet) — renamed + repointed.
 *  - "Bond 7" gained a 375ml size — converted from a direct product link to
 *    variants (same pattern as Captain Morgan last time).
 *  - Three new Johnnie Walker special editions: Song of Fire, Song of Ice,
 *    White Walker — none had a size on the sheet, defaulted to 750ml like
 *    every other size-less item (see the earlier "24 items" list — these
 *    three join it).
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

async function upsertCategory(scope, name) {
  const existing = await prisma.category.findFirst({ where: { tenantId: tid, scope, parentId: null, name } });
  if (existing) return existing;
  return prisma.category.create({ data: { tenantId: tid, scope, name, parentId: null, level: 1 } });
}
function menuCat(name) {
  return prisma.menuCategory.upsert({ where: { tenantId_name: { tenantId: tid, name } }, update: {}, create: { tenantId: tid, name } });
}
async function ensureProduct({ name, categoryId, packSize }) {
  const existing = await prisma.product.findFirst({ where: { tenantId: tid, name } });
  if (existing) return existing;
  return prisma.product.create({ data: { tenantId: tid, categoryId, name, unit: "Bottle", packSize, packUnitId: (await prisma.unitOfMeasure.findFirstOrThrow({ where: { tenantId: tid, name: "Millilitres" } })).id, packLabel: "Bottle", unitCost: 0, sellingPrice: 0 } });
}

// -------------------------------------------------------------- corrections
async function renameProductAndVariantOrDirect(oldProductName, newProductName, newPackSize, menuItemName) {
  const product = await prisma.product.findFirst({ where: { tenantId: tid, name: oldProductName } });
  if (!product) { console.log(`  ! rename skipped, not found: ${oldProductName}`); return; }
  if (product.name === newProductName) { console.log(`  = already renamed: ${newProductName}`); return; }
  await prisma.product.update({ where: { id: product.id }, data: { name: newProductName, packSize: newPackSize } });
  await prisma.menuItem.updateMany({ where: { tenantId: tid, name: menuItemName, productId: product.id }, data: { stockQtyPerUnit: newPackSize } });
  console.log(`  renamed ${oldProductName} -> ${newProductName}`);
}
await renameProductAndVariantOrDirect("Jack Daniels Honey 700ml", "Jack Daniels Honey 1 Litre", 1000, "Jack Daniels Honey");

async function convertToVariantIfNeeded(menuItemName, existingLabel) {
  const mi = await prisma.menuItem.findFirst({ where: { tenantId: tid, name: menuItemName } });
  if (!mi || !mi.productId) return;
  const already = await prisma.menuItemVariant.findFirst({ where: { tenantId: tid, menuItemId: mi.id, name: existingLabel } });
  if (already) return;
  await prisma.menuItemVariant.create({ data: { tenantId: tid, menuItemId: mi.id, name: existingLabel, price: 0, stockProductId: mi.productId, stockQtyPerUnit: mi.stockQtyPerUnit ?? 1, sortOrder: 0 } });
  await prisma.menuItem.update({ where: { id: mi.id }, data: { productId: null, stockQtyPerUnit: null } });
  console.log(`  converted ${menuItemName} to variants (kept ${existingLabel} as the first)`);
}
await convertToVariantIfNeeded("Bond 7", "750ml");
{
  const cat = await upsertCategory("STORE", "Whiskey");
  const mi = await prisma.menuItem.findFirstOrThrow({ where: { tenantId: tid, name: "Bond 7" } });
  const already = await prisma.menuItemVariant.findFirst({ where: { tenantId: tid, menuItemId: mi.id, name: "375ml" } });
  if (!already) {
    const product = await ensureProduct({ name: "Bond 7 375ml", categoryId: cat.id, packSize: 375 });
    await prisma.menuItemVariant.create({ data: { tenantId: tid, menuItemId: mi.id, name: "375ml", price: 0, stockProductId: product.id, stockQtyPerUnit: 375, sortOrder: 1 } });
    console.log("  + Bond 7 375ml variant added");
  }
}

// -------------------------------------------------------------- new items
async function newSimpleWhiskey(name) {
  const existing = await prisma.menuItem.findFirst({ where: { tenantId: tid, name } });
  if (existing) { console.log(`  = already exists: ${name}`); return; }
  const cat = await upsertCategory("STORE", "Whiskey");
  const legacyCat = await upsertCategory("BAR", "Whiskey");
  const mc = await menuCat("Whiskey");
  const product = await ensureProduct({ name: `${name} 750ml`, categoryId: cat.id, packSize: 750 });
  const menuItem = await prisma.menuItem.create({ data: { tenantId: tid, name, menuCategoryId: mc.id, categoryId: legacyCat.id, price: 0, productId: product.id, stockQtyPerUnit: 750 } });
  await prisma.menuItem.update({ where: { id: menuItem.id }, data: { locations: { connect: { id: barCounter.id } } } });
  console.log(`  + new item: ${name} 750ml (no size on the sheet — defaulted, like the earlier 24)`);
}
await newSimpleWhiskey("JW Song of Fire");
await newSimpleWhiskey("JW Song of Ice");
await newSimpleWhiskey("JW White Walker");

// -------------------------------------------------------------- real stock
const missing = [];
const applied = [];
async function setRealStock(productName, count) {
  if (!count) return;
  const product = await prisma.product.findFirst({ where: { tenantId: tid, name: productName } });
  if (!product) { missing.push(productName); return; }
  const qty = count * Number(product.packSize ?? 1);
  await prisma.productStock.upsert({
    where: { tenantId_productId_locationId: { tenantId: tid, productId: product.id, locationId: barCounter.id } },
    update: { quantity: qty },
    create: { tenantId: tid, productId: product.id, locationId: barCounter.id, quantity: qty },
  });
  await prisma.inventoryMovement.create({
    data: { tenantId: tid, productId: product.id, locationId: barCounter.id, type: "OPENING_STOCK", quantity: qty, balanceBefore: 0, balanceAfter: qty, note: "Real stock count from the club's physical counter sheet (Cognac/early-Whiskey pages), entered 2026-09-15" },
  });
  applied.push(productName);
}

// Cognac
await setRealStock("Martel Blue Swift 700ml", 2);
await setRealStock("Martel VSOP 700ml", 1);
await setRealStock("Martel VS 700ml", 1); // LOW CONFIDENCE
await setRealStock("Martel VS 1 Litre", 3);
await setRealStock("Hennessy VSOP 700ml", 1); // LOW CONFIDENCE
await setRealStock("Hennessy VS 700ml", 2);
await setRealStock("Hennessy VS 350ml", 3);
await setRealStock("Hennessy VS 1 Litre", 1); // LOW CONFIDENCE
await setRealStock("Remy Martin VSOP 1 Litre", 8); // LOW CONFIDENCE

// Whiskey (All Season -> Bond 7 375ml)
await setRealStock("All Season 750ml", 2);
await setRealStock("Ballentines 750ml", 2);
await setRealStock("Bond 7 750ml", 4);
await setRealStock("Bond 7 375ml", 9); // new size
await setRealStock("Best Whiskey 750ml", 4);
await setRealStock("Black & White 750ml", 7);
await setRealStock("Black & White 375ml", 1); // LOW CONFIDENCE
await setRealStock("Chivas Regal 12yrs 1 Litre", 1);
await setRealStock("Chivas Regal 18yrs 750ml", 1);
await setRealStock("Famous Grouse 750ml", 2);
await setRealStock("Grants 1 Litre", 3);
await setRealStock("Grants 750ml", 3);
await setRealStock("Grants Wood 750ml", 2);
await setRealStock("Gentleman Jack 1 Litre", 1);
await setRealStock("Glenfiddich 12yrs 750ml", 1);
await setRealStock("Glenfiddich 15yrs 750ml", 3); // LOW CONFIDENCE
await setRealStock("Hamptons 750ml", 3);
await setRealStock("Jack Daniels 1 Litre", 2);
await setRealStock("Jack Daniels 700ml", 2);
await setRealStock("Jack Daniels 350ml", 3);
await setRealStock("Jack Daniels Honey 1 Litre", 1); // renamed above from 700ml
await setRealStock("Jack Daniels Fire 1 Litre", 1);
await setRealStock("Jameson 1 Litre", 2);
await setRealStock("Jameson 750ml", 1);
await setRealStock("Jameson 350ml", 3);
await setRealStock("Jameson Black Barrel 750ml", 2);
await setRealStock("J&B 750ml", 4);
await setRealStock("JW Black Label 1 Litre", 4);
await setRealStock("JW Black Label 750ml", 4);
await setRealStock("JW Black Label 375ml", 1);
await setRealStock("JW Black Label 250ml", 2);
await setRealStock("JW Red Label 1 Litre", 1);
await setRealStock("JW Red Label 750ml", 1);
await setRealStock("JW Red Label 375ml", 6); // LOW CONFIDENCE
await setRealStock("JW Song of Fire 750ml", 2); // new
await setRealStock("JW Song of Ice 750ml", 2); // new
await setRealStock("JW White Walker 750ml", 2); // new
// Bulleit Bourbon: blank on the sheet -> 0, no action.

console.log(`\nApplied real stock to ${applied.length} products.`);
if (missing.length) console.log("NOT FOUND (check spelling/category):", JSON.stringify(missing));

const [prodCount, menuCount, variantCount, stockCount] = await Promise.all([
  prisma.product.count({ where: { tenantId: tid } }),
  prisma.menuItem.count({ where: { tenantId: tid } }),
  prisma.menuItemVariant.count({ where: { tenantId: tid } }),
  prisma.productStock.count({ where: { tenantId: tid } }),
]);
console.log(`\nTenant totals: products=${prodCount} menuItems=${menuCount} variants=${variantCount} stockRows=${stockCount}`);
console.log("\nNOTE: the 'JW Double Black ... JW Blonde' page in this batch of photos is a re-shot of a page already entered last time — deliberately NOT reprocessed here to avoid overwriting those figures. Say so explicitly if that page's real counts have actually changed and you want it re-applied.");
await prisma.$disconnect();
