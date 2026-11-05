-- Activity log: the audit trail of sensitive actions, and the permission to read it.
ALTER TYPE "Permission" ADD VALUE 'ACTIVITY_VIEW';

CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorName" TEXT,
    "actorRole" TEXT,
    "area" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "summary" TEXT NOT NULL,
    "reason" TEXT,
    "changes" JSONB,
    "locationId" TEXT,
    "ipAddress" TEXT,
    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActivityLog_tenantId_occurredAt_idx" ON "ActivityLog"("tenantId", "occurredAt");
CREATE INDEX "ActivityLog_tenantId_targetType_targetId_idx" ON "ActivityLog"("tenantId", "targetType", "targetId");
CREATE INDEX "ActivityLog_tenantId_actorId_occurredAt_idx" ON "ActivityLog"("tenantId", "actorId", "occurredAt");

ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
