/**
 * Omega Gardens Hotel and Spa — restaurant food menu import, Phase 2 of 3
 * (1. store items + cost [done], 2. menu from a PDF [this], 3. recipes
 * linking menu items to store products). Source: "OMEGA-MENU-RECOVERED.pdf",
 * a 6-page designed graphic menu (not a plain list) — each page was read
 * directly (text layer + rendered image cross-checked against each other)
 * rather than trusted from a single pass, given how easy a graphic layout
 * is to misread. omega-food-menu.json (next to this script) is the result.
 *
 * Three judgment calls made on real ambiguities in the source PDF,
 * confirmed with the client before writing anything:
 *   - "Kebab (Beef/Chicken)" (Bitings) had no printed price at all -> 0,
 *     to be filled in once the client provides it.
 *   - A section titled "BBQ Chicken Wings, Sweet and Sour or Honey Glazed"
 *     had its line items still reading "Crispy Coated Drumsticks" (a
 *     copy-paste leftover from the section above it) -> renamed to
 *     "...Chicken Wings" per the client.
 *   - "Vegetable Sandwich" appears on both the adult menu (700/-) and the
 *     kids menu (500/-) -> the kids one is suffixed "(Kids)" so staff can
 *     tell them apart at the till.
 *
 * This phase is menu items only — no Product/recipe linkage yet (phase 3),
 * and no location restriction (client: available everywhere, same as the
 * bar menu).
 *
 * Idempotent: upserts by name; re-running never resets a price that's
 * already there.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const data = JSON.parse(fs.readFileSync(new URL("./omega-food-menu.json", import.meta.url)));

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;
console.log(`Tenant: ${tenant.name} (${tid})`);

async function menuCat(name) {
  return prisma.menuCategory.upsert({ where: { tenantId_name: { tenantId: tid, name } }, update: {}, create: { tenantId: tid, name } });
}

const counts = { menuItems: 0, variants: 0 };

async function buildSimple(categoryName, item) {
  const mc = await menuCat(categoryName);
  const existing = await prisma.menuItem.findFirst({ where: { tenantId: tid, name: item.name } });
  if (existing) return;
  await prisma.menuItem.create({ data: { tenantId: tid, name: item.name, menuCategoryId: mc.id, price: item.price } });
  counts.menuItems++;
}

async function buildVariantItem(categoryName, item) {
  const mc = await menuCat(categoryName);
  const existing = await prisma.menuItem.findFirst({ where: { tenantId: tid, name: item.name } });
  if (existing) return;
  if (item.variants.length === 1) {
    await prisma.menuItem.create({ data: { tenantId: tid, name: item.name, menuCategoryId: mc.id, price: item.variants[0].price } });
    counts.menuItems++;
    return;
  }
  const basePrice = Math.min(...item.variants.map((v) => v.price));
  const menuItem = await prisma.menuItem.create({ data: { tenantId: tid, name: item.name, menuCategoryId: mc.id, price: basePrice } });
  counts.menuItems++;
  let sort = 0;
  for (const v of item.variants) {
    await prisma.menuItemVariant.create({ data: { tenantId: tid, menuItemId: menuItem.id, name: v.label, price: v.price, sortOrder: sort++ } });
    counts.variants++;
  }
}

for (const [category, items] of Object.entries(data.simple)) {
  for (const item of items) await buildSimple(category, item);
}
for (const [category, items] of Object.entries(data.variantItems)) {
  for (const item of items) await buildVariantItem(category, item);
}

console.log("Created this run:", JSON.stringify(counts));
const [menuCount, variantCount, catCount] = await Promise.all([
  prisma.menuItem.count({ where: { tenantId: tid } }),
  prisma.menuItemVariant.count({ where: { tenantId: tid } }),
  prisma.menuCategory.count({ where: { tenantId: tid } }),
]);
console.log(`Tenant totals now: menuItems=${menuCount} variants=${variantCount} menuCategories=${catCount}`);
await prisma.$disconnect();
