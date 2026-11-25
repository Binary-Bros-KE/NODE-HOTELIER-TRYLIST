/**
 * Square 7 Lounge (tenant slug "square7", businessType CLUB) — first real
 * client catalog import, transcribed from their counter-stock PDF.
 *
 * Modelling rule (confirmed against the schema before writing this):
 *   - "Poured" categories (cognac, whiskey, wine, champagne, liqueurs, vodka,
 *     brandy, rum, gin, tequila) get ml-tracked Products — one Product per
 *     physical bottle SIZE (packSize/packUnitId/packLabel), stock held in ml.
 *   - One MenuItem per BRAND. If a brand has only one bottle size and isn't
 *     in the PDF's own TOTS section, the MenuItem links straight to that one
 *     Product (no variants needed). Otherwise it gets a MenuItemVariant per
 *     bottle size (stockProductId + stockQtyPerUnit = that size's ml) plus,
 *     for the 12 brands the PDF's TOTS section actually names, two more
 *     variants: "Single Tot (30ml)" and "Double Tot (60ml)", both drawing
 *     from a dedicated "<Brand> Tot Stock" product (plain Millilitres, no
 *     packSize) that staff top up by hand, separately from the sealed
 *     bottles sold whole (per the client, 2026-09-15). This is the exact
 *     mechanism MenuItemVariant.stockProductId / stockQtyPerUnit was built for — see pos.routes.ts computeStockRequirements.
 *   - Beers/cans/soft drinks/cigarettes/sundries are single-serve, never
 *     poured fractionally — plain whole-unit Products (no packSize), 1 per
 *     sale. A brand sold as both Bottle and Can gets both as variants of one
 *     MenuItem.
 *
 * All prices/costs/opening stock are RANDOM placeholders for testing — the
 * PDF gave no real figures. Clear/replace before go-live (see README note
 * printed at the end).
 *
 * Idempotent: re-running never touches a Product/MenuItem/Variant that
 * already exists (no price gets shuffled on a second run), and never resets
 * stock once set.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();
const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl) { console.error("DATABASE_URL not set"); process.exit(1); }
console.log("Target DB:", dbUrl.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@"));
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }) });

const rand = (min, max) => Math.round(min + Math.random() * (max - min));
const pick50 = (v) => Math.round(v / 50) * 50; // round to a "nice" KES amount

// ------------------------------------------------------------------ setup
const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "square7" } });
const tid = tenant.id;
const barCounter = await prisma.location.findFirstOrThrow({ where: { tenantId: tid, name: "Bar Counter" } });
console.log(`Tenant: ${tenant.name} (${tid}) — location: ${barCounter.name} (${barCounter.id})`);

const mlUnit = await prisma.unitOfMeasure.upsert({
  where: { tenantId_name: { tenantId: tid, name: "Millilitres" } },
  update: {}, create: { tenantId: tid, name: "Millilitres" },
});

async function upsertCategory(scope, name) {
  const existing = await prisma.category.findFirst({ where: { tenantId: tid, scope, parentId: null, name } });
  if (existing) return existing;
  return prisma.category.create({ data: { tenantId: tid, scope, name, parentId: null, level: 1 } });
}
function menuCat(name) {
  return prisma.menuCategory.upsert({ where: { tenantId_name: { tenantId: tid, name } }, update: {}, create: { tenantId: tid, name } });
}

async function ensureProduct({ name, categoryId, unit, packSize, packLabel, unitCost }) {
  const existing = await prisma.product.findFirst({ where: { tenantId: tid, name } });
  if (existing) return { product: existing, isNew: false };
  const product = await prisma.product.create({
    data: {
      tenantId: tid, categoryId, name, unit,
      packSize: packSize ?? null,
      packUnitId: packSize ? mlUnit.id : null,
      packLabel: packLabel ?? null,
      unitCost,
    },
  });
  return { product, isNew: true };
}

async function setOpeningStock(productId, quantity) {
  const existing = await prisma.productStock.findFirst({ where: { tenantId: tid, productId, locationId: barCounter.id } });
  if (existing) return;
  await prisma.$transaction([
    prisma.productStock.create({ data: { tenantId: tid, productId, locationId: barCounter.id, quantity } }),
    prisma.inventoryMovement.create({ data: { tenantId: tid, productId, locationId: barCounter.id, type: "OPENING_STOCK", quantity, balanceBefore: 0, balanceAfter: quantity, note: "Square 7 catalog import — random opening stock for testing" } }),
  ]);
}

let created = { products: 0, menuItems: 0, variants: 0 };

// S(label, ml) = a pourable size tracked in ml. U(label) = a plain whole unit
// (beer/can/soft drink/cigarette — never fractionally poured).
const S = (label, ml) => ({ label, ml });
const U = (label) => ({ label, ml: null });

/**
 * One brand. `pours` = bottle sizes (or Bottle/Can formats). `tot` = true
 * only for the 12 brands the PDF's own TOTS section names — draws 30ml from
 * the pour closest to a standard 700-750ml bottle (falling back to the
 * largest, then whatever's there).
 */
