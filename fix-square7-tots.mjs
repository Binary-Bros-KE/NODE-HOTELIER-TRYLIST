/**
 * Square 7 Lounge — split tot pours off the bottle stock.
 *
 * Original design drew a "Tot (30ml)" straight from one of the brand's
 * bottle Products (e.g. Jack Daniels 700ml). Client corrected that: tots are
 * poured from their OWN separate stock (a dedicated pour-bottle behind the
 * counter) that staff top up manually whenever it runs low — NOT the same
 * stock as the sealed bottles sold whole. So each of the 12 tot brands gets
 * one more Product, "<Brand> Tot Stock" (tracked in plain Millilitres, no
 * packSize/packUnitId — it's a manually-replenished reservoir, not sold by
 * the bottle), and the club also wants two distinct pour sizes, in their own
 * words: "Single Tot (30ml)" and "Double Tot (60ml)" — both draw from that
 * same dedicated product, just a different stockQtyPerUnit.
 *
 * Idempotent: skips a brand that's already been migrated (has a "Single Tot"
 * variant); safe to re-run.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "square7" } });
const tid = tenant.id;

// Exactly the 12 brands the club's own TOTS section named (see provision-square7.mjs).
const TOT_BRANDS = [
  "Jack Daniels", "JW Black Label", "Camino Gold", "Camino Silver",
  "Jose Cuervo Gold", "Jose Cuervo Silver", "Don Julio Blanco",
  "Jagermeister", "Sheridans", "Gilbeys", "Smirnoff", "Malibu",
];

let fixed = 0, skipped = 0, missing = 0;
for (const brand of TOT_BRANDS) {
  const menuItem = await prisma.menuItem.findFirst({
    where: { tenantId: tid, name: brand },
    include: { variants: { orderBy: { sortOrder: "asc" } } },
  });
  if (!menuItem) { console.log(`MISSING menu item: ${brand}`); missing++; continue; }

  if (menuItem.variants.some((v) => v.name.startsWith("Single Tot"))) {
    console.log(`already migrated: ${brand}`);
    skipped++;
    continue;
  }

  const oldTot = menuItem.variants.find((v) => v.name === "Tot (30ml)");
  if (!oldTot) { console.log(`NO existing tot variant on ${brand} — nothing to migrate`); missing++; continue; }

  const singlePrice = Number(oldTot.price);
  const doublePrice = Math.round((singlePrice * 1.8) / 50) * 50;

  const stockName = `${brand} Tot Stock`;
  let totProduct = await prisma.product.findFirst({ where: { tenantId: tid, name: stockName } });
  if (!totProduct) {
    totProduct = await prisma.product.create({
      data: {
        tenantId: tid, categoryId: menuItem.categoryId, name: stockName,
        unit: "Millilitres", unitCost: Math.round((singlePrice * 0.5) / 30),
      },
    });
  }

  await prisma.menuItemVariant.delete({ where: { id: oldTot.id } });
  const remaining = menuItem.variants.filter((v) => v.id !== oldTot.id);
  const nextSort = remaining.length ? Math.max(...remaining.map((v) => v.sortOrder)) + 1 : 0;

  await prisma.menuItemVariant.create({
    data: { tenantId: tid, menuItemId: menuItem.id, name: "Single Tot (30ml)", price: singlePrice, stockProductId: totProduct.id, stockQtyPerUnit: 30, sortOrder: nextSort },
  });
  await prisma.menuItemVariant.create({
    data: { tenantId: tid, menuItemId: menuItem.id, name: "Double Tot (60ml)", price: doublePrice, stockProductId: totProduct.id, stockQtyPerUnit: 60, sortOrder: nextSort + 1 },
  });

  console.log(`fixed ${brand}: Single Tot KES ${singlePrice}, Double Tot KES ${doublePrice}, stock product = "${stockName}"`);
  fixed++;
}

console.log(`\nDone. fixed=${fixed} already-migrated=${skipped} missing=${missing}`);
await prisma.$disconnect();
