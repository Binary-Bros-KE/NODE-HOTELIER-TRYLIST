import { randomBytes } from "node:crypto";

import { prisma } from "../../lib/prisma.js";
import { nextSequenceNo } from "../../lib/sequence.js";
import { nairobiParts, nairobiWallClockToUtc } from "../../lib/shifts.js";
import { BookingError, findOrCreateCustomer, type GuestDetails } from "./bookings.js";
import type { PublicSite } from "./site.js";

// Online appointment requests. Each one is a normal Appointment (source
// WEBSITE, status BOOKED) that staff confirm — the slot list below is a
// helpful guide, not a hard reservation system.

const SLOT_STEP_MIN = 30;
const LEAD_TIME_MIN = 60;
const MAX_DAYS_AHEAD = 90;
const DEFAULT_DURATION_MIN = 60;
const OPEN_STATUSES = ["BOOKED", "CONFIRMED", "IN_PROGRESS"] as const;

const toMinutes = (hhmm: string | null | undefined, fallback: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
};
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

async function bookableService(site: PublicSite, serviceId: string, variantId?: string) {
  const service = await prisma.service.findFirst({
    where: { id: serviceId, tenantId: site.tenantId, isActive: true, showOnWebsite: true, bookableOnline: true },
    include: { variants: { where: { isActive: true } } },
  });
  if (!service) throw new BookingError(404, "That service can't be booked online");
  const variant = variantId ? service.variants.find((v) => v.id === variantId) : undefined;
  if (variantId && !variant) throw new BookingError(400, "Choose one of this service's options");
  if (!variant && service.variants.length > 0) throw new BookingError(400, "Choose an option for this service");
  return {
    service,
    variant,
    duration: variant?.durationMinutes ?? service.durationMinutes ?? DEFAULT_DURATION_MIN,
    price: Number(variant?.price ?? service.price),
  };
}

/** How many of this service can run at once: the number of different staff
 * who've delivered it lately (at least one). */
async function parallelCapacity(tenantId: string, serviceId: string): Promise<number> {
  const providers = await prisma.appointment.findMany({
    where: { tenantId, serviceId, providerId: { not: null }, startsAt: { gt: new Date(Date.now() - 90 * 86_400_000) } },
    select: { providerId: true },
    distinct: ["providerId"],
  });
  return Math.max(1, providers.length);
}

/** Start times (HH:MM, Nairobi) still open on `date` for this service. */
export async function appointmentSlots(site: PublicSite, serviceId: string, date: string, variantId?: string): Promise<string[]> {
  const { duration } = await bookableService(site, serviceId, variantId);
  const [y, m, d] = date.split("-").map(Number);
  const dayStart = nairobiWallClockToUtc(y, m, d, 0, 0);
  const now = new Date();
  const today = nairobiParts(now);
  const todayStart = nairobiWallClockToUtc(today.year, today.month, today.day, 0, 0);
  if (dayStart < todayStart || dayStart.getTime() > todayStart.getTime() + MAX_DAYS_AHEAD * 86_400_000) return [];

  const location = site.website.bookingLocationId
    ? await prisma.location.findUnique({ where: { id: site.website.bookingLocationId }, select: { openingTime: true, closingTime: true } })
    : null;
  const open = toMinutes(location?.openingTime, 8 * 60);
  const close = toMinutes(location?.closingTime, 20 * 60);

  const [existing, capacity] = await Promise.all([
    prisma.appointment.findMany({
      where: { tenantId: site.tenantId, serviceId, status: { in: [...OPEN_STATUSES] }, startsAt: { lt: new Date(dayStart.getTime() + 86_400_000) }, endsAt: { gt: dayStart } },
      select: { startsAt: true, endsAt: true },
    }),
    parallelCapacity(site.tenantId, serviceId),
  ]);

  const slots: string[] = [];
  for (let start = open; start + duration <= close; start += SLOT_STEP_MIN) {
    const startsAt = new Date(dayStart.getTime() + start * 60_000);
    const endsAt = new Date(startsAt.getTime() + duration * 60_000);
    if (startsAt.getTime() < now.getTime() + LEAD_TIME_MIN * 60_000) continue;
    const overlapping = existing.filter((a) => a.startsAt < endsAt && a.endsAt > startsAt).length;
    if (overlapping < capacity) slots.push(hhmm(start));
  }
  return slots;
}

export type AppointmentInput = GuestDetails & { serviceId: string; variantId?: string; date: string; time: string; notes?: string };

export async function createAppointmentRequest(site: PublicSite, input: AppointmentInput) {
  const { service, variant, duration, price } = await bookableService(site, input.serviceId, input.variantId);
  // Re-check the slot against live bookings right before saving.
  const open = await appointmentSlots(site, service.id, input.date, variant?.id);
  if (!open.includes(input.time)) throw new BookingError(409, "That time was just taken — please choose another");
  const [y, m, d] = input.date.split("-").map(Number);
  const [hh, mm] = input.time.split(":").map(Number);
  const startsAt = nairobiWallClockToUtc(y, m, d, hh, mm);
  const manageToken = randomBytes(24).toString("base64url");

  const appointment = await prisma.$transaction(async (tx) => {
    const customer = await findOrCreateCustomer(tx, site, input);
    return tx.appointment.create({
      data: {
        tenantId: site.tenantId,
        customerId: customer.id,
        serviceId: service.id,
        serviceVariantId: variant?.id ?? null,
        locationId: site.website.bookingLocationId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + duration * 60_000),
        status: "BOOKED",
        amount: price,
        source: "WEBSITE",
        bookingRef: await nextSequenceNo(site.tenantId, "appointment", "APT", 6),
        manageToken,
        notes: ["Requested online.", input.notes ? `Guest note: ${input.notes}` : null].filter(Boolean).join("\n"),
      },
    });
  });
  return { manageToken, reference: appointment.bookingRef };
}

export async function appointmentForGuest(site: PublicSite, manageToken: string) {
  const a = await prisma.appointment.findFirst({
    where: { manageToken, tenantId: site.tenantId },
    include: {
      customer: { select: { firstName: true, lastName: true, email: true } },
      service: { select: { name: true, imageUrl: true } },
      serviceVariant: { select: { name: true } },
    },
  });
  if (!a) return null;
  const p = nairobiParts(a.startsAt);
  return {
    reference: a.bookingRef,
    status: a.status,
    date: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`,
    time: hhmm(p.hour * 60 + p.minute),
    durationMinutes: Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60_000),
    service: { name: a.service.name, variant: a.serviceVariant?.name ?? null, imageUrl: a.service.imageUrl },
    guest: { firstName: a.customer.firstName, lastName: a.customer.lastName, email: a.customer.email },
    amount: Number(a.amount),
    canCancel: (a.status === "BOOKED" || a.status === "CONFIRMED") && a.startsAt.getTime() > Date.now(),
  };
}

export async function cancelAppointmentByGuest(site: PublicSite, manageToken: string) {
  const a = await prisma.appointment.findFirst({ where: { manageToken, tenantId: site.tenantId } });
  if (!a) throw new BookingError(404, "Booking not found");
  if (!(a.status === "BOOKED" || a.status === "CONFIRMED") || a.startsAt.getTime() <= Date.now()) {
    throw new BookingError(409, "This appointment can no longer be cancelled online — please call us");
  }
  await prisma.appointment.update({
    where: { id: a.id },
    data: { status: "CANCELLED", notes: `${a.notes ?? ""}\nCancelled by the guest online.`.trim() },
  });
}
