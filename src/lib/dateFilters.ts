import { z } from "zod";
import { nairobiWallClockToUtc } from "./shifts.js";

export const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

// Nairobi wall-clock: a plain date (YYYY-MM-DD) or a date and time (YYYY-MM-DDTHH:mm).
// A plain `to` date means the end of that day; a date+time is used exactly as given.
export const localStamp = z.preprocess(blankToUndefined, z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, "Use YYYY-MM-DD or YYYY-MM-DDTHH:mm").optional());
export const dateOnlyStamp = z.preprocess(blankToUndefined, z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional());

/** Parses a localStamp value into a UTC instant. A date+time is used exactly
 * as given (inclusive of that whole minute when `endOfDay`); a plain date
 * means the start, or with `endOfDay`, the very end, of that Nairobi day. */
export function parseLocalStamp(value: string, endOfDay: boolean): Date {
  const [datePart, timePart] = value.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  if (timePart) {
    const [hh, mm] = timePart.split(":").map(Number);
    const at = nairobiWallClockToUtc(y, m, d, hh, mm);
    return endOfDay ? new Date(at.getTime() + 60_000 - 1) : at;
  }
  const at = nairobiWallClockToUtc(y, m, d, 0, 0);
  return endOfDay ? new Date(at.getTime() + 24 * 60 * 60 * 1000 - 1) : at;
}
