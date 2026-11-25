/**
 * Omega Gardens — add Jameson Black Barrel 750ml as a bar product and menu item
 * (per the 02/10/2026 position report: cost 3,700, price 6,500, counted 3).
 * Stock is set through the ledger as an ADJUSTMENT from zero to the count.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const { recordStockMovement } = await import("./dist/lib/stockLedger.js");

const tid = (await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } })).id;
const bar = await prisma.location.findFirstOrThrow({ where: { tenantId: tid, name: "Main Bar" } });
const bottle = await prisma.unitOfMeasure.findFirstOrThrow({ where: { tenantId: tid, name: "Bottle" } });
const NAME = "Jameson Black Barrel 750ml";
const COUNT = 3;

const cat = (await prisma.category.findFirst({ where: { tenantId: tid, scope: "BAR", parentId: null, name: "Whiskey" } }))
  ?? (await prisma.category.create({ data: { tenantId: tid, scope: "BAR", name: "Whiskey", parentId: null, level: 1 } }));
const mc = await prisma.menuCategory.upsert({ where: { tenantId_name: { tenantId: tid, name: "Whiskey" } }, update: {}, create: { tenantId: tid, name: "Whiskey" } });

let product = await prisma.product.findFirst({ where: { tenantId: tid, name: NAME } });
if (!product) {
  product = await prisma.product.create({
    data: { tenantId: tid, categoryId: cat.id, name: NAME, unit: "bottle", unitId: bottle.id, packSize: 1, packUnitId: bottle.id, packLabel: "Bottle", unitCost: 3700, sellsDirectly: false },
  });
  console.log(`Created product: ${NAME}`);
}

const item = await prisma.menuItem.findFirst({ where: { tenantId: tid, name: "Jameson Black Barrel" } });
if (!item) {
  await prisma.menuItem.create({ data: { tenantId: tid, name: "Jameson Black Barrel", menuCategoryId: mc.id, categoryId: cat.id, price: 6500, productId: product.id, stockQtyPerUnit: 1 } });
  console.log("Created menu item: Jameson Black Barrel, price 6500");
}

const stock = await prisma.productStock.findFirst({ where: { tenantId: tid, productId: product.id, locationId: bar.id } });
const current = stock ? Number(stock.quantity) : 0;
if (COUNT - current !== 0) {
  await prisma.$transaction((tx) => recordStockMovement(tx, {
    tenantId: tid, productId: product.id, locationId: bar.id, type: "ADJUSTMENT", quantity: COUNT - current, allowNegative: true,
    note: "Bar stock count 02/10/2026 (handwritten position report)", label: NAME,
  }));
  console.log(`Stock ${NAME}: ${current} -> ${COUNT}`);
}
await prisma.$disconnect();