async function buildItem({ storeCategory, menuCategory, legacyScope = "BAR", name, pours, tot = false, priceRange, totPriceRange, costFactor = 0.6 }) {
  const cat = await upsertCategory("STORE", storeCategory);
  const mc = await menuCat(menuCategory);
  const legacyCat = await upsertCategory(legacyScope, storeCategory);

  const built = [];
  for (const pour of pours) {
    const isMl = pour.ml != null;
    const productName = `${name} ${pour.label}`;
    const price = pick50(rand(priceRange[0], priceRange[1]));
    const { product, isNew } = await ensureProduct({
      name: productName, categoryId: cat.id,
      unit: isMl ? "Bottle" : (pour.unit ?? "Each"),
      packSize: isMl ? pour.ml : null,
      packLabel: isMl ? "Bottle" : null,
      unitCost: Math.round(price * costFactor),
    });
    if (isNew) created.products++;
    built.push({ ...pour, product, price });
    await setOpeningStock(product.id, isMl ? pour.ml * rand(2, 10) : rand(12, 60));
  }

  // Tots draw from their OWN dedicated reservoir, never from a sealed bottle
  // product — the club tops that reservoir up by hand whenever it runs low,
  // entirely separate from bottle stock. Two named pour sizes, per the club.
  let totProduct = null;
  if (tot) {
    const stockName = `${name} Tot Stock`;
    totProduct = await prisma.product.findFirst({ where: { tenantId: tid, name: stockName } });
    if (!totProduct) {
      totProduct = await prisma.product.create({
        data: { tenantId: tid, categoryId: cat.id, name: stockName, unit: "Millilitres", unitCost: Math.round(priceRange[0] * 0.02) },
      });
      created.products++;
    }
  }

  let menuItem = await prisma.menuItem.findFirst({ where: { tenantId: tid, name } });
  if (menuItem) return menuItem; // already imported — never touched again

  const needsVariants = built.length > 1 || !!totProduct;
  if (!needsVariants) {
    const only = built[0];
    menuItem = await prisma.menuItem.create({
      data: {
        tenantId: tid, name, menuCategoryId: mc.id, categoryId: legacyCat.id,
        price: only.price, productId: only.product.id, stockQtyPerUnit: only.ml ?? 1,
      },
    });
    created.menuItems++;
  } else {
    menuItem = await prisma.menuItem.create({
      data: { tenantId: tid, name, menuCategoryId: mc.id, categoryId: legacyCat.id, price: built[0].price },
    });
    created.menuItems++;
    let sort = 0;
    for (const b of built) {
      await prisma.menuItemVariant.create({
        data: { tenantId: tid, menuItemId: menuItem.id, name: b.label, price: b.price, stockProductId: b.product.id, stockQtyPerUnit: b.ml ?? 1, sortOrder: sort++ },
      });
      created.variants++;
    }
    if (totProduct) {
      const [lo, hi] = totPriceRange ?? [priceRange[0] * 0.05, priceRange[1] * 0.08];
      const singlePrice = pick50(rand(lo, hi));
      const doublePrice = Math.round((singlePrice * 1.8) / 50) * 50;
      await prisma.menuItemVariant.create({
        data: { tenantId: tid, menuItemId: menuItem.id, name: "Single Tot (30ml)", price: singlePrice, stockProductId: totProduct.id, stockQtyPerUnit: 30, sortOrder: sort++ },
      });
      await prisma.menuItemVariant.create({
        data: { tenantId: tid, menuItemId: menuItem.id, name: "Double Tot (60ml)", price: doublePrice, stockProductId: totProduct.id, stockQtyPerUnit: 60, sortOrder: sort++ },
      });
      created.variants += 2;
    }
  }
  await prisma.menuItem.update({ where: { id: menuItem.id }, data: { locations: { connect: { id: barCounter.id } } } });
  return menuItem;
}

