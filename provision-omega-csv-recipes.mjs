/**
 * Omega Gardens — import the complete recipes from recipes_grouped.csv (the
 * legacy Hotel Plus export), after the approved ingredient plan.
 *
 * 1. Creates the approved missing products, each linked to its Units of Measure row.
 * 2. For each recipe: if it is one of our existing 23 (same dish), the CSV recipe
 *    replaces its ingredients (CSV wins); otherwise it is created under its CSV name.
 * 3. Attaches a recipe to a menu item only where the menu item has no recipe yet,
 *    except the 23 same-dish replacements, which keep their existing attachment.
 *
 * Idempotent: products by name, recipes by name, attachments only when empty.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
import fs from "fs";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const data = JSON.parse(fs.readFileSync(new URL("./import-complete.json", import.meta.url)));

const tid = (await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } })).id;
const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "");
const unitByName = Object.fromEntries((await prisma.unitOfMeasure.findMany({ where: { tenantId: tid } })).map((u) => [u.name.toLowerCase(), u.id]));

// 1. products
let cat = await prisma.category.findFirst({ where: { tenantId: tid, scope: "STORE", parentId: null, name: "Restaurant Ingredients" } });
if (!cat) cat = await prisma.category.create({ data: { tenantId: tid, scope: "STORE", name: "Restaurant Ingredients", parentId: null, level: 1 } });
let created = 0;
for (const [name, unitName] of Object.entries(data.createProducts)) {
  if (await prisma.product.findFirst({ where: { tenantId: tid, name } })) continue;
  const unitId = unitByName[unitName.toLowerCase()];
  if (!unitId) throw new Error(`UOM "${unitName}" missing for ${name}`);
  await prisma.product.create({ data: { tenantId: tid, categoryId: cat.id, name, unit: unitName.toLowerCase(), unitId, unitCost: null, sellsDirectly: false } });
  created++;
}
console.log(`Products created: ${created}`);

// 2. recipes — CSV name -> our existing recipe it replaces
const SAME_DISH = {
  "CHICKEN BURGER": "Chicken Burger", "BEEF BURGER": "Traditional Beef Burger", "CHICKEN NUGGET": "Chicken Nuggets",
  "OMEGA GARDENS SALAD": "Omega Gardens Salad", "CHICKEN SALAD": "Omega Chicken Salad", "FISH SALAD": "Omega Fish Salad",
  "MIXED VEG CURRY": "Vegetable Curry", "CABONARA PASTA": "Carbonara Pasta", "OMEGA SPECIAL COUNTRY SIDE CHICKEN": "Full Omega Special Country-Side Chicken",
  "MEGA PIZZA": "Mega Pizza", "LARGE BBQ CHICKEN PIZZA": "BBQ Chicken Pizza (Large)", "LARGE MEAT DELUXE": "Meat Deluxe Pizza (Large)",
  "MARGHERITA PIZZA LARGE": "Margherita Pizza (Large)", "VEGGIE FEAST(LARGE)": "Veggie Feast Pizza (Large)", "FISH FINGER": "Crispy Fish Fingers",
  "PLATTER IDEAL FOR 1": "Mixed Grilled Platter (1)", "PLATTER IDEAL FOR 2": "Mixed Grilled Platter (2)", "PLATTER IDEAL FOR FAMILY.": "Mixed Grilled Platter (Family)",
};
const existing = await prisma.recipe.findMany({ where: { tenantId: tid }, select: { id: true, name: true } });
const recipeByName = new Map(existing.map((r) => [r.name, r]));
let replaced = 0, createdRecipes = 0;
const recipeIdByCsvName = {};
for (const r of data.recipes) {
  const targetName = SAME_DISH[r.name] ?? r.name.replace(/\s+/g, " ").trim();
  const products = await Promise.all(r.ingredients.map((i) => prisma.product.findFirstOrThrow({ where: { tenantId: tid, name: i.product } })));
  const rows = r.ingredients.map((i, idx) => ({ productId: products[idx].id, quantity: Math.round(i.qty * 1000) / 1000 })).filter((x) => x.quantity > 0);
  let recipe = recipeByName.get(targetName);
  if (recipe && SAME_DISH[r.name]) {
    await prisma.recipeIngredient.deleteMany({ where: { recipeId: recipe.id } });
    await prisma.recipeIngredient.createMany({ data: rows.map((x) => ({ recipeId: recipe.id, ...x })) });
    replaced++;
  } else if (!recipe) {
    recipe = await prisma.recipe.create({ data: { tenantId: tid, name: targetName, ingredients: { create: rows } } });
    createdRecipes++;
    recipeByName.set(targetName, recipe);
  } else {
    continue; // a recipe with this name already exists and is not a known replacement
  }
  recipeIdByCsvName[r.name] = recipe.id;
}
console.log(`Recipes replaced (CSV wins): ${replaced} | created: ${createdRecipes}`);

// 3. attach to menu items with no recipe yet (base items only)
const menu = await prisma.menuItem.findMany({ where: { tenantId: tid }, select: { id: true, name: true, recipeId: true, _count: { select: { variants: true } } } });
let attached = 0;
for (const r of data.recipes) {
  const recipeId = recipeIdByCsvName[r.name];
  if (!recipeId) continue;
  const dish = SAME_DISH[r.name];
  const hit = menu.find((m) => (dish ? m.name === dish.replace(/ \(Large\)$/, "") : norm(m.name) === norm(r.name)) && m._count.variants === 0);
  if (hit && !hit.recipeId) {
    await prisma.menuItem.update({ where: { id: hit.id }, data: { recipeId } });
    attached++;
  }
}
console.log(`Menu items newly attached: ${attached}`);
await prisma.$disconnect();
