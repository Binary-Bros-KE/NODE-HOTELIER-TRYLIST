-- New enum values live in their own migration so the next one may use them.
ALTER TYPE "HousekeepingTaskStatus" ADD VALUE 'CANCELLED';

ALTER TYPE "HousekeepingTaskType" ADD VALUE 'GENERAL';
