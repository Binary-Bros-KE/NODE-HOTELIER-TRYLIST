import { env } from "../config/env.js";
import { renderEmail } from "./emailTemplate.js";
import { mailConfigured, sendMail } from "./mailer.js";
import { prisma } from "./prisma.js";
import { nairobiParts } from "./shifts.js";

// Emails around online bookings: to the guest (request received, confirmed)
// and to the hotel (new booking, new enquiry, guest cancelled). Every function
// is safe to call without awaiting — use notify() — and does nothing when
// email isn't configured or there's no address to send to.

/** Runs a notification in the background; failures are logged, never thrown. */
export function notify(task: () => Promise<void>): void {
  if (!mailConfigured()) return;
  task().catch((error) => console.error("Notification failed:", error instanceof Error ? error.message : error));
}

const DAY_FMT = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const day = (d: Date) => DAY_FMT.format(d);
const money = (amount: number, currency: string) => `${currency === "KES" ? "KSh" : currency} ${Math.round(amount).toLocaleString("en-KE")}`;
/** "0795106483" → "0795 106 483" (Kenyan formats; others unchanged). */
const phone = (raw: string) => {
  const d = raw.replace(/[^\d+]/g, "");
  const m = /^0(\d{3})(\d{3})(\d{3})$/.exec(d) ?? /^\+?254(\d{3})(\d{3})(\d{3})$/.exec(d);
  return m ? (d.startsWith("0") ? `0${m[1]} ${m[2]} ${m[3]}` : `+254 ${m[1]} ${m[2]} ${m[3]}`) : raw;
};
const nights = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

/** Everything about the hotel an email needs. */
async function hotel(tenantId: string) {
  const t = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: {
      name: true, slug: true,
      businessProfile: { select: { businessName: true, email: true, primaryPhone: true, currency: true } },
      website: { select: { siteTitle: true, primaryColor: true } },
      websiteDomains: { where: { status: "ACTIVE", isPrimary: true }, select: { hostname: true }, take: 1 },
    },
  });
  const p = t.businessProfile;
  const host = t.websiteDomains[0]?.hostname ?? (env.SITE_DOMAIN ? `${t.slug}.${env.SITE_DOMAIN}` : null);
  return {
    name: t.website?.siteTitle ?? p?.businessName ?? t.name,
    email: p?.email ?? null,
    phone: p?.primaryPhone ?? null,
    currency: p?.currency ?? "KES",
    brand: t.website?.primaryColor ?? null,
    siteUrl: host ? `https://${host}` : null,
  };
}

const contactLine = (h: Awaited<ReturnType<typeof hotel>>) =>
  `Questions? Reply to this email${h.phone ? ` or call ${phone(h.phone)}` : ""}.`;

// ─── Room bookings ────────────────────────────────────────────────────────

async function roomBooking(manageToken: string) {
  return prisma.reservation.findFirst({
    where: { manageToken },
    include: { customer: true, room: { select: { roomType: { select: { name: true, baseRate: true } } } }, rate: { select: { price: true } }, folio: { select: { payments: { select: { amount: true } } } } },
  });
}

function roomRows(r: NonNullable<Awaited<ReturnType<typeof roomBooking>>>, currency: string) {
  const n = nights(r.checkIn, r.checkOut);
  const nightly = r.rate ? Number(r.rate.price) : Number(r.room.roomType.baseRate);
  const paid = (r.folio?.payments ?? []).reduce((s, p) => s + Number(p.amount), 0);
  return [
    { label: "Reference", value: r.reservationNo },
    { label: "Room", value: r.rateName ? `${r.room.roomType.name} — ${r.rateName}` : r.room.roomType.name },
    { label: "Arrival", value: day(r.checkIn) },
    { label: "Departure", value: day(r.checkOut) },
    { label: "Guests", value: `${r.adults} adult${r.adults === 1 ? "" : "s"}${r.children ? `, ${r.children} child${r.children === 1 ? "" : "ren"}` : ""}` },
    { label: "Estimated total", value: `${money(nightly * n, currency)} · ${n} night${n === 1 ? "" : "s"}` },
    ...(paid > 0 ? [{ label: "Paid", value: money(paid, currency) }] : []),
  ];
}

