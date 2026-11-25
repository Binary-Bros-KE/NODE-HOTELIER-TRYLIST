import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const APPLY = process.env.APPLY === "1";
const tid = (await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } })).id;

// 1. Ginger Tea gets its own recipe (it was pointing at African Masala Tea's).
const GINGER_LINES = [
  ["Tea Leaves 100 Gms", 0.02],
  ["Ginger", 0.01],
  ["Sugar 1 Kg", 0.01],
  ["Milk", 0.05],
];
const ginger = await prisma.menuItem.findFirstOrThrow({ where: { tenantId: tid, name: "GINGER TEA" }, select: { id: true, recipeId: true } });
const productIds = new Map((await prisma.product.findMany({ where: { tenantId: tid, name: { in: GINGER_LINES.map(([n]) => n) } }, select: { id: true, name: true } })).map((p) => [p.name, p.id]));
const missing = GINGER_LINES.map(([n]) => n).filter((n) => !productIds.has(n));
if (missing.length) throw new Error(`Products not found: ${missing.join(", ")}`);
const gingerName = "Ginger Tea (placeholder)";
const existingGinger = await prisma.recipe.findFirst({ where: { tenantId: tid, name: gingerName }, select: { id: true } });
console.log("Ginger Tea currently linked to recipe:", ginger.recipeId, "| placeholder exists:", existingGinger ? "yes" : "no");

// 2. Extra Honey add-on on Hot Beverages.
const hot = await prisma.menuCategory.findFirstOrThrow({ where: { tenantId: tid, name: "Hot Beverages" }, select: { id: true } });
const honeyCups = await prisma.product.findFirstOrThrow({ where: { tenantId: tid, name: "Honey Cups" }, select: { id: true } });
const existingHoney = await prisma.addon.findFirst({ where: { tenantId: tid, name: "Extra Honey" } });

if (!APPLY) {
  console.log("DRY RUN. Would set Ginger Tea to a new recipe:", GINGER_LINES.map(([n, q]) => `${n} ${q}`).join(" ; "));
  console.log("DRY RUN. Would add Extra Honey (KES 50, 1 Honey Cups) on Hot Beverages | exists:", existingHoney ? "yes" : "no");
} else {
  await prisma.$transaction(async (tx) => {
    let recipeId = existingGinger?.id;
    if (!recipeId) {
      const recipe = await tx.recipe.create({
        data: { tenantId: tid, name: gingerName, ingredients: { create: GINGER_LINES.map(([n, q]) => ({ productId: productIds.get(n), quantity: q })) } },
      });
      recipeId = recipe.id;
    }
    await tx.menuItem.update({ where: { id: ginger.id }, data: { recipeId } });
    if (!existingHoney) {
      await tx.addon.create({ data: { tenantId: tid, scope: "MENU", menuCategoryId: hot.id, name: "Extra Honey", price: 50, stockProductId: honeyCups.id, stockQtyPerUnit: 1, isActive: true } });
    }
  });
  console.log("applied: Ginger Tea recipe set; Extra Honey add-on", existingHoney ? "already existed" : "created");
}
await prisma.$disconnect();
