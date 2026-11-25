import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const tid = (await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } })).id;
const items = await prisma.menuItem.findMany({
  where: { tenantId: tid },
  select: { id: true, name: true, recipeId: true, productId: true, category: { select: { name: true } }, variants: { select: { id: true, name: true, recipeId: true, stockProductId: true } } },
  orderBy: { name: "asc" },
});
// A sellable unit is covered when it has a recipe or is a stock product sold as-is.
const gaps = [];
for (const m of items) {
  if (m.variants.length === 0) {
    if (!m.recipeId && !m.productId) gaps.push({ item: m.name, variant: null, category: m.category?.name ?? null, menuItemId: m.id });
  } else {
    for (const v of m.variants) if (!v.recipeId && !v.stockProductId) gaps.push({ item: m.name, variant: v.name, category: m.category?.name ?? null, menuItemId: m.id, variantId: v.id });
  }
}
const recipes = await prisma.recipe.findMany({ where: { tenantId: tid }, select: { name: true } });
console.log(JSON.stringify({ menuItems: items.length, recipes: recipes.length, gaps }));
await prisma.$disconnect();
