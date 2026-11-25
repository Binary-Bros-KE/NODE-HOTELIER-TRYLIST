/**
 * Omega Gardens Hotel and Spa — conference room, sold through the same
 * RoomType/RoomRate mechanism as regular rooms (per the client: "conferences
 * are just rooms"). Unlike the hotel rooms, these are priced PER PERSON
 * (marked "p.p" on the sheet), not per night — given its own unit rather
 * than reusing "Per Night", since that's a real, different billing unit,
 * not just cosmetic.
 *
 * The sheet's "Full Board Conference Package" / "Half Board Conference
 * Package" descriptions both end with the phrase "...and Half Board" —
 * almost certainly a copy-paste artifact in the source document (the two
 * packages are clearly named/priced as a Full Board tier at 9,000 and a
 * Half Board tier at 8,000) — mealPlan set to match each one's own name,
 * not the repeated trailing text.
 *
 * Capacity: not given on the sheet (unlike the hotel rooms' Single/Double
 * split) — defaulted to 50, a placeholder; correct it in the app once known.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;
console.log(`Tenant: ${tenant.name} (${tid})`);

const perPerson = await prisma.unitOfMeasure.upsert({
  where: { tenantId_name: { tenantId: tid, name: "Per Person" } },
  update: {},
  create: { tenantId: tid, name: "Per Person" },
});

const roomType = await prisma.roomType.upsert({
  where: { tenantId_name: { tenantId: tid, name: "Conference Room" } },
  update: {},
  create: { tenantId: tid, name: "Conference Room", capacity: 50, baseRate: 0, description: "Priced per person, not per night — see individual rate names for what's included." },
});

async function upsertRate(name, mealPlan, price) {
  await prisma.roomRate.upsert({
    where: { roomTypeId_name: { roomTypeId: roomType.id, name } },
    update: { price, mealPlan, unitId: perPerson.id },
    create: { tenantId: tid, roomTypeId: roomType.id, name, mealPlan, price, unitId: perPerson.id },
  });
  console.log(`  ${name}: KES ${price} per person`);
}

await upsertRate("Full Day Conference", null, 3000);
await upsertRate("Half Day Conference", null, 2500);
await upsertRate("Full Board Conference Package", "FULL_BOARD", 9000);
await upsertRate("Half Board Conference Package", "HALF_BOARD", 8000);

const [rtCount, rrCount] = await Promise.all([
  prisma.roomType.count({ where: { tenantId: tid } }),
  prisma.roomRate.count({ where: { tenantId: tid } }),
]);
console.log(`\nTenant totals: roomTypes=${rtCount} roomRates=${rrCount}`);
await prisma.$disconnect();