async function buildSimple({ storeCategory, menuCategory, name, unit, priceRange, formats }) {
  // formats: array of format labels ("Bottle", "Can", ...) — 1 = no variant needed.
  return buildItem({
    storeCategory, menuCategory, name,
    pours: formats.map((f) => U(f)),
    priceRange, costFactor: 0.55,
  });
}

// ==================================================================== COGNAC
const COGNAC = [1600, 3200]; // per-750ml-ish band; scaled per size below via pour price range override — kept simple: one band for the whole category
await buildItem({ storeCategory: "Cognac", menuCategory: "Cognac", name: "Martel Blue Swift", pours: [S("700ml", 700)], priceRange: [6500, 9000] });
await buildItem({ storeCategory: "Cognac", menuCategory: "Cognac", name: "Martel VSOP", pours: [S("700ml", 700)], priceRange: [7000, 9500] });
await buildItem({ storeCategory: "Cognac", menuCategory: "Cognac", name: "Martel VS", pours: [S("700ml", 700), S("1 Litre", 1000)], priceRange: [5500, 8000] });
await buildItem({ storeCategory: "Cognac", menuCategory: "Cognac", name: "Hennessy VSOP", pours: [S("700ml", 700)], priceRange: [8000, 11000] });
await buildItem({ storeCategory: "Cognac", menuCategory: "Cognac", name: "Hennessy VS", pours: [S("700ml", 700), S("350ml", 350), S("1 Litre", 1000)], priceRange: [6000, 9000] });
await buildItem({ storeCategory: "Cognac", menuCategory: "Cognac", name: "Remy Martin VSOP", pours: [S("1 Litre", 1000)], priceRange: [8500, 11500] });

