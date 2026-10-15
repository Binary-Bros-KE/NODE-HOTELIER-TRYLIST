import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import { normalizeMsisdn } from "../../lib/mpesa.js";
import { prisma } from "../../lib/prisma.js";
import { allow } from "../../lib/rateLimit.js";
import { nairobiParts } from "../../lib/shifts.js";
import { appointmentForGuest, appointmentSlots, cancelAppointmentByGuest, createAppointmentRequest } from "./appointments.js";
import {
  BookingError, bookingForGuest, bookingPaymentStatus, cancelBookingByGuest, createRoomBooking, depositFor, startBookingPayment,
} from "./bookings.js";
import { requireFeature } from "./site.js";

/**
 * Everything a website visitor can submit: room bookings, appointment
 * requests, enquiries, and their "manage my booking" page (looked up by the
 * secret token in their link). Mounted inside publicSiteRouter, after
 * requireSite. Nothing here is cached.
 */
export const publicBookingsRouter = Router();

publicBookingsRouter.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

// ─── Abuse guards ─────────────────────────────────────────────────────────

/** The visitor's IP as forwarded by the WEBSITE app (its own request IP is the app's). */
const visitor = (req: Request) => (req.header("x-site-client-ip") ?? req.ip ?? "unknown").slice(0, 64);

/** Per visitor and per site — a flood from many IPs still can't swamp one hotel's pending list. */
function limit(name: string, perVisitor: number, perSite: number, windowMs = 60 * 60_000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const site = req.site!.tenantId;
    if (!allow(`${name}:${site}:${visitor(req)}`, perVisitor, windowMs) || !allow(`${name}:${site}`, perSite, windowMs)) {
      res.status(429).json({ error: "Too many requests — please wait a little and try again, or call us." });
      return;
    }
    next();
  };
}

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const guestFields = {
  firstName: z.string().trim().min(1, "Enter your first name").max(60),
  lastName: z.string().trim().max(60).default(""),
  phone: z.string().trim().regex(/^\+?[\d\s()-]{7,20}$/, "Enter a phone number we can reach you on"),
  email: z.preprocess(blank, z.string().trim().toLowerCase().email("Enter a valid email address").max(120).optional()),
  notes: z.preprocess(blank, z.string().trim().max(1000).optional()),
  // Honeypot: a field real visitors never see. Anything in it = a bot.
  company: z.string().max(0, "Invalid request").optional(),
};

function fail(res: Response, error: unknown, fallback: string) {
  if (error instanceof BookingError) { res.status(error.status).json({ error: error.message }); return; }
  console.error(fallback, error);
  res.status(500).json({ error: fallback });
}

function invalid(res: Response, error: z.ZodError) {
  const first = error.issues[0];
  res.status(400).json({ error: first?.message ?? "Please check the form", details: error.flatten() });
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const DAY_MS = 86_400_000;

// ─── Rooms ────────────────────────────────────────────────────────────────

const roomBookingSchema = z.object({
  roomTypeId: z.string().trim().min(1).max(40),
  rateId: z.preprocess(blank, z.string().trim().max(40).optional()),
  checkIn: ymd,
  checkOut: ymd,
  adults: z.coerce.number().int().min(1).max(20),
  children: z.coerce.number().int().min(0).max(20).default(0),
  payment: z.enum(["deposit", "full"]).optional(),
  mpesaPhone: z.preprocess(blank, z.string().trim().max(20).optional()),
  ...guestFields,
}).superRefine((v, ctx) => {
  const t = nairobiParts(new Date());
  const today = Date.UTC(t.year, t.month - 1, t.day);
  const inAt = Date.parse(`${v.checkIn}T00:00:00Z`);
  const nights = (Date.parse(`${v.checkOut}T00:00:00Z`) - inAt) / DAY_MS;
  if (inAt < today) ctx.addIssue({ code: "custom", path: ["checkIn"], message: "Arrival can't be in the past" });
  if (inAt > today + 365 * DAY_MS) ctx.addIssue({ code: "custom", path: ["checkIn"], message: "Bookings open up to a year ahead" });
  if (!(nights >= 1)) ctx.addIssue({ code: "custom", path: ["checkOut"], message: "Departure must be after arrival" });
  if (nights > 60) ctx.addIssue({ code: "custom", path: ["checkOut"], message: "Stays are limited to 60 nights online" });
});

publicBookingsRouter.post("/bookings/room", requireFeature("roomBooking"), limit("room", 5, 60), async (req, res) => {
  const parsed = roomBookingSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error); return; }
  const { checkIn, checkOut, company: _honeypot, ...rest } = parsed.data;
  try {
    const result = await createRoomBooking(req.site!, {
      ...rest,
      checkIn: new Date(`${checkIn}T00:00:00.000Z`),
      checkOut: new Date(`${checkOut}T00:00:00.000Z`),
    });
    res.status(201).json(result);
  } catch (error) {
    fail(res, error, "We couldn't complete the booking — please try again or call us");
  }
});

// ─── Appointments ─────────────────────────────────────────────────────────

publicBookingsRouter.get("/services/:id/slots", requireFeature("appointments"), async (req, res) => {
  const date = ymd.safeParse(req.query.date);
  if (!date.success) { res.status(400).json({ error: "Choose a date" }); return; }
  const variantId = typeof req.query.variantId === "string" && req.query.variantId ? req.query.variantId : undefined;
  try {
    res.json({ slots: await appointmentSlots(req.site!, String(req.params.id), date.data, variantId) });
  } catch (error) {
    fail(res, error, "Couldn't load times");
  }
});

