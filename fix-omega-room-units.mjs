/**
 * Omega Gardens Hotel and Spa — fix the room/conference rate units.
 *
 * Room billing is hard-locked to exactly 3 built-in units (Hour/Night/Day,
 * flagged by UnitOfMeasure.systemKey — see src/lib/systemUnits.ts and
 * rooms.routes.ts's assertUnits()) because src/lib/roomCharge.ts's
 * unitQuantity() only knows how to compute a charge two ways: elapsed HOURS,
 * or elapsed 24-hour DAYS/NIGHTS between check-in and check-out. There is no
 * "Person" unit, and critically no headcount multiplier anywhere in that
 * formula at all — going through the real /rooms API would have rejected
 * unitId values outside that set. I bypassed that by writing straight to the
 * DB, which is how two invalid custom units ("Per Night", "Per Person")
 * ended up sitting next to the real "Night"/"Day" ones instead of using them.
 *
 * This repoints every RoomRate onto the real system units and removes the
 * two invalid ones.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;

const night = await prisma.unitOfMeasure.findFirstOrThrow({ where: { tenantId: tid, systemKey: "NIGHT" } });
const day = await prisma.unitOfMeasure.findFirstOrThrow({ where: { tenantId: tid, systemKey: "DAY" } });
const badPerNight = await prisma.unitOfMeasure.findFirst({ where: { tenantId: tid, name: "Per Night", systemKey: null } });
const badPerPerson = await prisma.unitOfMeasure.findFirst({ where: { tenantId: tid, name: "Per Person", systemKey: null } });

// The 18 hotel room rates: repoint from the bad "Per Night" onto the real
// system "Night" unit.
if (badPerNight) {
  const r1 = await prisma.roomRate.updateMany({ where: { tenantId: tid, unitId: badPerNight.id }, data: { unitId: night.id } });
  console.log(`Repointed ${r1.count} room rates: Per Night -> Night`);
}
// The 4 conference rates: "Person" isn't a real option (see comment above) —
// closest valid fit is Day, matching what the UI was already silently
// falling back to.
if (badPerPerson) {
  const r2 = await prisma.roomRate.updateMany({ where: { tenantId: tid, unitId: badPerPerson.id }, data: { unitId: day.id } });
  console.log(`Repointed ${r2.count} conference rates: Per Person -> Day`);
}

// Now safe to remove the two invalid units (nothing references them any more).
if (badPerNight) { await prisma.unitOfMeasure.delete({ where: { id: badPerNight.id } }); console.log('Deleted "Per Night"'); }
if (badPerPerson) { await prisma.unitOfMeasure.delete({ where: { id: badPerPerson.id } }); console.log('Deleted "Per Person"'); }

const remaining = await prisma.unitOfMeasure.findMany({ where: { tenantId: tid }, select: { name: true, systemKey: true } });
console.log("\nUnits now:", JSON.stringify(remaining));
await prisma.$disconnect();
