-- How many copies of each auto-printed dispatch slip the store prints (e.g. one for the store, one for the kitchen).
ALTER TABLE "Location" ADD COLUMN "dispatchSlipCopies" INTEGER NOT NULL DEFAULT 1;
