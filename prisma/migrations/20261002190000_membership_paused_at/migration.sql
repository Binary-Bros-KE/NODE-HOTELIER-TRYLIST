-- Tracks when a membership was paused, so resuming it can push endsAt out by
-- exactly how long it was paused instead of silently losing that time.
ALTER TABLE "Membership" ADD COLUMN "pausedAt" TIMESTAMP(3);
