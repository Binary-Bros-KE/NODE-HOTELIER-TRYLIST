/**
 * Omega Gardens Hotel and Spa — a receptionist in training accidentally
 * completed checkout for 6 guests who were only meant to be checked in.
 * Reverses one step: reservation back to CHECKED_IN, room back to
 * OCCUPIED/CLEAN, folio back to OPEN. The checkout SETTLEMENT payment and
 * its Transaction record are left exactly as they are (the guest did pay —
 * that part was real). The turnover cleaning task each checkout spawned is
 * deleted outright (all still PENDING, untouched by housekeeping) so a
 * fresh one is created when the guest actually checks out.
 *
 * Confirmed via inspect-omega-checkouts.mjs immediately before this run:
 * all 6 folios have exactly one SETTLEMENT payment, no credit applied
 * (creditAmount 0), and exactly one PENDING CHECKOUT-source cleaning task
 * each — nothing has been actioned by housekeeping yet.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;

const resNos = ["RES-000001", "RES-000002", "RES-000004", "RES-000005", "RES-000006", "RES-000008"];

for (const reservationNo of resNos) {
  const current = await prisma.reservation.findFirstOrThrow({
    where: { tenantId: tid, reservationNo },
    include: { room: true, folio: true },
  });
  if (current.status !== "CHECKED_OUT") { console.log(`${reservationNo}: status is ${current.status}, not CHECKED_OUT — skipping.`); continue; }
  if (current.folio?.status !== "SETTLED" || Number(current.folio.creditAmount) !== 0) {
    console.log(`${reservationNo}: folio state unexpected (status=${current.folio?.status}, creditAmount=${current.folio?.creditAmount}) — skipping, needs manual review.`);
    continue;
  }

  const task = await prisma.housekeepingTask.findFirst({
    where: { tenantId: tid, reservationId: current.id, source: "CHECKOUT", type: "CLEANING" },
  });
  if (task && task.status !== "PENDING") {
    console.log(`${reservationNo}: cleaning task ${task.taskNo} is ${task.status}, not PENDING — leaving it, please review manually.`);
  }

  await prisma.$transaction(async (tx) => {
    if (task && task.status === "PENDING") {
      await tx.housekeepingTask.delete({ where: { id: task.id } });
    }
    await tx.room.update({ where: { id: current.roomId }, data: { status: "OCCUPIED", cleanliness: "CLEAN" } });
    await tx.folio.update({ where: { id: current.folio.id }, data: { status: "OPEN" } });
    await tx.reservation.update({ where: { id: current.id }, data: { status: "CHECKED_IN" } });
    await tx.reservationActivity.create({
      data: {
        tenantId: tid,
        reservationId: current.id,
        action: "CHECKED_IN",
        summary: "Checkout reversed (accidental checkout during training) — reinstated as checked in",
      },
    });
  });
  console.log(`${reservationNo}: reverted to CHECKED_IN, room ${current.room.number} back to OCCUPIED/CLEAN, folio reopened, cleaning task removed.`);
}

await prisma.$disconnect();