// ==================================================================== WHISKEY
const wPrem = [3500, 7500], wStd = [1800, 3200], wEco = [1200, 1900];
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "All Season", pours: [S("750ml", 750)], priceRange: wEco });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Ballentines", pours: [S("750ml", 750)], priceRange: wStd });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Bond 7", pours: [S("750ml", 750)], priceRange: wEco });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Best Whiskey", pours: [S("750ml", 750)], priceRange: wEco });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Black & White", pours: [S("1 Litre", 1000), S("750ml", 750), S("375ml", 375)], priceRange: wStd });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Bulleit Bourbon", pours: [S("750ml", 750)], priceRange: wPrem });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Chivas Regal 12yrs", pours: [S("1 Litre", 1000)], priceRange: wPrem });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Chivas Regal 18yrs", pours: [S("750ml", 750)], priceRange: [6000, 9000] });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Famous Grouse", pours: [S("1 Litre", 1000), S("750ml", 750)], priceRange: wStd });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Grants", pours: [S("1 Litre", 1000), S("750ml", 750)], priceRange: wStd });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Grants Wood", pours: [S("750ml", 750)], priceRange: wStd });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Gentleman Jack", pours: [S("1 Litre", 1000)], priceRange: wPrem });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Glenfiddich 12yrs", pours: [S("750ml", 750)], priceRange: wPrem });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Glenfiddich 15yrs", pours: [S("750ml", 750)], priceRange: [5000, 7500] });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Hamptons", pours: [S("750ml", 750)], priceRange: wEco });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Jack Daniels", pours: [S("1 Litre", 1000), S("700ml", 700), S("350ml", 350)], tot: true, priceRange: wPrem, totPriceRange: [350, 500] });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Jack Daniels Honey", pours: [S("700ml", 700)], priceRange: wPrem });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Jack Daniels Fire", pours: [S("1 Litre", 1000)], priceRange: wPrem });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Jameson", pours: [S("1 Litre", 1000), S("750ml", 750), S("350ml", 350)], priceRange: wStd });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Jameson Black Barrel", pours: [S("750ml", 750)], priceRange: wPrem });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "J&B", pours: [S("750ml", 750)], priceRange: wStd });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "JW Black Label", pours: [S("1 Litre", 1000), S("750ml", 750), S("375ml", 375), S("250ml", 250)], tot: true, priceRange: wPrem, totPriceRange: [400, 550] });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "JW Red Label", pours: [S("1 Litre", 1000), S("750ml", 750), S("375ml", 375)], priceRange: wStd });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "JW Double Black", pours: [S("1 Litre", 1000)], priceRange: wPrem });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "JW Green Label", pours: [S("750ml", 750)], priceRange: wPrem });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "JW Gold Reserve", pours: [S("750ml", 750)], priceRange: [5500, 8500] });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "JW Blonde", pours: [S("750ml", 750)], priceRange: wStd });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "John Barr Black", pours: [S("1 Litre", 1000), S("750ml", 750)], priceRange: wStd });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "John Barr Red", pours: [S("750ml", 750)], priceRange: wEco });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Monkey Shoulder", pours: [S("1 Litre", 1000)], priceRange: wPrem });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Singleton 12yrs", pours: [S("750ml", 750)], priceRange: wPrem });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Singleton 15yrs", pours: [S("750ml", 750)], priceRange: [5000, 7500] });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Singleton 18yrs", pours: [S("750ml", 750)], priceRange: [7000, 10000] });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Southern Comfort", pours: [S("1 Litre", 1000), S("750ml", 750)], priceRange: wStd });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "Vat 69", pours: [S("1 Litre", 1000), S("750ml", 750), S("375ml", 375)], priceRange: wStd });
await buildItem({ storeCategory: "Whiskey", menuCategory: "Whiskey", name: "William Lawsons", pours: [S("750ml", 750)], priceRange: wEco });

// ==================================================================== WINE
const wine = [1800, 3200];
const wines = [
  ["4th Street Red", "750ml", 750], ["4th Street White", "750ml", 750], ["Asconi", "750ml", 750],
  ["Casa Buena Red", "1 Litre", 1000], ["Casa Buena White", "1 Litre", 1000],
  ["Caprice Red Sweet", "1 Litre", 1000], ["Caprice Red Dry", "1 Litre", 1000],
  ["Caprice White Sweet", "1 Litre", 1000], ["Caprice White Dry", "1 Litre", 1000],
  ["Cellar Cask Red", "750ml", 750], ["Cellar Cask White", "750ml", 750],
  ["Chamdor Red", "750ml", 750], ["Chamdor White", "750ml", 750],
  ["Drostdy Hof Red", "750ml", 750], ["Drostdy Hof White", "750ml", 750],
  ["Four Cousins Red", "750ml", 750], ["Four Cousins White", "750ml", 750],
  ["Robertson Red", "750ml", 750], ["Robertson White", "750ml", 750],
  ["Rosso Chocolate", "750ml", 750], ["Rosso Nobile Cherry", "750ml", 750],
  ["Nederburg", "750ml", 750], ["Mucho Mas", "750ml", 750],
  ["Hamsini Red", "750ml", 750], ["Hamsini White", "750ml", 750],
  ["Lolie Red", "750ml", 750], ["Lolie White", "750ml", 750], ["Black Bird", "750ml", 750],
];
for (const [name, label, ml] of wines) await buildItem({ storeCategory: "Wine", menuCategory: "Wine", name, pours: [S(label, ml)], priceRange: wine });

