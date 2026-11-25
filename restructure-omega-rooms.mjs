/**
 * Omega Gardens Hotel and Spa — two fixes in one pass:
 *
 * 1. Room types were wrongly split by occupancy ("Standard Single" /
 *    "Standard Double" as two separate RoomTypes). A physical room is one
 *    thing — Single vs Double is a rate choice at booking time, not a
 *    different room. Merge each Single/Double pair into one category
 *    RoomType (Standard / Superior / Deluxe) with 6 rate rows each
 *    ("Single - Bed & Breakfast" ... "Double - Full Board"), carrying over
 *    the exact prices already entered. Conference Room is untouched
 *    (already headcount-based, no single/double axis).
 *
 * 2. Every room type goes to a flat 16% exclusive tax (client instruction).
 *
 * 3. Create the 42 physical rooms from the client's handwritten room list
 *    (photographed ledger pages), floors 2-5.
 *
 * Safety: refuses to touch anything if Omega already has reservations or
 * rooms recorded (this is a one-time setup pass on a still-empty tenant).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;
console.log(`Tenant: ${tenant.name} (${tid})`);

const [roomCount, reservationCount] = await Promise.all([
  prisma.room.count({ where: { tenantId: tid } }),
  prisma.reservation.count({ where: { tenantId: tid } }),
]);
if (roomCount > 0 || reservationCount > 0) {
  throw new Error(`Refusing to run: Omega already has ${roomCount} rooms / ${reservationCount} reservations.`);
}

const perNight = await prisma.unitOfMeasure.findFirstOrThrow({ where: { tenantId: tid, name: "Night" } });

const CATEGORIES = ["Standard", "Superior", "Deluxe"];
const MEAL_PLANS = [
  ["Bed & Breakfast", "BED_AND_BREAKFAST"],
  ["Half Board", "HALF_BOARD"],
  ["Full Board", "FULL_BOARD"],
];

const mergedTypeIdByCategory = {};

for (const category of CATEGORIES) {
  const single = await prisma.roomType.findUniqueOrThrow({
    where: { tenantId_name: { tenantId: tid, name: `${category} Single` } },
    include: { rates: true },
  });
  const double = await prisma.roomType.findUniqueOrThrow({
    where: { tenantId_name: { tenantId: tid, name: `${category} Double` } },
    include: { rates: true },
  });

  const merged = await prisma.roomType.create({
    data: {
      tenantId: tid,
      name: category,
      capacity: 2,
      baseRate: 0,
      taxRate: 16,
      taxMode: "EXCLUSIVE",
      taxTreatment: "STANDARD",
    },
  });

  for (const [label, mealPlan] of MEAL_PLANS) {
    const singleRate = single.rates.find((r) => r.mealPlan === mealPlan);
    const doubleRate = double.rates.find((r) => r.mealPlan === mealPlan);
    await prisma.roomRate.create({
      data: { tenantId: tid, roomTypeId: merged.id, name: `Single - ${label}`, mealPlan, price: singleRate.price, unitId: perNight.id },
    });
    await prisma.roomRate.create({
      data: { tenantId: tid, roomTypeId: merged.id, name: `Double - ${label}`, mealPlan, price: doubleRate.price, unitId: perNight.id },
    });
  }

  await prisma.roomType.delete({ where: { id: single.id } });
  await prisma.roomType.delete({ where: { id: double.id } });

  mergedTypeIdByCategory[category] = merged.id;
  console.log(`Merged "${category} Single" + "${category} Double" -> "${category}" (${merged.id}), 6 rates, 16% exclusive`);
}

const conference = await prisma.roomType.update({
  where: { tenantId_name: { tenantId: tid, name: "Conference Room" } },
  data: { taxRate: 16, taxMode: "EXCLUSIVE", taxTreatment: "STANDARD" },
});
console.log(`Conference Room -> 16% exclusive (${conference.id})`);

// [floor, category, [room numbers]]
const ROOMS = [
  ["2", "Standard", ["202", "203", "205", "206", "207", "208", "209", "212"]],
  ["2", "Superior", ["201", "204", "210", "213"]],
  ["2", "Deluxe", ["211"]],
  ["3", "Standard", ["302", "303", "305", "306", "307", "308", "309", "312"]],
  ["3", "Superior", ["301", "304", "310", "313"]],
  ["3", "Deluxe", ["311"]],
  ["4", "Standard", ["402", "403", "405", "406", "407", "408", "409", "412"]],
  ["4", "Superior", ["401", "404", "410", "413"]],
  ["4", "Deluxe", ["411"]],
  ["5", "Standard", ["501", "502", "503"]],
];

let created = 0;
for (const [floor, category, numbers] of ROOMS) {
  const roomTypeId = mergedTypeIdByCategory[category];
  for (const number of numbers) {
    await prisma.room.create({ data: { tenantId: tid, number, floor, roomTypeId, capacity: 2, nightlyRate: 0 } });
    created += 1;
  }
}
console.log(`Created ${created} physical rooms.`);

const totals = await prisma.room.groupBy({ by: ["roomTypeId"], where: { tenantId: tid }, _count: true });
for (const t of totals) {
  const type = await prisma.roomType.findUniqueOrThrow({ where: { id: t.roomTypeId } });
  console.log(`  ${type.name}: ${t._count} rooms`);
}

await prisma.$disconnect();
