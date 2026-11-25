import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tid = (await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } })).id;
const locations = await prisma.location.findMany({ where: { tenantId: tid }, select: { name: true, type: true } });
console.log("Locations:", JSON.stringify(locations));

const words = ["soap", "lotion", "tissue", "sugar", "coffee", "chocolate", "water", "serviette", "tea", "milo", "honey"];
for (const w of words) {
  const p = await prisma.product.findMany({
    where: { tenantId: tid, name: { contains: w, mode: "insensitive" } },
    select: { name: true, unit: true, unitCost: true, isPerishable: true, shelfLifeDays: true, stocks: { select: { quantity: true, location: { select: { name: true } } } } },
  });
  console.log(`\n[${w}]`, JSON.stringify(p.map((x) => ({ n: x.name, u: x.unit, cost: x.unitCost?.toString(), perish: x.isPerishable, shelf: x.shelfLifeDays, stock: x.stocks.map((s) => `${s.location.name}:${s.quantity}`) }))));
}

console.log("\nAssets:", await prisma.asset.count({ where: { tenantId: tid } }));
console.log("RoomConsumableStandards:", await prisma.roomConsumableStandard.count({ where: { tenantId: tid } }));
console.log("Units:", JSON.stringify((await prisma.unitOfMeasure.findMany({ where: { tenantId: tid }, select: { name: true } })).map((u) => u.name)));
console.log("Asset categories:", JSON.stringify((await prisma.category.findMany({ where: { tenantId: tid, scope: "ASSETS" }, select: { name: true } })).map((c) => c.name)));
console.log("Rooms by type:", JSON.stringify((await prisma.roomType.findMany({ where: { tenantId: tid }, select: { name: true, _count: { select: { rooms: true } } } })).map((t) => `${t.name}:${t._count.rooms}`)));
await prisma.$disconnect();