const appointmentSchema = z.object({
  serviceId: z.string().trim().min(1).max(40),
  variantId: z.preprocess(blank, z.string().trim().max(40).optional()),
  date: ymd,
  time: z.string().regex(/^\d{2}:\d{2}$/, "Choose a time"),
  ...guestFields,
});

publicBookingsRouter.post("/bookings/appointment", requireFeature("appointments"), limit("appointment", 5, 60), async (req, res) => {
  const parsed = appointmentSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error); return; }
  const { company: _honeypot, ...input } = parsed.data;
  try {
    res.status(201).json(await createAppointmentRequest(req.site!, input));
  } catch (error) {
    fail(res, error, "We couldn't book that appointment — please try again or call us");
  }
});

// ─── Manage my booking (room or appointment, by token) ────────────────────

const tokenOf = (req: Request) => {
  const token = String(req.params.token);
  return /^[A-Za-z0-9_-]{20,64}$/.test(token) ? token : null;
};

publicBookingsRouter.get("/bookings/:token", async (req, res) => {
  const token = tokenOf(req);
  if (!token) { res.status(404).json({ error: "Booking not found" }); return; }
  const room = await bookingForGuest(req.site!, token);
  if (room) { res.json({ kind: "room", booking: room }); return; }
  const appointment = await appointmentForGuest(req.site!, token);
  if (appointment) { res.json({ kind: "appointment", booking: appointment }); return; }
  res.status(404).json({ error: "Booking not found" });
});

publicBookingsRouter.post("/bookings/:token/cancel", limit("cancel", 10, 200), async (req, res) => {
  const token = tokenOf(req);
  if (!token) { res.status(404).json({ error: "Booking not found" }); return; }
  try {
    const isRoom = await prisma.reservation.count({ where: { manageToken: token, tenantId: req.site!.tenantId } });
    if (isRoom) await cancelBookingByGuest(req.site!, token);
    else await cancelAppointmentByGuest(req.site!, token);
    res.status(204).send();
  } catch (error) {
    fail(res, error, "We couldn't cancel the booking — please call us");
  }
});

const paySchema = z.object({ phone: z.string().trim().min(9).max(20), payment: z.enum(["deposit", "full"]).default("deposit") });

/** Sends (or re-sends) the M-Pesa prompt for a held booking. */
publicBookingsRouter.post("/bookings/:token/pay", limit("pay", 6, 300), async (req, res) => {
  const token = tokenOf(req);
  const parsed = paySchema.safeParse(req.body);
  if (!token || !parsed.success) { res.status(400).json({ error: "Enter the Safaricom number to send the prompt to" }); return; }
  const phone = normalizeMsisdn(parsed.data.phone);
  if (!phone) { res.status(400).json({ error: "Enter a Safaricom number, e.g. 0712 345 678" }); return; }
  try {
    const booking = await bookingForGuest(req.site!, token);
    if (!booking || booking.paymentDue <= 0) { res.status(409).json({ error: "This booking has nothing to pay online" }); return; }
    const reservation = await prisma.reservation.findFirstOrThrow({ where: { manageToken: token, tenantId: req.site!.tenantId }, select: { id: true } });
    const amount = parsed.data.payment === "full" ? booking.estimatedTotal : depositFor(req.site!, booking.estimatedTotal);
    res.status(201).json(await startBookingPayment(req.site!, reservation.id, phone, amount));
  } catch (error) {
    fail(res, error, "We couldn't send the M-Pesa prompt — please try again");
  }
});

publicBookingsRouter.get("/bookings/:token/payments/:requestId", async (req, res) => {
  const token = tokenOf(req);
  const reservation = token ? await prisma.reservation.findFirst({ where: { manageToken: token, tenantId: req.site!.tenantId }, select: { id: true } }) : null;
  const status = reservation ? await bookingPaymentStatus(req.site!, reservation.id, String(req.params.requestId)) : null;
  if (!status) { res.status(404).json({ error: "Payment not found" }); return; }
  res.json(status);
});

// ─── Enquiries ────────────────────────────────────────────────────────────

const inquirySchema = z.object({
  kind: z.enum(["GENERAL", "EVENT", "ROOM", "SERVICE", "MEMBERSHIP"]).default("GENERAL"),
  name: z.string().trim().min(1, "Enter your name").max(120),
  email: z.preprocess(blank, z.string().trim().toLowerCase().email("Enter a valid email address").max(120).optional()),
  phone: z.preprocess(blank, z.string().trim().regex(/^\+?[\d\s()-]{7,20}$/, "Enter a valid phone number").optional()),
  subject: z.preprocess(blank, z.string().trim().max(160).optional()),
  message: z.string().trim().min(5, "Tell us a little more").max(4000),
  details: z.record(z.string(), z.union([z.string().max(200), z.number()])).optional(),
  sourcePage: z.preprocess(blank, z.string().trim().max(200).optional()),
  company: z.string().max(0, "Invalid request").optional(),
}).refine((v) => v.email || v.phone, { message: "Leave an email or a phone number so we can reply", path: ["email"] });

publicBookingsRouter.post("/inquiries", requireFeature("inquiries"), limit("inquiry", 5, 100), async (req, res) => {
  const parsed = inquirySchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error); return; }
  const { company: _honeypot, ...data } = parsed.data;
  const site = req.site!;
  // Link to a known guest when the phone/email matches one; never create guests from enquiries.
  const customer = await prisma.customer.findFirst({
    where: { tenantId: site.tenantId, OR: [...(data.email ? [{ email: data.email }] : []), ...(data.phone ? [{ phone: data.phone }] : [])] },
    select: { id: true },
  });
  await prisma.websiteInquiry.create({ data: { ...data, tenantId: site.tenantId, customerId: customer?.id ?? null } });
  res.status(201).json({ ok: true });
});
