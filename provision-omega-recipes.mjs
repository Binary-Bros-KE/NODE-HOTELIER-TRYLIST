/**
 * Omega Gardens Hotel and Spa — recipes, phase 3 of 3, first batch: the 23
 * dishes with a confident recipe match out of 46 transcribed sheets (see
 * omega_recipes_transcribed.md). The other 23 sheets were sub-recipes
 * (Curry Sauce, Tomato Concassé, Demi-glace, bread production), a dish not
 * on the menu (Whole Mbuzi), ambiguous wet/dry-fry namings with no clean
 * menu target, or an explicitly-flagged incomplete note (Hawaiian pizza) —
 * none of those are built here.
 *
 * Real judgment calls made converting the sheets' cooking measures into the
 * store's stock units (kg/pc/litre/packet/tin/portion — see phase 1):
 *   - A bare fraction (0.125, 0.25, 0.5...) against a product already
 *     counted in "kg" or "pc" is read as that fraction of ONE stock unit
 *     (e.g. Beef 0.125 = 125g; Chic Broilers 0.125 = 1/8 of a whole bird) —
 *     this matches the source's own numbers without any invented factor.
 *   - Tablespoon = 15g/15ml, teaspoon = 5g/5ml, pinch = 0.5g, "dust" = 5g —
 *     standard kitchen conversions, then divided by the matched product's
 *     known package size (e.g. Garam Masala's 100g packet).
 *   - A piece-count against a KG-tracked vegetable (onion, tomato, carrot,
 *     baby marrow) uses an average retail weight: onion 150g, tomato 120g,
 *     carrot 100g, baby marrow 150g, lemon 90g, ham slice 30g.
 *   - Where quantity was blank ("—") but a cost was printed, and the
 *     matched product already has a known unitCost from phase 1, quantity
 *     was back-calculated as cost ÷ unitCost — derived from the sheets' own
 *     numbers rather than guessed.
 *   - No lamb, ground/minced beef, or chicken-drumstick/breast SKUs exist
 *     yet — substituted with Mutton, Beef, and a fractional Chic Broilers
 *     respectively. Three genuinely missing ingredients (ginger-garlic
 *     paste, garden peas, cocoa powder) get minimal new Products here
 *     (0 stock, cost unknown) rather than being silently dropped.
 *   - Skipped outright (no defensible number): bread crumbs, chopped mint,
 *     flour dust with no amount, mayonnaise with no amount, and "Soda 1
 *     Litre" in the three meat pizzas (reads like a stray/miscopied line —
 *     a full litre of soft drink in pizza dough makes no sense, and it
 *     doesn't match any bicarbonate/soda-ash ingredient either).
 *
 * Recipes are attached per-variant where the sheet was explicit about size
 * (the 4 non-Mega pizzas: Large only — Small/Medium stay unrecipe'd since
 * no sheet covers them). Everything else attaches directly to the MenuItem.
 *
 * Idempotent: upserts Products/Recipes by name; skips a MenuItem/Variant
 * that already has a recipeId set.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const data = JSON.parse(fs.readFileSync(new URL("./omega-recipes.json", import.meta.url)));

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;
const mainStore = await prisma.location.findFirstOrThrow({ where: { tenantId: tid, name: "Main Store" } });
console.log(`Tenant: ${tenant.name} (${tid})`);

async function upsertCategory(name) {
  const existing = await prisma.category.findFirst({ where: { tenantId: tid, scope: "STORE", parentId: null, name } });
  if (existing) return existing;
  return prisma.category.create({ data: { tenantId: tid, scope: "STORE", name, parentId: null, level: 1 } });
}

for (const np of data.newProducts) {
  const existing = await prisma.product.findFirst({ where: { tenantId: tid, name: np.name } });
  if (existing) continue;
  const cat = await upsertCategory(np.category);
  const product = await prisma.product.create({ data: { tenantId: tid, name: np.name, categoryId: cat.id, unit: np.unit, unitCost: null, sellsDirectly: false } });
  const { recordStockMovement } = await import("./dist/lib/stockLedger.js");
  await prisma.$transaction(async (tx) => {
    await recordStockMovement(tx, { tenantId: tid, productId: product.id, locationId: mainStore.id, type: "OPENING_STOCK", quantity: 0, note: "New product added for recipe import — cost/stock to be filled in" });
  });
  console.log(`Created new product: ${np.name}`);
}

async function findProduct(name) {
  const p = await prisma.product.findFirst({ where: { tenantId: tid, name } });
  if (!p) throw new Error(`Product not found: "${name}"`);
  return p;
}

let recipesCreated = 0, ingredientsCreated = 0, attached = 0, skippedAlready = 0;

for (const r of data.recipes) {
  let recipe = await prisma.recipe.findFirst({ where: { tenantId: tid, name: r.recipeName } });
  if (!recipe) {
    recipe = await prisma.recipe.create({ data: { tenantId: tid, name: r.recipeName } });
    recipesCreated++;
    for (const ing of r.ingredients) {
      const product = await findProduct(ing.product);
      await prisma.recipeIngredient.create({ data: { recipeId: recipe.id, productId: product.id, quantity: ing.quantity } });
      ingredientsCreated++;
    }
  }

  if (r.variantLabel) {
    const menuItem = await prisma.menuItem.findFirstOrThrow({ where: { tenantId: tid, name: r.menuItem }, include: { variants: true } });
    const variant = menuItem.variants.find((v) => v.name === r.variantLabel);
    if (!variant) throw new Error(`Variant "${r.variantLabel}" not found on "${r.menuItem}"`);
    if (variant.recipeId) { skippedAlready++; continue; }
    await prisma.menuItemVariant.update({ where: { id: variant.id }, data: { recipeId: recipe.id } });
    attached++;
    console.log(`Attached "${recipe.name}" -> ${r.menuItem} (${r.variantLabel})`);
  } else {
    const menuItem = await prisma.menuItem.findFirstOrThrow({ where: { tenantId: tid, name: r.menuItem } });
    if (menuItem.recipeId) { skippedAlready++; continue; }
    await prisma.menuItem.update({ where: { id: menuItem.id }, data: { recipeId: recipe.id } });
    attached++;
    console.log(`Attached "${recipe.name}" -> ${r.menuItem}`);
  }
}

console.log(`\nRecipes created: ${recipesCreated} | Ingredients created: ${ingredientsCreated} | Attached: ${attached} | Already had a recipe (skipped): ${skippedAlready}`);
await prisma.$disconnect();
