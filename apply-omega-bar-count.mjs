/**
 * Omega Gardens — set Main Bar stock to the handwritten count from the 02/10/2026
 * bar position report. Each change is an ADJUSTMENT on the stock ledger
 * (difference between the counted quantity and what the system holds), so the
 * correction is auditable.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
import fs from "fs";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const { recordStockMovement } = await import("./dist/lib/stockLedger.js");
const counts = JSON.parse(fs.readFileSync(new URL("./bar-stock-apply.json", import.meta.url)));

const tid = (await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } })).id;
const bar = await prisma.location.findFirstOrThrow({ where: { tenantId: tid, name: "Main Bar" } });

let changed = 0, same = 0;
const missing = [];
for (const { product, count } of counts) {
  const p = await prisma.product.findFirst({ where: { tenantId: tid, name: product } });
  if (!p) { missing.push(product); continue; }
  const stock = await prisma.productStock.findFirst({ where: { tenantId: tid, productId: p.id, locationId: bar.id } });
  const current = stock ? Number(stock.quantity) : 0;
  const delta = Math.round((count - current) * 1000) / 1000;
  if (delta === 0) { same++; continue; }
  await prisma.$transaction((tx) => recordStockMovement(tx, {
    tenantId: tid, productId: p.id, locationId: bar.id, type: "ADJUSTMENT", quantity: delta, allowNegative: true,
    note: "Bar stock count 02/10/2026 (handwritten position report)", label: p.name,
  }));
  changed++;
  console.log(`${p.name}: ${current} -> ${count}`);
}
console.log(`Adjusted: ${changed} | already correct: ${same} | products not found: ${missing.length}`);
if (missing.length) console.log(missing.join("\n"));
await prisma.$disconnect();
