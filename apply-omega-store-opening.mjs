/**
 * Omega Gardens — override the Main Store balances with the 10 Oct opening
 * stock sheet. Products with the STORE tag that are not on the sheet go to 0.
 * DRY run by default; APPLY=1 writes. Every change is an ADJUSTMENT in the ledger.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
import fs from "fs";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const { recordStockMovement } = await import("./dist/lib/stockLedger.js");
const APPLY = process.env.APPLY === "1";

const sheet = JSON.parse(fs.readFileSync(new URL("./store-opening-1010.json", import.meta.url)));
const tid = (await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } })).id;
const store = await prisma.location.findFirstOrThrow({ where: { tenantId: tid, type: "STORE" }, select: { id: true, name: true } });
const products = await prisma.product.findMany({ where: { tenantId: tid }, select: { id: true, name: true, unit: true, tags: true, packSize: true } });
const stocks = await prisma.productStock.findMany({ where: { tenantId: tid, locationId: store.id }, select: { productId: true, quantity: true } });
const onHand = new Map(stocks.map((s) => [s.productId, Number(s.quantity)]));

const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "");
const baseName = (item) => item.split("/")[0].trim();

// Sheet names that don't match a product name by spelling alone.
const ALIAS = {
  "SODAS 1LTR": "Sodas 1 Ltr", "PINACO LADA ESS 50ML": "Pina Colada Ess 50 Ml", "CARDMON 100G M": "Cardamom 100 Gm", "LIME1.5LTRS": "Lime 1.5 Ltrs", "MAIIZE FLOUR 1KG": "Maize Flour 1 Kg",
  "BLUE BERRY SYRUP750ML": "Blue Berry Syrup 750 Ml", "CARAMEL SYRUP750ML": "Caramel Syrup 750 Ml",
  "CHOCOLATE SYRUP750ML": "Chocolate Syrup 750 Ml", "GRANADINE750ML": "Granadine 750 Ml", "OYESTER625ML": "Oyester 625 Ml",
  "SOY SAUCE625ML": "Soy Sauce 625 Ml", 
  "CURRY POWDER  SACHET 10GMS": "Curry Powder Sachet 10 Gms", "TISSUE1PC": "Tissue Paper", "SERVIETTES 1PCT": "Serviettes 1 Pct",
  "MINERAL WATER 500ML": "Mineral Water 500 Ml", "WHITE PEPPER POWDER 50GM": "White Pepper Powder 100 Gm",
  "BLACK PEPPR 50GM": "Black Pepper 100 Gm", "MARPLE  SYRUP": "Maple Syrup", "CARDMON 100GM": "Cardamom 100 Gm",
  "CAYYENNE100GM": "Cayyenne 100 Gm", "CUMMIN 50GM": "Cumin 50 Gm", "TOMATO PASTE 900G M": "Tomato Paste 900 Gm",
  "WORCASTLE SAUCE 250ML": "Worcester Sauce 250 Ml", "COMPOUND CHOC 2.5KG": "Compound Choc 2.5 Kg",
  "BI CARBONATE 100GMS": "Bi Carbonate 100 Gms", "FOOD COLOURS 10GM": "Food Colours 10 Gm",
  "EGG PLANT/KG": "Egg Plant", "MANAGU/": "Managu", "OVACADOS/PC": "Avocados", "PAW PAW/PC": "Paw Paw",
  "RAW BANANA/BUNCH": "Raw Banana", "RIPE BANANA/BUNCH": "Ripe Banana", "PASSION /KG": "Passion",
  "TREE TOMATOES/KG": "Tree Tomatoes", "ONIONS /KG": "Onions", "TOMATOES /KG": "Tomatoes", "COOKING OIL": "Cooking Oil 10 Ltrs",
  "POTATOS 15KG/ 1 DEBE": "Potatos 15 Kg/ 1 Debe", "CHIC BROILERS/PC": "Chic Broilers", "CHIC KIENYEJI/PC": "Chic Kienyeji",
  "FISH FILLETS/PTN": "Fish Fillets", "BACON/PTN": "Bacon", "ICE CREAM/CRT": "Ice Cream", "MILK/LTR": "Milk",
  "MAYYONAISE": "Mayonnaise", "KETCHUP  400GMS": "Ketchup 400 Gms", "KETCHUP 700GMS": "Ketchup 700 Gms",
  "CHILLI SACHET 6GRAMS": "Chilli Sachet 6 Grams", "INDOMIE": "Indomie", "STRAWBERRY ESS 200ML": "Strawberry Ess 200 Ml",
  "VANILLA ESS200ML": "Vanilla Ess 200 Ml", "PACKING BAGS 6*9/PC": "Packing Bags 6*9", "PACKING BAGS7*10/PC": "Packing Bags 7*10",
  "SALT SACHETS/PC": "Salt Sachets", "COFFEE SACHETS/PC": "Coffee Sachets", "SUGAR SACHETS/PC": "Sugar Sachets",
  "CHOCOLATE SACHETS 10GMS": "Chocolate Sachets 10 Gms", "HONEY CUPS/PC": "Honey Cups", "HONEY 1KG": "Honey 1 Kg",
  "CHILLI 250GM": "Chilli 250 Gm", "TEA LEAVES 250GM": "Tea Leaves 250 Gm", "TEA LEAVES 100GMS": "Tea Leaves 100 Gms",
  "SPAGHETTI 500GM": "Spaghetti 500 Gm", "PENE PASTA500GM": "Pene Pasta 500 Gm", "COCONUT MILK500ML": "Coconut Milk 500 Ml",
  "BAKED BEANS500GM": "Baked Beans 500 Gm", "MUSHROOM500GMS": "Mushroom 500 Gms", "TEA MASALA100GM": "Tea Masala 100 Gm",
  "PILAU MASALA100GMS": "Pilau Masala 100 Gms", "CURRY POWDER 100GM": "Curry Powder 100 Gm", "PAPRIKA 200GMS": "Paprika 200 Gms",
  "ROSEMARY50GMS": "Rosemary 50 Gms", "ZESTA JAM 500GM": "Zesta Jam 500 Gm", "BASIL 50GM": "Basil 50 Gm",
  "YEAST 500GM": "Yeast 500 Gm", "AJINO MOTO 100GM": "Ajinomoto 100 Gm", "WEETABIX 425GM": "Weetabix 425 Gm",
  "CORN FLAKES500GM": "Corn Flakes 500 Gm", "PASTRY MAGERINE 5KG": "Pastry Magerine 5 Kg", "TURMERIC100GM": "Turmeric 100 Gm",
  "GARAM MASALA100GM": "Garam Masala 100 Gm", "RICE BIRYANI 1KG": "Rice Biryani 1 Kg", "RICE PISHORI 1KG": "Rice Pishori 1 Kg",
  "WHEAT FLOUR 2KG": "Wheat Flour 2 Kg", "SELF RAISING FLOUR 2KG": "Self Raising Flour 2 Kg", "ATTA MARK FLOUR 2KG": "Atta Mark Flour 2 Kg",
  "MAIZE FLOUR 2KGS": "Maize Flour 2 Kgs", "TOMATO SAUCE 5LTRS": "Tomato Sauce 5 Ltrs", "VINEGAR 700ML": "Vinegar 700 Ml",
  "SULTANAS 50GM": "Sultanas 50 Gm", "RAISINS 500GM": "Raisins 500 Gm", "BEANS1KG": "Beans 1 Kg",
  "ICING SUGAR500ML": "Icing Sugar 500 Ml", "COFFEE BEANS1KG": "Coffee Beans 1 Kg", "SWEET CORN500GM": "Sweet Corn 500 Gm",
  "MILO SACHETS": "Milo Sachets", "PACKING DISHES": "Packing Dishes", "LARGE PIZZA BOX": "Large Pizza Box",
  "MEDIUM PIZZA BOX": "Medium Pizza Box", "SMALL PIZZA BOX": "Small Pizza Box", "TOOTH PICKS/SACHET": "Tooth Picks",
  "CHICKEN CUBES90GM": "Chicken Cubes 90 Gm", "BEEF CUBES90GM": "Beef Cubes 90 Gm", "OLIVE OIL 0.5ML": "Olive Oil 0.5 Ml",
  "BAKING POWDER 100GM": "Baking Powder 100 Gm", "CALCIUM 1KG": "Calcium 1 Kg", "BREAD IMPROVER 1KG": "Bread Improver 1 Kg",
  "TEA BAG 500GM": "Tea Bag 500 Gm", "MILO 400GM": "Milo 400 Gm", "BLUE BAND 1KG": "Blue Band 1 Kg", "COOKING FAT 1KG": "Cooking Fat 1 Kg",
  "THERMAL ROLLS": "Thermal Rolls", "THYME": "Thyme", "OREGANO": "Oregano", "LALA 1LTR": "Lala 1 Ltr", "YOGHURT 1LTR": "Yoghurt 1 Ltr",
  "CROMA 1KG": "Croma 1 Kg", "STRAWS": "Straws", "DISPOSABLE CUPS": "Disposable Cups", "COFFEE CUPS/PC": "Coffee Cups",
  "BI CARBONATE 100GMS": "Bi Carbonate 100 Gms", "GREEN MAIZE": "Green Maize", "RED CHERRIES": "Red Cherries",
  "MAYYONAISE ": "Mayonnaise", "WHIPPING CREAM": "Whipping Cream", "SUGAR 1KG": "Sugar 1 Kg", "SALT 1KG": "Salt 1 Kg",
  "GINGER/KG": "Ginger", "GARLIC/KG": "Garlic", "HOHO/KG": "Hoho", "BABY MARROW/KG": "Baby Marrow", "CUCUMBER/KG": "Cucumber",
  "CARROTS/KG": "Carrots", "PLAINTAIN/KG": "Plaintain", "WATER MELON/KG": "Water Melon", "MANGOES/PC": "Mangoes",
  "BUTTERNUT/PC": "Butternut", "CABBAGE/PC": "Cabbage", "BROCCOLI/KG": "Broccoli", "GREEN CHILLI/KG": "Green Chilli",
  "SPINACH/KG": "Spinach", "TERERE/KG": "Terere", "RED CABBAGE/PC": "Red Cabbage", "LEMONS/KG": "Lemons", "ORANGES/KG": "Oranges",
  "LETTUCE/PC": "Lettuce", "NDUMA/PC": "Nduma", "NGWACI/PC": "Ngwaci", "WATER MELON/KG ": "Water Melon", "HAM/KG": "Ham",
  "CHEESE/KG": "Cheese", "SAUSAGES/PC": "Sausages", "EGGS/PC": "Eggs", "WHOLE FISH/PC": "Whole Fish", "BEEF/KG": "Beef",
  "MUTTON/KG": "Mutton", "PORK/KG": "Pork", "STRAWBERRY ESS 200ML ": "Strawberry Ess 200 Ml",
};

function productFor(item) {
  const alias = ALIAS[item.toUpperCase()] ?? ALIAS[item.toUpperCase().trim()] ?? ALIAS[baseName(item).toUpperCase()];
  if (alias) return products.find((p) => p.name === alias) ?? null;
  const n = norm(baseName(item));
  const exact = products.filter((p) => norm(p.name) === n);
  if (exact.length) return exact[0];
  const starts = products.filter((p) => norm(p.name).startsWith(n)).sort((a, b) => a.name.length - b.name.length);
  return starts[0] ?? null;
}

// "1.25kg" / "23pcs" / "2LTRSltrs" / "0.3ml" -> { qty, unit }
function readQty(text) {
  const t = String(text ?? "").toLowerCase().trim();
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/);
  if (!m) return { qty: 0, unit: "" };
  return { qty: Number(m[1]), unit: m[2].trim() };
}
// Size from the product name, in grams or ml. "Honey 1 Kg" -> 1000 g.
function nameSizeBase(name) {
  const m = name.match(/(\d+(?:\.\d+)?)\s*(kgs?|ltrs?|litre|gms?|gm|ml)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u.startsWith("kg")) return n * 1000;
  if (u.startsWith("l")) return n * 1000;
  if (u.startsWith("g")) return n;
  return n;
}
// Convert a sheet quantity into the product's own stock unit.
function toStockUnit(product, qty, unitText) {
  const pu = (product.unit || "").toLowerCase();
  const isKg = /kg/.test(unitText);
  const isG = /(^|[^k])g/.test(unitText) && !isKg;
  const isL = /ltr|litre|^l$/.test(unitText);
  const isMl = /ml/.test(unitText);
  const isMass = isKg || isG;
  const isVol = isL || isMl;
  const toGrams = (q) => (isKg ? q * 1000 : q);
  const toMl = (q) => (isL ? q * 1000 : q);
  // Syrups counted as "0.3ml" etc. are fractions of a bottle, not millilitres.
  if (isMl && !isL && qty < 10) {
    if (pu === "ml") return { qty: +(qty * (nameSizeBase(product.name) ?? 1)).toFixed(3), note: "read as a fraction of a bottle" };
    if (!["kg", "gram", "litre"].includes(pu)) return { qty, note: "read as a fraction of a bottle" };
  }
  if (pu === "kg") return isVol ? { qty, note: "volume text on a kg product, kept as given" } : { qty: isG ? qty / 1000 : qty };
  if (pu === "gram") return isMass ? { qty: toGrams(qty) } : { qty };
  if (pu === "litre") return isVol ? { qty: isMl ? qty / 1000 : qty } : { qty };
  if (pu === "ml") return isVol ? { qty: toMl(qty) } : { qty };
  if (isMass || isVol) {
    const size = nameSizeBase(product.name);
    if (!size) return { qty, note: "no pack size in the name; kept as given" };
    const base = isMass ? toGrams(qty) : toMl(qty);
    return { qty: +(base / size).toFixed(3), note: "converted to packs using the name size" };
  }
  return { qty };
}

const plan = [];
const unmatched = [];
const used = new Set();
for (const row of sheet) {
  const product = productFor(row.item);
  if (!product) { unmatched.push(row.item); continue; }
  if (used.has(product.id)) { unmatched.push(`${row.item} (duplicate of ${product.name})`); continue; }
  used.add(product.id);
  const { qty, unit } = readQty(row.storeBal);
  const conv = toStockUnit(product, qty, unit);
  plan.push({ sheet: row.item, sheetQty: row.storeBal, product: product.name, productUnit: product.unit, productId: product.id, target: conv.qty, note: conv.note ?? "" });
}
// Other STORE-tagged products go to zero.
const zeroed = products.filter((p) => p.tags.includes("STORE") && !used.has(p.id) && (onHand.get(p.id) ?? 0) !== 0);

console.log(`sheet rows ${sheet.length} | matched ${plan.length} | unmatched ${unmatched.length} | STORE products not on sheet with stock ${zeroed.length}`);
console.log("\nUNMATCHED SHEET ROWS:\n" + unmatched.map((u) => "  " + u).join("\n"));
console.log("\nTO ZERO:\n" + zeroed.map((p) => `  ${p.name} (now ${onHand.get(p.id)})`).join("\n"));
console.log("\nMAPPING:");
for (const p of plan) console.log(`  ${p.sheet.padEnd(28)} ${p.sheetQty.padEnd(12)} -> ${p.product.padEnd(30)} [${p.productUnit}] = ${p.target} ${p.note ? "(" + p.note + ")" : ""}`);

if (APPLY) {
  let changed = 0;
  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      const current = onHand.get(p.productId) ?? 0;
      const delta = p.target - current;
      if (Math.abs(delta) < 1e-9) continue;
      await recordStockMovement(tx, { tenantId: tid, productId: p.productId, locationId: store.id, type: "ADJUSTMENT", quantity: +delta.toFixed(3), allowNegative: true, note: "Opening stock 10 Oct (override from sheet)", label: p.product });
      changed++;
    }
    for (const z of zeroed) {
      const current = onHand.get(z.id) ?? 0;
      await recordStockMovement(tx, { tenantId: tid, productId: z.id, locationId: store.id, type: "ADJUSTMENT", quantity: +(-current).toFixed(3), allowNegative: true, note: "Not on the 10 Oct store sheet: set to zero", label: z.name });
      changed++;
    }
  });
  console.log(`\nAPPLIED: ${changed} ledger adjustments at ${store.name}`);
} else {
  console.log("\nDRY RUN - nothing written. Set APPLY=1 to write.");
}
await prisma.$disconnect();
