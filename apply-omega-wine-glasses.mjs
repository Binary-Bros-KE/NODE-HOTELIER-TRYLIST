/**
 * Omega Gardens — the three wines are counted in glasses, though labelled as
 * 750ml bottles. Their 750ml products are now measured in a "Glasses" unit,
 * and the glass counts are added onto the same stock:
 *   Cellar Cask Red 750ML:   2 glasses
 *   Cellar Cask White 750ML: 2 (750ml row) + 52 (glass row) = 54
 *   4TH Street White 750ML:  2 (750ml row) + 2 (5L row) = 4
 * Each sale still deducts one unit. Stock moves through the ledger as an ADJUSTMENT.
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

let glasses = await prisma.unitOfMeasure.findFirst({ where: { tenantId: tid, name: { equals: "Glasses", mode: "insensitive" } } });
if (!glasses) {
  glasses = await prisma.unitOfMeasure.create({ data: { tenantId: tid, name: "Glasses", measurementKind: "EACH" } });
  console.log('Created UOM "Glasses"');
}

const WINES = [
  { name: "Cellar Cask Red 750ML", target: 2 },
  { name: "Cellar Cask White 750ML", target: 52 },
  { name: "4TH Street White 750ML", target: 2 },
];

for (const w of WINES) {
  const p = await prisma.product.findFirst({ where: { tenantId: tid, name: { equals: w.name, mode: "insensitive" } } });
  if (!p) { console.log(`NOT FOUND: ${w.name}`); continue; }
  await prisma.product.update({ where: { id: p.id }, data: { unitId: glasses.id, unit: "glasses" } });
  const stock = await prisma.productStock.findFirst({ where: { tenantId: tid, productId: p.id, locationId: bar.id } });
  const current = stock ? Number(stock.quantity) : 0;
  const delta = w.target - current;
  if (delta !== 0) {
    await prisma.$transaction((tx) => recordStockMovement(tx, {
      tenantId: tid, productId: p.id, locationId: bar.id, type: "ADJUSTMENT", quantity: delta, allowNegative: true,
      note: "Bar stock count 02/10/2026 — wines counted in glasses", label: p.name,
    }));
  }
  const menu = await prisma.menuItem.findMany({ where: { tenantId: tid, productId: p.id }, select: { name: true, stockQtyPerUnit: true } });
  const variants = await prisma.menuItemVariant.findMany({ where: { tenantId: tid, stockProductId: p.id }, select: { name: true, stockQtyPerUnit: true, menuItem: { select: { name: true } } } });
  console.log(`${p.name}: ${current} -> ${w.target} | menu: ${JSON.stringify(menu.map((m) => `${m.name} x${m.stockQtyPerUnit}`))} variants: ${JSON.stringify(variants.map((v) => `${v.menuItem.name}/${v.name} x${v.stockQtyPerUnit}`))}`);
}
await prisma.$disconnect();