export async function roomBookingReceived(manageToken: string): Promise<void> {
  const r = await roomBooking(manageToken);
  if (!r) return;
  const h = await hotel(r.tenantId);
  const rows = roomRows(r, h.currency);
  const link = h.siteUrl ? `${h.siteUrl}/booking/${encodeURIComponent(manageToken)}` : null;

  if (r.customer.email) {
    const mail = renderEmail({
      hotelName: h.name, brandColor: h.brand, eyebrow: "Booking request",
      heading: `Thank you, ${r.customer.firstName}`,
      intro: ["We've received your booking request. Our team will confirm it shortly — you'll get another email as soon as they do.", "Here are the details:"],
      rows,
      button: link ? { label: "View or manage your booking", url: link } : undefined,
      footer: contactLine(h),
    });
    sendMail({ to: r.customer.email, fromName: h.name, replyTo: h.email, subject: `Booking request received — ${r.reservationNo}`, ...mail });
  }
  if (h.email) {
    const mail = renderEmail({
      hotelName: h.name, brandColor: h.brand, eyebrow: "New online booking",
      heading: `${r.customer.firstName} ${r.customer.lastName ?? ""}`.trim(),
      intro: ["A new booking request came in through your website. Confirm it in Reception (it's tagged “Web booking”)."],
      rows: [...rows, { label: "Phone", value: r.customer.phone }, ...(r.customer.email ? [{ label: "Email", value: r.customer.email }] : []), ...(r.notes ? [{ label: "Notes", value: r.notes }] : [])],
      footer: "Sent by your website.",
    });
    sendMail({ to: h.email, fromName: `${h.name} website`, replyTo: r.customer.email, subject: `New online booking — ${r.reservationNo}`, ...mail });
  }
}

/** After Reception confirms — only for bookings made online (they have a manage link). */
export async function roomBookingConfirmed(reservationId: string): Promise<void> {
  const ref = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { manageToken: true } });
  if (!ref?.manageToken) return;
  const r = await roomBooking(ref.manageToken);
  if (!r?.customer.email) return;
  const h = await hotel(r.tenantId);
  const mail = renderEmail({
    hotelName: h.name, brandColor: h.brand, eyebrow: "Booking confirmed",
    heading: "Your booking is confirmed",
    intro: [`Good news, ${r.customer.firstName} — we're expecting you. We look forward to welcoming you.`],
    rows: roomRows(r, h.currency),
    button: h.siteUrl ? { label: "View your booking", url: `${h.siteUrl}/booking/${encodeURIComponent(ref.manageToken)}` } : undefined,
    footer: contactLine(h),
  });
  sendMail({ to: r.customer.email, fromName: h.name, replyTo: h.email, subject: `Booking confirmed — ${r.reservationNo}`, ...mail });
}

// ─── Appointments ─────────────────────────────────────────────────────────

async function appointment(where: { manageToken: string } | { id: string }) {
  return prisma.appointment.findFirst({ where, include: { customer: true, service: { select: { name: true } }, serviceVariant: { select: { name: true } } } });
}

