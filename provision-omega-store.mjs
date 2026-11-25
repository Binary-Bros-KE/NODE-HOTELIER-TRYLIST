/**
 * Omega Gardens Hotel and Spa — restaurant store stock import, Phase 1 of 3
 * (client's own plan: 1. store items + cost, 2. menu from a PDF, 3. recipes
 * linking menu items to these store products). Source: "Store stock
 * 23rd.xlsx" (single sheet, opening stock as at 23/9/2026).
 *
 * This phase is Products + stock only — no menu items, no recipes yet.
 * Every item is counted whole in its own natural unit (kg, litre, pc,
 * carton, sachet, bottle, tin, bunch, packet, gram, ml, portion) — no
 * pack/pour modelling, this isn't bar stock.
 *
 * store-items.json (next to this script) is the parsed, cleaned sheet data
 * — see build-store-data.js in the session scratchpad for exactly how each
 * item's unit was derived (mostly the "/KG"-style suffix already on the
 * sheet's own item names; a few fallbacks and spelling fixes are documented
 * there). This script's own job is just: assign each item to a sensible
 * STORE category, then create the Product + opening ProductStock.
 *
 * Idempotent: upserts by name; re-running never resets a price or quantity
 * that's already there.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const items = JSON.parse(fs.readFileSync(new URL("./store-items.json", import.meta.url)));

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;
const mainStore = await prisma.location.findFirstOrThrow({ where: { tenantId: tid, name: "Main Store" } });
console.log(`Tenant: ${tenant.name} (${tid}) — location: ${mainStore.name} (${mainStore.id})`);

// Every item's raw sheet key, bucketed into a sensible STORE category.
// Validated below to cover the full parsed list exactly (fails loudly if
// anything's missing or double-booked) rather than silently dropping rows.
const CATEGORY_MAP = {
  "Meat & Poultry": [
    "BEEF/KG", "MUTTON/KG", "PORK/KG", "CHIC KIENYEJI/PC", "CHIC BROILERS/PC", "SAUSAGES/PC", "HAM/KG",
    "BACON/PTN", "BEEF CUBES90GM", "CHICKEN CUBES90GM",
  ],
  "Fish & Seafood": ["WHOLE FISH/PC", "FISH FILLETS/PTN"],
  "Dairy & Eggs": ["CHEESE/KG", "MILK/LTR", "EGGS/PC", "WHIPPING CREAM", "LALA 1LTR", "YOGHURT 1LTR", "CROMA 1KG", "BLUE BAND 1KG"],
  "Fresh Produce": [
    "POTATOS 15KG/ 1 DEBE", "ONIONS /KG", "TOMATOES /KG", "CARROTS/KG", "PASSION /KG", "TREE TOMATOES/KG",
    "LEMONS/KG", "ORANGES/KG", "GINGER/KG", "GARLIC/KG", "HOHO/KG", "BABY MARROW/KG", "CUCUMBER/KG",
    "RED CABBAGE/PC", "LETTUCE/PC", "NDUMA/PC", "NGWACI/PC", "GREEN CHILLI/KG", "SPINACH/KG", "TERERE/KG",
    "MANGOES/PC", "MANAGU/", "RAW BANANA/BUNCH", "RIPE BANANA/BUNCH", "PAW PAW/PC", "PINEAPPLES/PC",
    "WATER MELON/KG", "OVACADOS/PC", "BUTTERNUT/PC", "CABBAGE/PC", "BROCCOLI/KG", "PLAINTAIN/KG", "EGG PLANT/KG",
  ],
  "Grains, Flour & Baking": [
    "WHEAT FLOUR 2KG", "SELF RAISING FLOUR 2KG", "ATTA MARK FLOUR 2KG", "MAIIZE FLOUR 1KG", "MAIZE FLOUR 2KGS",
    "YEAST 500GM", "BAKING POWDER 100GM", "BI CARBONATE 100GMS", "BREAD IMPROVER 1KG", "CALCIUM 1KG",
    "PASTRY MAGERINE 5KG", "ICING SUGAR500ML", "COOKING FAT 1KG", "COOKING OIL 10LTRS", "RICE BIRYANI 1KG",
    "RICE PISHORI 1KG", "PENE PASTA500GM", "SPAGHETTI 500GM", "BEANS1KG", "GREEN MAIZE", "COMPOUND CHOC 2.5KG",
    "INDOMIE", "WEETABIX 425GM", "CORN FLAKES500GM",
  ],
  "Spices & Seasoning": [
    "CHILLI 250GM", "SALT 1KG", "GARAM MASALA100GM", "TURMERIC100GM", "TEA MASALA100GM", "PILAU MASALA100GMS",
    "CURRY POWDER 100GM", "CURRY POWDER  SACHET 10GMS", "PAPRIKA 200GMS", "ROSEMARY50GMS", "OREGANO", "THYME",
    "CARDMON 100G M", "CAYYENNE100GM", "CUMMIN 50GM", "CINNAMON 100GM", "BASIL 50GM", "AJINO MOTO 100GM",
    "WHITE PEPPER POWDER 100GM", "BLACK PEPPR 100GM", "SALT SACHETS/PC", "CHILLI SACHET 6GRAMS",
  ],
  "Sauces, Syrups & Condiments": [
    "SOY SAUCE625ML", "OYESTER625ML", "VINEGAR 700ML", "BLUE BERRY SYRUP750ML", "CARAMEL SYRUP750ML",
    "CHOCOLATE SYRUP750ML", "GRANADINE750ML", "KETCHUP SACHET", "KETCHUP  400GMS", "KETCHUP 700GMS",
    "TOMATO SAUCE 5LTRS", "MUSTARD 300ML", "WORCASTLE SAUCE 250ML", "MARPLE  SYRUP", "MAYYONAISE",
    "ZESTA JAM 500GM", "OLIVE OIL 0.5ML",
  ],
  "Canned & Jarred Goods": ["SWEET CORN500GM", "SWEET CORN500GM", "COCONUT MILK500ML", "BAKED BEANS500GM", "MUSHROOM500GMS", "TOMATO PASTE 900G M"],
  "Beverages": [
    "SODAS 1LTR", "LIME1.5LTRS", "COFFEE BEANS1KG", "COFFEE SACHETS/PC", "TEA LEAVES 250GM", "TEA LEAVES 100GMS",
    "TEA BAG 500GM", "MILO SACHETS", "MILO 400GM", "MINERAL WATER 500ML", "STRAWBERRY ESS 200ML",
    "PINACO LADA ESS 50ML", "VANILLA ESS200ML",
  ],
  "Sugar, Sweeteners & Baking Extras": [
    "SUGAR 1KG", "SUGAR SACHETS/PC", "HONEY 1KG", "HONEY CUPS/PC", "CHOCOLATE SACHETS 10GMS", "RED CHERRIES",
    "SULTANAS 50GM", "RAISINS 500GM", "FOOD COLOURS 10GM", "ICE CREAM/CRT",
  ],
  "Packaging & Disposables": [
    "PACKING DISHES/PC", "COFFEE CUPS/PC", "PACKING BAGS 6*9/PC", "PACKING BAGS7*10/PC", "TOOTH PICKS/SACHET",
    "DISPOSABLE CUPS", "TISSUE1PC", "SERVIETTES 1PCT", "LARGE PIZZA BOX", "MEDIUM PIZZA BOX", "SMALL PIZZA BOX",
    "THERMAL ROLLS", "STRAWS",
  ],
};

// Coverage check: every parsed item accounted for exactly once (respecting
// the one genuine duplicate row the sheet itself has - Sweet Corn twice).
const rawCounts = {};
for (const it of items) rawCounts[it.raw] = (rawCounts[it.raw] || 0) + 1;
const mappedCounts = {};
for (const keys of Object.values(CATEGORY_MAP)) for (const k of keys) mappedCounts[k] = (mappedCounts[k] || 0) + 1;
const problems = [];
for (const [raw, count] of Object.entries(rawCounts)) if (mappedCounts[raw] !== count) problems.push(`"${raw}": in sheet ${count}x, mapped ${mappedCounts[raw] || 0}x`);
for (const [raw, count] of Object.entries(mappedCounts)) if (!rawCounts[raw]) problems.push(`"${raw}": mapped but not in sheet at all`);
if (problems.length) { console.error("COVERAGE MISMATCH:\n" + problems.join("\n")); process.exit(1); }
console.log(`Coverage OK: ${items.length} items all mapped to a category.`);

const categoryByRaw = {};
for (const [cat, keys] of Object.entries(CATEGORY_MAP)) for (const k of keys) if (!(k in categoryByRaw)) categoryByRaw[k] = cat;

async function upsertCategory(name) {
  const existing = await prisma.category.findFirst({ where: { tenantId: tid, scope: "STORE", parentId: null, name } });
  if (existing) return existing;
  return prisma.category.create({ data: { tenantId: tid, scope: "STORE", name, parentId: null, level: 1 } });
}
const categoryCache = {};
async function categoryFor(name) {
  if (!categoryCache[name]) categoryCache[name] = await upsertCategory(name);
  return categoryCache[name];
}

async function ensureProduct({ name, categoryId, unit, unitCost }) {
  const existing = await prisma.product.findFirst({ where: { tenantId: tid, name } });
  if (existing) return { product: existing, isNew: false };
  const product = await prisma.product.create({
    data: { tenantId: tid, categoryId, name, unit, unitCost: unitCost ?? null, sellsDirectly: false },
  });
  return { product, isNew: true };
}

async function setOpeningStock(productId, quantity, unitCost) {
  const existing = await prisma.productStock.findFirst({ where: { tenantId: tid, productId, locationId: mainStore.id } });
  if (existing) return;
  const { recordStockMovement } = await import("./dist/lib/stockLedger.js");
  await prisma.$transaction(async (tx) => {
    await recordStockMovement(tx, {
      tenantId: tid, productId, locationId: mainStore.id, type: "OPENING_STOCK",
      quantity, unitCost: unitCost ?? undefined, note: "Store stock 23rd.xlsx import — opening stock",
    });
  });
}

let created = 0;
for (const item of items) {
  const catName = categoryByRaw[item.raw];
  const cat = await categoryFor(catName);
  const { product, isNew } = await ensureProduct({ name: item.name, categoryId: cat.id, unit: item.unit, unitCost: item.cost });
  if (isNew) created++;
  await setOpeningStock(product.id, item.qty, item.cost);
}

console.log(`Created ${created} new products this run.`);
const [prodCount, stockCount, catCount] = await Promise.all([
  prisma.product.count({ where: { tenantId: tid } }),
  prisma.productStock.count({ where: { tenantId: tid } }),
  prisma.category.count({ where: { tenantId: tid, scope: "STORE" } }),
]);
console.log(`Tenant totals now: products=${prodCount} stockRows=${stockCount} storeCategories=${catCount}`);
await prisma.$disconnect();
