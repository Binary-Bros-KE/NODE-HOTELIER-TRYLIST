import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;

const resNos = ["RES-000001", "RES-000002", "RES-000004", "RES-000005", "RES-000006", "RES-000008"];

const reservations = await prisma.reservation.findMany({
  where: { tenantId: tid, reservationNo: { in: resNos } },
  include: {
    room: { select: { id: true, number: true, status: true, cleanliness: true } },
    customer: { select: { firstName: true, lastName: true } },
    folio: { include: { payments: true, lineItems: true } },
  },
});

for (const r of reservations) {
  console.log(`\n${r.reservationNo} — ${r.customer.firstName} ${r.customer.lastName} — room ${r.room.number}`);
  console.log(`  reservation.status=${r.status} room.status=${r.room.status} room.cleanliness=${r.room.cleanliness}`);
  console.log(`  folio.status=${r.folio?.status} creditAmount=${r.folio?.creditAmount}`);
  console.log(`  payments: ${r.folio?.payments.map((p) => `${p.kind}:${p.amount}(${p.createdAt.toISOString()})`).join(", ") || "none"}`);
  const tasks = await prisma.housekeepingTask.findMany({ where: { tenantId: tid, roomId: r.room.id, reservationId: r.id }, select: { id: true, taskNo: true, status: true, source: true, type: true, createdAt: true } });
  console.log(`  housekeeping tasks for this reservation: ${tasks.length ? JSON.stringify(tasks) : "none"}`);
}

await prisma.$disconnect();
