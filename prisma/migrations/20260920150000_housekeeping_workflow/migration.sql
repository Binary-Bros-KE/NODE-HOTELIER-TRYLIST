-- CreateEnum
CREATE TYPE "HousekeepingPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "HousekeepingTaskSource" AS ENUM ('MANUAL', 'CHECKOUT', 'ROOM_STATUS');

-- CreateEnum
CREATE TYPE "HousekeepingEventAction" AS ENUM ('CREATED', 'ASSIGNED', 'REASSIGNED', 'STARTED', 'COMPLETED', 'CANCELLED', 'EDITED');



-- DropForeignKey
ALTER TABLE "HousekeepingTask" DROP CONSTRAINT "HousekeepingTask_roomId_fkey";

-- AlterTable
ALTER TABLE "HousekeepingTask" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedById" TEXT,
ADD COLUMN     "assignedToId" TEXT,
ADD COLUMN     "assignedToName" TEXT,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "completedById" TEXT,
ADD COLUMN     "completedByName" TEXT,
ADD COLUMN     "priority" "HousekeepingPriority" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "reservationId" TEXT,
ADD COLUMN     "roomNumber" TEXT,
ADD COLUMN     "source" "HousekeepingTaskSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "startedById" TEXT,
ADD COLUMN     "taskNo" TEXT,
ADD COLUMN     "title" TEXT,
ALTER COLUMN "roomId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "HousekeepingTaskEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "action" "HousekeepingEventAction" NOT NULL,
    "summary" TEXT NOT NULL,
    "performedBy" TEXT,
    "performerName" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HousekeepingTaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HousekeepingTaskEvent_tenantId_taskId_occurredAt_idx" ON "HousekeepingTaskEvent"("tenantId", "taskId", "occurredAt");

-- CreateIndex
CREATE INDEX "HousekeepingTask_tenantId_assignedToId_status_idx" ON "HousekeepingTask"("tenantId", "assignedToId", "status");

-- CreateIndex
CREATE INDEX "HousekeepingTask_tenantId_completedAt_idx" ON "HousekeepingTask"("tenantId", "completedAt");

-- AddForeignKey
ALTER TABLE "HousekeepingTask" ADD CONSTRAINT "HousekeepingTask_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingTask" ADD CONSTRAINT "HousekeepingTask_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HousekeepingTaskEvent" ADD CONSTRAINT "HousekeepingTaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "HousekeepingTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: room-number snapshot and per-tenant task numbers for existing tasks.
UPDATE "HousekeepingTask" t SET "roomNumber" = r."number" FROM "Room" r WHERE r."id" = t."roomId";


WITH numbered AS (
  SELECT "id", "tenantId", ROW_NUMBER() OVER (PARTITION BY "tenantId" ORDER BY "createdAt", "id") AS n
  FROM "HousekeepingTask"
)
UPDATE "HousekeepingTask" t SET "taskNo" = 'HK-' || LPAD(numbered.n::text, 6, '0')
FROM numbered WHERE numbered."id" = t."id";

INSERT INTO "TenantSequence" ("id", "tenantId", "key", "lastNumber")
SELECT 'hk_' || "tenantId", "tenantId", 'housekeeping', COUNT(*) FROM "HousekeepingTask" GROUP BY "tenantId"
ON CONFLICT ("tenantId", "key") DO UPDATE SET "lastNumber" = EXCLUDED."lastNumber";

-- At most one active cleaning task per room. Older data could hold duplicates
-- (the old swap-room edit bypassed the check); keep the earliest and cancel the rest.
UPDATE "HousekeepingTask" SET "status" = 'CANCELLED', "cancelledAt" = NOW(), "cancelReason" = 'Duplicate of an active task (migration)'
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "tenantId", "roomId" ORDER BY "createdAt", "id") AS rn
    FROM "HousekeepingTask"
    WHERE "type" = 'CLEANING' AND "status" IN ('PENDING', 'IN_PROGRESS') AND "roomId" IS NOT NULL
  ) d WHERE d.rn > 1
);

CREATE UNIQUE INDEX "HousekeepingTask_one_active_cleaning_per_room"
ON "HousekeepingTask" ("tenantId", "roomId")
WHERE "type" = 'CLEANING' AND "status" IN ('PENDING', 'IN_PROGRESS') AND "roomId" IS NOT NULL;
