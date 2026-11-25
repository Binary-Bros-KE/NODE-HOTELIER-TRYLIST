import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const tid = (await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } })).id;
const cats = await prisma.menuCategory.findMany({
  where: { tenantId: tid },
  select: { id: true, name: true, menuItems: { select: { name: true, temperature: true, recipeId: true, isAvailable: true } } },
  orderBy: { sortOrder: "asc" },
});
const teaLike = /tea|coffee|latte|mocha|cappuccino|machiato|espresso|americano|chai|cocoa|lungo|cortado|doppio|black|long/i;
for (const c of cats) {
  const hot = c.menuItems.filter((i) => i.temperature === "HOT");
  const tea = c.menuItems.filter((i) => teaLike.test(i.name));
  console.log(`${c.name} | items ${c.menuItems.length} | HOT ${hot.length} | tea/coffee-named ${tea.length}`);
  const names = [...new Set([...hot, ...tea].map((i) => `${i.name}[${i.temperature}]`))];
  if (names.length) console.log("   " + names.join(", "));
}
const ginger = await prisma.menuItem.findMany({ where: { tenantId: tid, name: { contains: "ginger", mode: "insensitive" } }, select: { id: true, name: true, recipeId: true, temperature: true, menuCategory: { select: { name: true } } } });
console.log("ginger items:", JSON.stringify(ginger));
const addons = await prisma.addon.findMany({ where: { tenantId: tid }, select: { name: true, menuCategoryId: true } });
console.log("existing addons:", addons.length, addons.slice(0, 10).map((a) => a.name).join(", "));
await prisma.$disconnect();
