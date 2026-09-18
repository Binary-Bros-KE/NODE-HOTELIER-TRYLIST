import { prisma } from "./prisma.js";

// This product is Kenya-only today (the tax rules already assume it), and
// Africa/Nairobi has been a fixed UTC+3 offset with no DST since 1960 — so a
// hardcoded offset is exact forever, no timezone database needed.
const NAIROBI_OFFSET_MINUTES = 3 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ResolvedShift = {
  id: string;
  name: string;
  startTime: string; // "HH:mm", Nairobi local time
  endTime: string;
  graceMinutesBefore: number;
  graceMinutesAfter: number;
};

export function nairobiParts(date: Date) {
  const shifted = new Date(date.getTime() + NAIROBI_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

export function nairobiWallClockToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - NAIROBI_OFFSET_MINUTES * 60_000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** The Nairobi calendar day `date` falls on, as a UTC-midnight Date — matches
 * how Prisma stores `@db.Date` columns (EmployeeShiftOverride.date etc). */
export function nairobiDateOnly(date: Date): Date {
  const p = nairobiParts(date);
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

function toResolved(t: {
  id: string; name: string; startTime: string; endTime: string;
  graceMinutesBefore: number; graceMinutesAfter: number; isActive: boolean;
}): ResolvedShift | null {
  if (!t.isActive) return null;
  return { id: t.id, name: t.name, startTime: t.startTime, endTime: t.endTime, graceMinutesBefore: t.graceMinutesBefore, graceMinutesAfter: t.graceMinutesAfter };
}

/**
 * Resolves what shift (if any) applies to an employee at a given moment. An
 * explicit override for that calendar day wins outright (including a null
 * shiftTemplateId, meaning "unrestricted today"); otherwise it's computed
 * from the employee's rotation cycle. Returns null — unrestricted — if the
 * employee has no rotation configured at all.
 */
export async function resolveShiftFor(tenantId: string, employeeId: string, at: Date = new Date()): Promise<ResolvedShift | null> {
  const today = nairobiDateOnly(at);

  const override = await prisma.employeeShiftOverride.findUnique({
    where: { employeeId_date: { employeeId, date: today } },
    include: { shiftTemplate: true },
  });
  if (override) return override.shiftTemplate ? toResolved(override.shiftTemplate) : null;

  const rotation = await prisma.employeeShiftRotation.findUnique({
    where: { employeeId },
    include: { slots: { include: { shiftTemplate: true }, orderBy: { position: "asc" } } },
  });
  if (!rotation || rotation.slots.length === 0 || rotation.tenantId !== tenantId) return null;

  const daysSinceAnchor = Math.floor((today.getTime() - rotation.anchorDate.getTime()) / DAY_MS);
  const cyclePos = ((daysSinceAnchor % rotation.cycleLengthDays) + rotation.cycleLengthDays) % rotation.cycleLengthDays;
  const slot = rotation.slots.find((s) => cyclePos >= s.position && cyclePos < s.position + s.days);
  return slot ? toResolved(slot.shiftTemplate) : null;
}

function shiftInstanceWindow(shift: ResolvedShift, dayStart: Date): { start: Date; end: Date } {
  const p = nairobiParts(dayStart);
  const [startHour, startMinute] = shift.startTime.split(":").map(Number);
  const [endHour, endMinute] = shift.endTime.split(":").map(Number);
  const start = nairobiWallClockToUtc(p.year, p.month, p.day, startHour, startMinute);
  const crossesMidnight = endHour * 60 + endMinute <= startHour * 60 + startMinute;
  const endDay = crossesMidnight ? addDays(dayStart, 1) : dayStart;
  const pe = nairobiParts(endDay);
  const end = nairobiWallClockToUtc(pe.year, pe.month, pe.day, endHour, endMinute);
  return { start, end };
}

/**
 * Whether `at` falls within `shift`'s window, grace period included. Checks
 * both the instance of this shift that would have started "today" and the
 * one that started "yesterday" — the latter is what actually covers an
 * overnight shift (e.g. 22:00-06:00) when checked in the early morning.
 */
export function isWithinShift(shift: ResolvedShift, at: Date = new Date()): boolean {
  const today = nairobiDateOnly(at);
  const yesterday = addDays(today, -1);
  const beforeMs = shift.graceMinutesBefore * 60_000;
  const afterMs = shift.graceMinutesAfter * 60_000;
  for (const dayStart of [yesterday, today]) {
    const { start, end } = shiftInstanceWindow(shift, dayStart);
    if (at.getTime() >= start.getTime() - beforeMs && at.getTime() <= end.getTime() + afterMs) return true;
  }
  return false;
}
