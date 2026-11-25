/**
 * Omega Gardens — placeholder recipes for sellable food and drink units that
 * have no recipe yet. Each one is named "(placeholder)" so the chef can find
 * and correct it. Source: placeholders.json (generated from the gap report).
 *
 * Idempotent: a recipe is reused by name, and a unit is only attached when it
 * still has no recipe. Stops before writing anything if an ingredient name
 * does not match a product exactly.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
import fs from "fs";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const plan = JSON.parse(fs.readFileSync(new URL("./placeholders.json", import.meta.url)));

const tid = (await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } })).id;
const products = await prisma.product.findMany({ where: { tenantId: tid }, select: { id: true, name: true } });
const productByName = new Map(products.map((p) => [p.name, p.id]));

const missing = new Set();
for (const row of plan) for (const i of row.ingredients) if (!productByName.has(i.product)) missing.add(i.product);
if (missing.size > 0) throw new Error(`Products not found: ${[...missing].join(", ")}`);

const existing = await prisma.recipe.findMany({ where: { tenantId: tid }, select: { id: true, name: true } });
const recipeByName = new Map(existing.map((r) => [r.name, r.id]));

let created = 0, attached = 0, skipped = 0;
for (const row of plan) {
  let recipeId = recipeByName.get(row.recipeName);
  if (!recipeId) {
    const recipe = await prisma.recipe.create({
      data: {
        tenantId: tid,
        name: row.recipeName,
        ingredients: { create: row.ingredients.map((i) => ({ productId: productByName.get(i.product), quantity: i.qty })) },
      },
    });
    recipeId = recipe.id;
    recipeByName.set(row.recipeName, recipeId);
    created++;
  }
  if (row.variantId) {
    const v = await prisma.menuItemVariant.findUnique({ where: { id: row.variantId }, select: { recipeId: true } });
    if (v && !v.recipeId) { await prisma.menuItemVariant.update({ where: { id: row.variantId }, data: { recipeId } }); attached++; } else skipped++;
  } else {
    const m = await prisma.menuItem.findUnique({ where: { id: row.menuItemId }, select: { recipeId: true } });
    if (m && !m.recipeId) { await prisma.menuItem.update({ where: { id: row.menuItemId }, data: { recipeId } }); attached++; } else skipped++;
  }
}
console.log(`Placeholder recipes created: ${created} | attached: ${attached} | already covered: ${skipped}`);
await prisma.$disconnect();
