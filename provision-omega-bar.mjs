/**
 * Omega Gardens Hotel and Spa — bar menu + stock import from the client's
 * "Bar Menu.xlsx" (two tabs: a plain price list, and a Price/Cost/Qty sheet
 * used as the authoritative source wherever the two disagreed — see
 * build-bar-data.js in the session scratchpad for exactly how bar-data.json
 * next to this script was derived, including every brand-grouping and
 * tot-to-bottle-size judgment call made along the way).
 *
 * Architecture (per the client, 2026-09-23):
 *   - Two layers: Product (stock, buying price) and MenuItem (selling price).
 *   - Ditch millilitres for stock tracking here — every unit is counted
 *     whole: a Bottle, a Can, a Tot, a Glass, a Piece (cigarettes/tablets).
 *     A brand's bottle stock and its tot stock are two totally separate
 *     Products with their own counts (e.g. Gilbeys bottles vs Gilbeys tots)
 *     - no ml conversion between them.
 *   - One MenuItem per brand; a brand with more than one sellable format
 *     (several bottle sizes, and/or a tot) gets a MenuItemVariant per
 *     format, each drawing from its own dedicated stock Product.
 *   - Everything sold in one single format (most beers, wines, soft drinks,
 *     cigarettes, sundries) is a plain MenuItem with no variants.
 *   - Every item is available at every location (no locations connected).
 *   - All stock lives at the "Main Bar" location.
 *
 * Idempotent: upserts by name; re-running never resets a price or stock
 * quantity that's already there.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const data = JSON.parse(fs.readFileSync(new URL("./bar-data.json", import.meta.url)));

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;
const mainBar = await prisma.location.findFirstOrThrow({ where: { tenantId: tid, name: "Main Bar" } });
console.log(`Tenant: ${tenant.name} (${tid}) — location: ${mainBar.name} (${mainBar.id})`);

async function ensureUnit(name) {
  const existing = await prisma.unitOfMeasure.findFirst({ where: { tenantId: tid, name } });
  if (existing) return existing;
  return prisma.unitOfMeasure.create({ data: { tenantId: tid, name, measurementKind: "EACH" } });
}
const units = Object.fromEntries(await Promise.all(["Bottle", "Can", "Glass", "Piece", "Tot"].map(async (n) => [n, await ensureUnit(n)])));

async function upsertCategory(name) {
  const existing = await prisma.category.findFirst({ where: { tenantId: tid, scope: "BAR", parentId: null, name } });
  if (existing) return existing;
  return prisma.category.create({ data: { tenantId: tid, scope: "BAR", name, parentId: null, level: 1 } });
}
async function menuCat(name) {
  return prisma.menuCategory.upsert({ where: { tenantId_name: { tenantId: tid, name } }, update: {}, create: { tenantId: tid, name } });
}

async function ensureProduct({ name, categoryId, packUnit, unitCost }) {
  const existing = await prisma.product.findFirst({ where: { tenantId: tid, name } });
  if (existing) return { product: existing, isNew: false };
  const product = await prisma.product.create({
    data: {
      tenantId: tid, categoryId, name,
      unit: packUnit.name.toLowerCase(),
      packSize: 1, packUnitId: packUnit.id, packLabel: packUnit.name,
      unitCost: unitCost ?? null,
      sellsDirectly: false,
    },
  });
  return { product, isNew: true };
}

async function setOpeningStock(productId, quantity, unitCost) {
  const existing = await prisma.productStock.findFirst({ where: { tenantId: tid, productId, locationId: mainBar.id } });
  if (existing) return;
  const { recordStockMovement } = await import("./dist/lib/stockLedger.js");
  await prisma.$transaction(async (tx) => {
    await recordStockMovement(tx, {
      tenantId: tid, productId, locationId: mainBar.id, type: "OPENING_STOCK",
      quantity, unitCost: unitCost ?? undefined, note: "Bar Menu.xlsx import — opening stock",
    });
  });
}

const counts = { products: 0, menuItems: 0, variants: 0 };

// Sheet names are raw ALL-CAPS with stray double-spaces ("TUSKER  CIDER",
// "KERINGET  1/2LTR BAR") - title-case every word for the real menu, except
// a word containing a digit (a size/volume token like "750ML"), which stays
// exactly as printed.
function cleanName(raw) {
  return raw.trim().replace(/\s+/g, " ").split(" ").map((w) => {
    if (/\d/.test(w)) return w; // a size/volume token ("750ML", "1/2LTR") - leave as printed
    if (/^[A-Z]\.[A-Z]\./i.test(w)) return w.split(".").map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join("."); // "J.C.LEROUX" -> "J.C.Leroux"
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(" ");
}

async function buildSimpleItem(categoryName, item) {
  const name = cleanName(item.name);
  const cat = await upsertCategory(categoryName);
  const mc = await menuCat(categoryName);
  const packUnit = units[item.packLabel];
  const { product, isNew } = await ensureProduct({ name, categoryId: cat.id, packUnit, unitCost: item.cost });
  if (isNew) counts.products++;
  await setOpeningStock(product.id, item.qty, item.cost);

  const existing = await prisma.menuItem.findFirst({ where: { tenantId: tid, name } });
  if (existing) return;
  await prisma.menuItem.create({
    data: { tenantId: tid, name, menuCategoryId: mc.id, categoryId: cat.id, price: item.price, productId: product.id, stockQtyPerUnit: 1 },
  });
  counts.menuItems++;
}

async function buildBrand(categoryName, brand) {
  const cat = await upsertCategory(categoryName);
  const mc = await menuCat(categoryName);

  const built = [];
  for (const size of brand.sizes) {
    const { product, isNew } = await ensureProduct({ name: `${brand.brand} ${size.label}`, categoryId: cat.id, packUnit: units.Bottle, unitCost: size.cost });
    if (isNew) counts.products++;
    await setOpeningStock(product.id, size.qty, size.cost);
    built.push({ label: size.label, product, price: size.price });
  }
  let totEntry = null;
  if (brand.tot) {
    const { product, isNew } = await ensureProduct({ name: `${brand.brand} Tot`, categoryId: cat.id, packUnit: units.Tot, unitCost: brand.tot.cost });
    if (isNew) counts.products++;
    await setOpeningStock(product.id, brand.tot.qty, brand.tot.cost);
    totEntry = { label: "Tot", product, price: brand.tot.price };
  }

  const existing = await prisma.menuItem.findFirst({ where: { tenantId: tid, name: brand.brand } });
  if (existing) return;

  const all = totEntry ? [...built, totEntry] : built;
  if (all.length === 1) {
    const only = all[0];
    await prisma.menuItem.create({
      data: { tenantId: tid, name: brand.brand, menuCategoryId: mc.id, categoryId: cat.id, price: only.price, productId: only.product.id, stockQtyPerUnit: 1 },
    });
    counts.menuItems++;
    return;
  }
  const basePrice = Math.min(...all.map((b) => b.price));
  const menuItem = await prisma.menuItem.create({ data: { tenantId: tid, name: brand.brand, menuCategoryId: mc.id, categoryId: cat.id, price: basePrice } });
  counts.menuItems++;
  let sort = 0;
  for (const b of all) {
    await prisma.menuItemVariant.create({
      data: { tenantId: tid, menuItemId: menuItem.id, name: b.label, price: b.price, stockProductId: b.product.id, stockQtyPerUnit: 1, sortOrder: sort++ },
    });
    counts.variants++;
  }
}

for (const [category, items] of Object.entries(data.simple)) {
  for (const item of items) await buildSimpleItem(category, item);
}
for (const [category, brands] of Object.entries(data.spirits)) {
  for (const brand of brands) await buildBrand(category, brand);
}
for (const orphan of data.orphanTots) {
  await buildBrand(orphan.category, { brand: orphan.brand, sizes: [], tot: orphan.tot });
}

console.log("\nCreated this run:", JSON.stringify(counts));
const [prodCount, menuCount, variantCount, stockCount] = await Promise.all([
  prisma.product.count({ where: { tenantId: tid } }),
  prisma.menuItem.count({ where: { tenantId: tid } }),
  prisma.menuItemVariant.count({ where: { tenantId: tid } }),
  prisma.productStock.count({ where: { tenantId: tid } }),
]);
console.log(`Tenant totals now: products=${prodCount} menuItems=${menuCount} variants=${variantCount} stockRows=${stockCount}`);
await prisma.$disconnect();
