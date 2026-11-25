/**
 * Omega Gardens Hotel and Spa — now that "Person" is a real, valid room-
 * pricing unit (measurementKind HEADCOUNT), repoint the 4 conference rates
 * from the "Day" fallback they were stuck on to the real thing.
 *
 * Needs the "any unit works for rooms" deploy to have landed first — run
 * this after confirming the server picked up commit 3e175de (or later).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;

// Ensures Person/Each exist for this tenant if it hasn't loaded a page that
// triggers ensureSystemUnits yet.
const { ensureSystemUnits } = await import("./dist/lib/systemUnits.js");
await ensureSystemUnits(prisma, tid);

const person = await prisma.unitOfMeasure.findFirstOrThrow({ where: { tenantId: tid, systemKey: "PERSON" } });
const day = await prisma.unitOfMeasure.findFirstOrThrow({ where: { tenantId: tid, systemKey: "DAY" } });

const result = await prisma.roomRate.updateMany({
  where: { tenantId: tid, unitId: day.id, roomType: { name: "Conference Room" } },
  data: { unitId: person.id },
});
console.log(`Repointed ${result.count} conference rates: Day -> Person`);

const rates = await prisma.roomRate.findMany({ where: { tenantId: tid, roomType: { name: "Conference Room" } }, select: { name: true, price: true, unit: { select: { name: true, measurementKind: true } } } });
console.log(JSON.stringify(rates, null, 2));
await prisma.$disconnect();