// ==================================================================== CHAMPAGNE
await buildItem({ storeCategory: "Champagne", menuCategory: "Champagne", name: "Moet Brut", pours: [S("750ml", 750)], priceRange: [9000, 14000] });
await buildItem({ storeCategory: "Champagne", menuCategory: "Champagne", name: "Belaire Rose", pours: [S("750ml", 750)], priceRange: [5500, 8500] });
await buildItem({ storeCategory: "Champagne", menuCategory: "Champagne", name: "Belaire Gold", pours: [S("750ml", 750)], priceRange: [5500, 8500] });
await buildItem({ storeCategory: "Champagne", menuCategory: "Champagne", name: "Lex", pours: [S("750ml", 750)], priceRange: [2000, 3200] });
await buildItem({ storeCategory: "Champagne", menuCategory: "Champagne", name: "Fragrance", pours: [S("750ml", 750)], priceRange: [2000, 3200] });
await buildItem({ storeCategory: "Champagne", menuCategory: "Champagne", name: "Strawberry Lips", pours: [S("750ml", 750)], priceRange: [1800, 2800] });

// ==================================================================== LIQUEURS & HERBAL LIQUEURS
await buildItem({ storeCategory: "Liqueurs", menuCategory: "Liqueurs", name: "Amarula", pours: [S("1 Litre", 1000), S("750ml", 750)], priceRange: [2200, 3800] });
await buildItem({ storeCategory: "Liqueurs", menuCategory: "Liqueurs", name: "Baileys", pours: [S("750ml", 750)], priceRange: [2500, 3800] });
await buildItem({ storeCategory: "Liqueurs", menuCategory: "Liqueurs", name: "Best Cream", pours: [S("750ml", 750)], priceRange: [1600, 2400] });
await buildItem({ storeCategory: "Herbal Liqueurs", menuCategory: "Liqueurs", name: "Jagermeister", pours: [S("1 Litre", 1000), S("700ml", 700)], tot: true, priceRange: [2800, 4200], totPriceRange: [350, 500] });
await buildItem({ storeCategory: "Herbal Liqueurs", menuCategory: "Liqueurs", name: "Sheridans", pours: [S("1 Litre", 1000)], tot: true, priceRange: [3000, 4200], totPriceRange: [350, 500] });
await buildItem({ storeCategory: "Herbal Liqueurs", menuCategory: "Liqueurs", name: "V & A", pours: [S("750ml", 750)], priceRange: [1800, 2600] });
await buildItem({ storeCategory: "Herbal Liqueurs", menuCategory: "Liqueurs", name: "Martini Bianco", pours: [S("750ml", 750)], priceRange: [1800, 2600] });
await buildItem({ storeCategory: "Herbal Liqueurs", menuCategory: "Liqueurs", name: "Martini Extra Dry", pours: [S("750ml", 750)], priceRange: [1800, 2600] });

// ==================================================================== VODKA
await buildItem({ storeCategory: "Vodka", menuCategory: "Vodka", name: "Absolut Vodka", pours: [S("1 Litre", 1000), S("750ml", 750)], priceRange: [2600, 3800] });
await buildItem({ storeCategory: "Vodka", menuCategory: "Vodka", name: "Best Vodka", pours: [S("750ml", 750)], priceRange: [1200, 1800] });
await buildItem({ storeCategory: "Vodka", menuCategory: "Vodka", name: "Smirnoff", pours: [S("750ml", 750), S("375ml", 375)], tot: true, priceRange: [1500, 2200], totPriceRange: [250, 350] });
await buildItem({ storeCategory: "Vodka", menuCategory: "Vodka", name: "Stolichnaya", pours: [S("750ml", 750)], priceRange: [2400, 3400] });

