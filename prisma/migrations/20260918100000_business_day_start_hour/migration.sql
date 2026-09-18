-- Every venue used to have its "today" computed as plain calendar
-- midnight-to-midnight (in whatever timezone the server process happened to
-- be running in, which is a separate bug this same change fixes by routing
-- all of it through Nairobi wall-clock math instead). A club trading past
-- midnight needs its own rollover hour, e.g. 9am, so a 1am sale still counts
-- toward the night that's still open rather than bleeding into "today."
-- Default 0 reproduces existing midnight-to-midnight behavior unchanged for
-- every tenant that never touches this setting.
ALTER TABLE "BusinessProfile" ADD COLUMN "businessDayStartHour" INTEGER NOT NULL DEFAULT 0;