function appointmentRows(a: NonNullable<Awaited<ReturnType<typeof appointment>>>, currency: string) {
  const p = nairobiParts(a.startsAt);
  const when = `${DAY_FMT.format(new Date(Date.UTC(p.year, p.month - 1, p.day)))} · ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return [
    ...(a.bookingRef ? [{ label: "Reference", value: a.bookingRef }] : []),
    { label: "Service", value: a.serviceVariant ? `${a.service.name} — ${a.serviceVariant.name}` : a.service.name },
    { label: "When", value: when },
    { label: "Price", value: money(Number(a.amount), currency) },
  ];
}

export async function appointmentReceived(manageToken: string): Promise<void> {
  const a = await appointment({ manageToken });
  if (!a) return;
  const h = await hotel(a.tenantId);
  const rows = appointmentRows(a, h.currency);
  if (a.customer.email) {
    const mail = renderEmail({
      hotelName: h.name, brandColor: h.brand, eyebrow: "Appointment request",
      heading: `Thank you, ${a.customer.firstName}`,
      intro: ["We've received your appointment request. Our team will confirm your time shortly."],
      rows,
      button: h.siteUrl ? { label: "View or manage your appointment", url: `${h.siteUrl}/booking/${encodeURIComponent(manageToken)}` } : undefined,
      footer: contactLine(h),
    });
    sendMail({ to: a.customer.email, fromName: h.name, replyTo: h.email, subject: `Appointment request received${a.bookingRef ? ` — ${a.bookingRef}` : ""}`, ...mail });
  }
  if (h.email) {
    const mail = renderEmail({
      hotelName: h.name, brandColor: h.brand, eyebrow: "New appointment request",
      heading: `${a.customer.firstName} ${a.customer.lastName ?? ""}`.trim(),
      intro: ["A new appointment request came in through your website. Confirm it in the Service Center."],
      rows: [...rows, { label: "Phone", value: a.customer.phone }, ...(a.customer.email ? [{ label: "Email", value: a.customer.email }] : [])],
      footer: "Sent by your website.",
    });
    sendMail({ to: h.email, fromName: `${h.name} website`, replyTo: a.customer.email, subject: `New appointment request${a.bookingRef ? ` — ${a.bookingRef}` : ""}`, ...mail });
  }
}

export async function appointmentConfirmed(appointmentId: string): Promise<void> {
  const a = await appointment({ id: appointmentId });
  if (!a || a.source !== "WEBSITE" || !a.customer.email) return;
  const h = await hotel(a.tenantId);
  const mail = renderEmail({
    hotelName: h.name, brandColor: h.brand, eyebrow: "Appointment confirmed",
    heading: "Your appointment is confirmed",
    intro: [`See you soon, ${a.customer.firstName}.`],
    rows: appointmentRows(a, h.currency),
    button: h.siteUrl && a.manageToken ? { label: "View your appointment", url: `${h.siteUrl}/booking/${encodeURIComponent(a.manageToken)}` } : undefined,
    footer: contactLine(h),
  });
  sendMail({ to: a.customer.email, fromName: h.name, replyTo: h.email, subject: `Appointment confirmed${a.bookingRef ? ` — ${a.bookingRef}` : ""}`, ...mail });
}

// ─── To the hotel ─────────────────────────────────────────────────────────

export async function inquiryReceived(inquiryId: string): Promise<void> {
  const q = await prisma.websiteInquiry.findUnique({ where: { id: inquiryId } });
  if (!q) return;
  const h = await hotel(q.tenantId);
  if (!h.email) return;
  const mail = renderEmail({
    hotelName: h.name, brandColor: h.brand, eyebrow: `New enquiry · ${q.kind.toLowerCase()}`,
    heading: q.subject ?? `Message from ${q.name}`,
    intro: q.message.split(/\n\s*\n/),
    rows: [{ label: "From", value: q.name }, ...(q.phone ? [{ label: "Phone", value: q.phone }] : []), ...(q.email ? [{ label: "Email", value: q.email }] : [])],
    footer: q.email ? "Reply to this email to answer them directly." : "They left no email — please call them back.",
  });
  sendMail({ to: h.email, fromName: `${h.name} website`, replyTo: q.email, subject: `New website enquiry from ${q.name}`, ...mail });
}

export async function guestCancelled(manageToken: string): Promise<void> {
  const r = await roomBooking(manageToken);
  const a = r ? null : await appointment({ manageToken });
  const tenantId = r?.tenantId ?? a?.tenantId;
  if (!tenantId) return;
  const h = await hotel(tenantId);
  if (!h.email) return;
  const customer = r?.customer ?? a!.customer;
  const rows = r ? roomRows(r, h.currency) : appointmentRows(a!, h.currency);
  const reference = r?.reservationNo ?? a?.bookingRef ?? "";
  const mail = renderEmail({
    hotelName: h.name, brandColor: h.brand, eyebrow: "Cancelled by the guest",
    heading: `${customer.firstName} ${customer.lastName ?? ""}`.trim(),
    intro: [`This ${r ? "booking" : "appointment"} was cancelled online by the guest.`, ...(rows.some((x) => x.label === "Paid") ? ["They had paid online — please arrange the refund."] : [])],
    rows: [...rows, { label: "Phone", value: customer.phone }],
    footer: "Sent by your website.",
  });
  sendMail({ to: h.email, fromName: `${h.name} website`, replyTo: customer.email, subject: `Cancelled online${reference ? ` — ${reference}` : ""}`, ...mail });
}