// ==================================================================== BRANDY
await buildItem({ storeCategory: "Brandy", menuCategory: "Brandy", name: "Richot", pours: [S("750ml", 750), S("350ml", 350)], priceRange: [1400, 2200] });
await buildItem({ storeCategory: "Brandy", menuCategory: "Brandy", name: "Viceroy", pours: [S("750ml", 750), S("375ml", 375)], priceRange: [1300, 2000] });
await buildItem({ storeCategory: "Brandy", menuCategory: "Brandy", name: "County", pours: [S("750ml", 750)], priceRange: [1200, 1800] });

// ==================================================================== RUM & CANE SPIRITS
await buildItem({ storeCategory: "Rum & Cane Spirits", menuCategory: "Rum & Spirits", name: "Captain Morgan", pours: [S("750ml", 750)], priceRange: [2200, 3000] });
await buildItem({ storeCategory: "Rum & Cane Spirits", menuCategory: "Rum & Spirits", name: "Captain Morgan Dark", pours: [S("1 Litre", 1000)], priceRange: [2400, 3200] });
await buildItem({ storeCategory: "Rum & Cane Spirits", menuCategory: "Rum & Spirits", name: "Captain Morgan Spiced", pours: [S("750ml", 750)], priceRange: [2200, 3000] });
await buildItem({ storeCategory: "Rum & Cane Spirits", menuCategory: "Rum & Spirits", name: "Kenya Cane", pours: [S("750ml", 750), S("350ml", 350), S("250ml", 250)], priceRange: [700, 1300] });
await buildItem({ storeCategory: "Rum & Cane Spirits", menuCategory: "Rum & Spirits", name: "Hunters Choice", pours: [S("750ml", 750), S("375ml", 375)], priceRange: [900, 1500] });
await buildItem({ storeCategory: "Rum", menuCategory: "Rum & Spirits", name: "Bacardi", pours: [S("750ml", 750)], priceRange: [1800, 2600] });
await buildItem({ storeCategory: "Rum", menuCategory: "Rum & Spirits", name: "Malibu", pours: [S("700ml", 700)], tot: true, priceRange: [1800, 2600], totPriceRange: [300, 400] });

// ==================================================================== GIN
const gPrem = [3000, 4800], gStd = [1400, 2200];
await buildItem({ storeCategory: "Gin", menuCategory: "Gin", name: "Best Gin", pours: [S("750ml", 750)], priceRange: [1200, 1800] });
await buildItem({ storeCategory: "Gin", menuCategory: "Gin", name: "Gilbeys", pours: [S("750ml", 750), S("350ml", 350)], tot: true, priceRange: gStd, totPriceRange: [250, 350] });
await buildItem({ storeCategory: "Gin", menuCategory: "Gin", name: "Gibson", pours: [S("1 Litre", 1000), S("750ml", 750)], priceRange: gStd });
await buildItem({ storeCategory: "Gin", menuCategory: "Gin", name: "Gibson Pink", pours: [S("750ml", 750)], priceRange: gStd });
await buildItem({ storeCategory: "Gin", menuCategory: "Gin", name: "Gordons Dry", pours: [S("750ml", 750)], priceRange: gStd });
await buildItem({ storeCategory: "Gin", menuCategory: "Gin", name: "Gordons Pink", pours: [S("750ml", 750)], priceRange: gStd });
await buildItem({ storeCategory: "Gin", menuCategory: "Gin", name: "Hendricks", pours: [S("750ml", 750)], priceRange: gPrem });
await buildItem({ storeCategory: "Gin", menuCategory: "Gin", name: "Tanqueray Sevilla", pours: [S("750ml", 750)], priceRange: gPrem });
await buildItem({ storeCategory: "Gin", menuCategory: "Gin", name: "Tanqueray Dry", pours: [S("750ml", 750)], priceRange: gPrem });
await buildItem({ storeCategory: "Gin", menuCategory: "Gin", name: "Beefeater", pours: [S("750ml", 750)], priceRange: gPrem });
await buildItem({ storeCategory: "Gin", menuCategory: "Gin", name: "Bombay", pours: [S("750ml", 750)], priceRange: gPrem });

