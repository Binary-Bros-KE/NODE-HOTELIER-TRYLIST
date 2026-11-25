/**
 * Omega Gardens — Units of Measure cleanup, then link every stock product to
 * its UOM row (Product.unitId), so recipes and stock use the same units.
 *
 * - "packet" is renamed to "PKT" (packet of a product's own size).
 * - "Pcs" is merged into "Piece" (no rows reference it, so it is deleted;
 *   the one product still written as "pcs" is moved to piece).
 * - New units: Gram, Litre, ML, Tray (30 eggs), Tin, Portion, Sachet, Carton, Cup.
 * - "Kg" is kept as the single weight unit.
 *
 * Idempotent: a product that already has a unitId is never changed.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tid = (await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } })).id;
const byName = async (name) => prisma.unitOfMeasure.findFirst({ where: { tenantId: tid, name: { equals: name, mode: "insensitive" } } });

// 1. rename packet -> PKT
const packet = await byName("packet");
if (packet && !(await byName("PKT"))) {
  await prisma.unitOfMeasure.update({ where: { id: packet.id }, data: { name: "PKT" } });
  console.log('Renamed UOM "packet" -> "PKT"');
}

// 2. merge Pcs into Piece
const pcs = await byName("Pcs");
const piece = await byName("Piece");
if (pcs && piece) {
  const refs = await prisma.product.count({ where: { tenantId: tid, OR: [{ unitId: pcs.id }, { packUnitId: pcs.id }] } });
  const assets = await prisma.asset.count({ where: { tenantId: tid, unitId: pcs.id } });
  if (refs === 0 && assets === 0) {
    await prisma.product.updateMany({ where: { tenantId: tid, unit: "Pcs" }, data: { unit: "piece" } });
    await prisma.unitOfMeasure.delete({ where: { id: pcs.id } });
    console.log('Merged UOM "Pcs" into "Piece" and deleted it');
  } else {
    console.log(`Kept "Pcs": still referenced (products ${refs}, assets ${assets})`);
  }
}

// 3. create the units recipes and stock need
const NEW_UNITS = ["Gram", "Litre", "ML", "Tray", "Tin", "Portion", "Sachet", "Carton", "Cup"];
for (const name of NEW_UNITS) {
  if (await byName(name)) continue;
  await prisma.unitOfMeasure.create({ data: { tenantId: tid, name, measurementKind: "EACH" } });
  console.log(`Created UOM "${name}"`);
}

// 4. map each product's text unit to its UOM row
const MAP = {
  kg: "Kg", pc: "Piece", piece: "Piece", pcs: "Piece", packet: "PKT", bottle: "Bottle", tot: "Tot", can: "Can", tin: "Tin",
  sachet: "Sachet", ml: "ML", litre: "Litre", portion: "Portion", bunch: "Bunch", carton: "Carton", glass: "Glass",
  gram: "Gram", cup: "Cup", each: "Each", pair: "Pair", tray: "Tray",
};
const units = await prisma.unitOfMeasure.findMany({ where: { tenantId: tid }, select: { id: true, name: true } });
const unitId = Object.fromEntries(units.map((u) => [u.name.toLowerCase(), u.id]));
// "packet" was renamed, so its key is now "pkt"
unitId.packet = unitId.pkt;

const products = await prisma.product.findMany({ where: { tenantId: tid, unitId: null }, select: { id: true, name: true, unit: true } });
const unmapped = [];
let linked = 0;
for (const p of products) {
  const key = MAP[p.unit.toLowerCase()];
  const id = key ? unitId[key.toLowerCase()] : null;
  if (!id) { unmapped.push(`${p.name} (${p.unit})`); continue; }
  await prisma.product.update({ where: { id: p.id }, data: { unitId: id } });
  linked++;
}
console.log(`Linked ${linked} products to a UOM. Unmapped: ${unmapped.length}`);
for (const u of unmapped) console.log("  unmapped:", u);

const remaining = await prisma.product.count({ where: { tenantId: tid, unitId: null } });
console.log(`Products still without a UOM: ${remaining}`);
await prisma.$disconnect();
