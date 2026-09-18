import { nairobiParts, nairobiWallClockToUtc, addDays } from "./shifts.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The UTC instant marking the start of the "business day" containing `at`,
 * for a tenant whose trading day rolls over at `startHour` Nairobi wall-clock
 * time (0 = plain midnight). Before that hour, `at` is still inside the
 * business day that began the previous Nairobi calendar day — e.g. a 1am
 * sale at a club with startHour=9 belongs to yesterday's still-open night,
 * not "today."
 */
export function businessDayStart(startHour: number, at: Date = new Date()): Date {
  const p = nairobiParts(at);
  const todayStart = nairobiWallClockToUtc(p.year, p.month, p.day, startHour, 0);
  if (at.getTime() >= todayStart.getTime()) return todayStart;
  const y = nairobiParts(new Date(todayStart.getTime() - DAY_MS));
  return nairobiWallClockToUtc(y.year, y.month, y.day, startHour, 0);
}

/** Y-M-D (as a UTC-midnight marker, same convention as nairobiDateOnly) that
 * names the business day containing `at` — the calendar date it started on. */
export function businessDateOnly(startHour: number, at: Date): Date {
  const p = nairobiParts(businessDayStart(startHour, at));
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

/** [start, end] window (end inclusive, 1ms before the next rollover) for the
 * business day that starts on Nairobi calendar date (year, month, day). */
export function businessDayWindowFor(startHour: number, year: number, month: number, day: number): { start: Date; end: Date } {
  const start = nairobiWallClockToUtc(year, month, day, startHour, 0);
  return { start, end: new Date(start.getTime() + DAY_MS - 1) };
}

/** Same as businessDayWindowFor, reading year/month/day off a UTC-midnight
 * marker Date (as produced by businessDateOnly or plain `new Date("Y-M-D")`). */
export function businessDayWindowForDateOnly(startHour: number, dateOnly: Date): { start: Date; end: Date } {
  return businessDayWindowFor(startHour, dateOnly.getUTCFullYear(), dateOnly.getUTCMonth() + 1, dateOnly.getUTCDate());
}

/** [start, end] window for the business day currently in progress at `at`. */
export function businessDayWindow(startHour: number, at: Date = new Date()): { start: Date; end: Date } {
  const start = businessDayStart(startHour, at);
  return { start, end: new Date(start.getTime() + DAY_MS - 1) };
}

/** "YYYY-MM-DD" key for the business day containing `at` — buckets a
 * timestamp by trading day instead of calendar day, e.g. for a revenue
 * trend chart. */
export function businessDayKey(startHour: number, at: Date): string {
  const p = nairobiParts(businessDayStart(startHour, at));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export { addDays };