// ==================================================================== TEQUILA
const teq = [2500, 4200];
await buildItem({ storeCategory: "Tequila", menuCategory: "Tequila", name: "Camino Gold", pours: [S("750ml", 750)], tot: true, priceRange: teq, totPriceRange: [350, 500] });
await buildItem({ storeCategory: "Tequila", menuCategory: "Tequila", name: "Camino Silver", pours: [S("750ml", 750)], tot: true, priceRange: teq, totPriceRange: [350, 500] });
await buildItem({ storeCategory: "Tequila", menuCategory: "Tequila", name: "Don Julio Blanco", pours: [S("750ml", 750)], tot: true, priceRange: [4500, 6500], totPriceRange: [500, 700] });
await buildItem({ storeCategory: "Tequila", menuCategory: "Tequila", name: "Don Julio Reposado", pours: [S("750ml", 750)], priceRange: [5000, 7000] });
await buildItem({ storeCategory: "Tequila", menuCategory: "Tequila", name: "Jose Cuervo Gold", pours: [S("750ml", 750)], tot: true, priceRange: teq, totPriceRange: [350, 500] });
await buildItem({ storeCategory: "Tequila", menuCategory: "Tequila", name: "Jose Cuervo Silver", pours: [S("750ml", 750)], tot: true, priceRange: teq, totPriceRange: [350, 500] });

// ==================================================================== BEER & CIDER (bottle-only, can-only, or both)
const beerBottle = [300, 400], beerCan = [280, 380];
async function buildBeer(name, { bottle = false, can = false }) {
  const formats = [];
  if (bottle) formats.push("Bottle");
  if (can) formats.push("Can");
  await buildItem({ storeCategory: "Beer & Cider", menuCategory: "Beer & Cider", name, pours: formats.map((f) => U(f)), priceRange: bottle ? beerBottle : beerCan });
}
await buildBeer("Balozi", { bottle: true, can: true });
await buildBeer("Black Ice", { bottle: true, can: true });
await buildBeer("Desperados", { bottle: true });
await buildBeer("Guinness", { bottle: true, can: true });
await buildBeer("Guinness Smooth", { bottle: true });
await buildBeer("Heineken", { bottle: true, can: true }); // "Heineken btl" + bare "Heineken" in cans
await buildBeer("Heineken 0.0%", { bottle: true });
await buildBeer("Hunters Dry", { bottle: true });
await buildBeer("Hunters Gold", { bottle: true });
await buildBeer("King Fisher", { bottle: true });
await buildBeer("KO", { bottle: true, can: true });
await buildBeer("Manyatta", { bottle: true, can: true });
await buildBeer("Pilsner", { bottle: true, can: true });
await buildBeer("Savannah Dry", { bottle: true });
await buildBeer("Savannah Lemon", { bottle: true });
await buildBeer("Smirnoff Ice Pineapple", { bottle: true, can: true }); // "S.pineapple"
await buildBeer("Snapp", { bottle: true, can: true });
await buildBeer("Tusker Lager", { bottle: true, can: true });
await buildBeer("Tusker Malt", { bottle: true, can: true });
await buildBeer("Tusker Lite", { bottle: true, can: true });
await buildBeer("Tusker Cider", { bottle: true, can: true });
await buildBeer("Tusker Ndimu", { bottle: true });
await buildBeer("Windhoek", { bottle: true });
await buildBeer("White Cap", { bottle: true, can: true });
await buildBeer("White Cap Crisp", { bottle: true, can: true });
await buildBeer("Faxe", { can: true });
await buildItem({ storeCategory: "Beer & Cider", menuCategory: "Beer & Cider", name: "Gordons Gin & Tonic (Can)", pours: [U("Can")], priceRange: beerCan });
await buildItem({ storeCategory: "Beer & Cider", menuCategory: "Beer & Cider", name: "Gordons Pink Gin & Tonic (Can)", pours: [U("Can")], priceRange: beerCan });

