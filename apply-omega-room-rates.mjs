/**
 * Omega Gardens Hotel and Spa — real room types + rates from the client's
 * September 2026 rate sheet ("OMEGA GARDENS HOTEL NEW RATES SEPT 2026.pdf").
 * All figures are VAT-exclusive, as marked on the sheet.
 *
 * Schema note: RoomRate has no separate Single/Double axis — pricing is
 * per (RoomType, rate name), not per occupancy. The sheet varies BOTH
 * category (Standard/Superior/Deluxe) AND occupancy (Single/Double), so
 * each occupancy becomes its own RoomType (capacity 1 or 2), each carrying
 * its own Bed & Breakfast / Half Board / Full Board RoomRate rows. Since
 * every RoomType here has rate variants, baseRate is left at 0 per the
 * schema's own convention ("only meaningful when the type has no rate
 * variants").
 *
 * Idempotent: upserts by (tenantId, name) / (roomTypeId, name).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;
console.log(`Tenant: ${tenant.name} (${tid})`);

const perNight = await prisma.unitOfMeasure.upsert({
  where: { tenantId_name: { tenantId: tid, name: "Per Night" } },
  update: {},
  create: { tenantId: tid, name: "Per Night" },
});

async function upsertRoomType(name, capacity) {
  return prisma.roomType.upsert({
    where: { tenantId_name: { tenantId: tid, name } },
    update: { capacity },
    create: { tenantId: tid, name, capacity, baseRate: 0 },
  });
}
async function upsertRate(roomTypeId, name, mealPlan, price) {
  await prisma.roomRate.upsert({
    where: { roomTypeId_name: { roomTypeId, name } },
    update: { price, mealPlan, unitId: perNight.id },
    create: { tenantId: tid, roomTypeId, name, mealPlan, price, unitId: perNight.id },
  });
}

// [category, occupancy, capacity, bedBreakfast, halfBoard, fullBoard]
const RATES = [
  ["Standard", "Single", 1, 4500, 5700, 6900],
  ["Standard", "Double", 2, 5500, 7900, 10300],
  ["Superior", "Single", 1, 5500, 6700, 7900],
  ["Superior", "Double", 2, 6500, 8900, 11300],
  ["Deluxe", "Single", 1, 6500, 7700, 8900],
  ["Deluxe", "Double", 2, 7500, 9900, 12300],
];

for (const [category, occupancy, capacity, bb, hb, fb] of RATES) {
  const name = `${category} ${occupancy}`;
  const roomType = await upsertRoomType(name, capacity);
  await upsertRate(roomType.id, "Bed & Breakfast", "BED_AND_BREAKFAST", bb);
  await upsertRate(roomType.id, "Half Board", "HALF_BOARD", hb);
  await upsertRate(roomType.id, "Full Board", "FULL_BOARD", fb);
  console.log(`${name}: B&B ${bb} / HB ${hb} / FB ${fb}`);
}

const [rtCount, rrCount] = await Promise.all([
  prisma.roomType.count({ where: { tenantId: tid } }),
  prisma.roomRate.count({ where: { tenantId: tid } }),
]);
console.log(`\nTenant totals: roomTypes=${rtCount} roomRates=${rrCount}`);
console.log("\nNo physical Room numbers were created — the sheet only gives rates, not a room inventory. Add actual room numbers (e.g. 101, 102...) under each type via Rooms in the app once you have the list.");
await prisma.$disconnect();