// ==================================================================== SOFT DRINKS & JUICES
const soft = [100, 300];
const softDrinks = [
  "Branded Water", "Coke", "Krest", "Sprite", "Stoney", "Novida", "Fanta Orange", "Fanta Passion",
  "Fanta Blackcurrant", "Lemonade", "Red Bull", "Tonic Pet", "Minute Maid", "Monster",
  "Soda Water", "Keringet Mineral Water", "Keringet Sparkling Water", "Predator", "Guarana",
];
for (const name of softDrinks) await buildItem({ storeCategory: "Soft Drinks & Juices", menuCategory: "Soft Drinks & Juices", name, pours: [U("Bottle")], priceRange: soft });
for (const flavour of ["Apple", "Mixed Berry", "Passion", "Pineapple", "Tropical", "Cranberry", "Mango"]) {
  await buildItem({ storeCategory: "Soft Drinks & Juices", menuCategory: "Soft Drinks & Juices", name: `Delmonte ${flavour}`, pours: [U("Carton")], priceRange: [150, 250] });
}
await buildItem({ storeCategory: "Soft Drinks & Juices", menuCategory: "Soft Drinks & Juices", name: "Lime Juice", pours: [U("1.5 Litre"), U("500ml")], priceRange: [200, 500] });
await buildItem({ storeCategory: "Soft Drinks & Juices", menuCategory: "Soft Drinks & Juices", name: "Dasani Water", pours: [U("1 Litre"), U("500ml")], priceRange: [100, 200] });

// ==================================================================== BAR SUNDRIES ("MEDICINE")
const sundries = [["Honey", "Bottle"], ["Mara Moja", "Sachet"], ["Panadol", "Sachet"], ["Kiss", "Pack"], ["Trust", "Pack"]];
for (const [name, unit] of sundries) await buildItem({ storeCategory: "Bar Sundries", menuCategory: "Bar Sundries", name, pours: [U(unit)], priceRange: [50, 300] });

// ==================================================================== CIGARETTES & TOBACCO
await buildItem({ storeCategory: "Cigarettes & Tobacco", menuCategory: "Cigarettes & Tobacco", name: "Double Switch", pours: [U("Pack")], priceRange: [300, 400] });
await buildItem({ storeCategory: "Cigarettes & Tobacco", menuCategory: "Cigarettes & Tobacco", name: "Single Switch", pours: [U("Stick")], priceRange: [20, 40] });
await buildItem({ storeCategory: "Cigarettes & Tobacco", menuCategory: "Cigarettes & Tobacco", name: "Embassy", pours: [U("Pack")], priceRange: [350, 450] });
for (const puffs of ["20k Puffs", "10k Puffs", "8k Puffs", "5k Puffs", "3k Puffs"]) {
  await buildItem({ storeCategory: "Cigarettes & Tobacco", menuCategory: "Cigarettes & Tobacco", name: `Vape ${puffs}`, pours: [U("Each")], priceRange: puffs.startsWith("20k") ? [1500, 2000] : puffs.startsWith("10k") ? [1000, 1400] : puffs.startsWith("8k") ? [800, 1100] : puffs.startsWith("5k") ? [600, 800] : [400, 600] });
}
await buildItem({ storeCategory: "Cigarettes & Tobacco", menuCategory: "Cigarettes & Tobacco", name: "Velo", pours: [U("Tin")], priceRange: [400, 600] });

console.log("\nCreated this run:", JSON.stringify(created));

const [prodCount, menuCount, variantCount, stockCount] = await Promise.all([
  prisma.product.count({ where: { tenantId: tid } }),
  prisma.menuItem.count({ where: { tenantId: tid } }),
  prisma.menuItemVariant.count({ where: { tenantId: tid } }),
  prisma.productStock.count({ where: { tenantId: tid } }),
]);
console.log(`Tenant totals now: products=${prodCount} menuItems=${menuCount} variants=${variantCount} stockRows=${stockCount}`);
console.log("\nReminder: all prices, unit costs and opening stock here are RANDOM test placeholders (no real figures were on the club's sheet). Clear Product.sellingPrice/unitCost, MenuItem.price, MenuItemVariant.price and ProductStock/InventoryMovement rows for this tenant before go-live.");

await prisma.$disconnect();
