import { Router } from "express";
import { z } from "zod";
import type { Prisma, ReservationActivityAction } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { nextCustomerNo, nextReservationNo, nextFolioNo, nextTransactionNo } from "../../lib/sequence.js";
import { resolveActorLocationWithHint } from "../../lib/location.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { applyCustomerBalance, folioCreditOutstanding } from "../../lib/customerCredit.js";

export const receptionRouter = Router();
receptionRouter.use(requireModule("RESERVATIONS"));

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const RESERVATION_SOURCES = ["WALK_IN", "PHONE", "WEBSITE", "BOOKING_ENGINE", "TRAVEL_AGENT", "OTA", "CORPORATE", "OTHER"] as const;
const CANCELLATION_REASONS = ["CHANGED_MIND", "NO_SHOW", "FOUND_ALTERNATIVE", "DUPLICATE_BOOKING", "HOTEL_CANCELLED", "OTHER"] as const;
const OPEN_RESERVATION_STATUSES = ["PENDING", "CONFIRMED", "CHECKED_IN"] as const;
const MEAL_PLANS = ["ROOM_ONLY", "BED_AND_BREAKFAST", "HALF_BOARD", "FULL_BOARD"] as const;
const MEAL_PLAN_LABELS: Record<(typeof MEAL_PLANS)[number], string> = {
  ROOM_ONLY: "Room Only",
  BED_AND_BREAKFAST: "Bed & Breakfast",
  HALF_BOARD: "Half Board",
  FULL_BOARD: "Full Board",
};

const CUSTOMER_TYPES = ["PERSONAL", "BUSINESS"] as const;
const customerSchema = z.object({ customerType: z.enum(CUSTOMER_TYPES).default("PERSONAL"), firstName: z.string().trim().min(1), lastName: z.string().trim().min(1).optional(), email: z.email().optional(), phone: z.string().trim().min(5).max(30) });

// How a room is sold. PAID is the default; COMPLIMENTARY gives the room free
// (its value stays on the folio, written off by a matching discount line). A
// discount is either a percentage of the room charges or a fixed amount off
// the whole stay.
const roomTermsFields = {
  roomSaleType: z.enum(["PAID", "COMPLIMENTARY"]).default("PAID"),
  complimentaryReason: optionalText(255),
  discountType: z.preprocess(blankToUndefined, z.enum(["PERCENT", "AMOUNT"]).optional()),
  discountValue: z.preprocess(blankToUndefined, z.coerce.number().min(0).default(0)),
  discountReason: optionalText(255),
};
const roomTermsSchema = z.object(roomTermsFields).refine((v) => v.discountType !== "PERCENT" || v.discountValue <= 100, { message: "A percentage discount can't exceed 100%", path: ["discountValue"] });

const reservationCreateFields = z.object({
  customerId: z.string().cuid(),
  roomId: z.string().cuid(),
  source: z.enum(RESERVATION_SOURCES).default("WALK_IN"),
  bookingDate: z.coerce.date().optional(),
  checkIn: z.coerce.date(),
  checkOut: z.coerce.date(),
  adults: z.coerce.number().int().min(1).default(1),
  children: z.coerce.number().int().min(0).default(0),
  mealPlan: z.enum(MEAL_PLANS).default("ROOM_ONLY"),
  notes: optionalText(500),
  // Walk-ins submit CHECKED_IN directly to skip the Pending→Confirmed hop.
  status: z.enum(["PENDING", "CONFIRMED", "CHECKED_IN"]).default("PENDING"),
  ...roomTermsFields,
});
const reservationSchema = reservationCreateFields
  .refine((v) => v.checkOut > v.checkIn, { message: "Check-out must be after check-in", path: ["checkOut"] })
  .refine((v) => v.discountType !== "PERCENT" || v.discountValue <= 100, { message: "A percentage discount can't exceed 100%", path: ["discountValue"] });

const reservationUpdateSchema = z.object({
  customerId: z.string().cuid().optional(),
  roomId: z.string().cuid().optional(),
  source: z.enum(RESERVATION_SOURCES).optional(),
  bookingDate: z.coerce.date().optional(),
  checkIn: z.coerce.date().optional(),
  checkOut: z.coerce.date().optional(),
  adults: z.coerce.number().int().min(1).optional(),
  children: z.coerce.number().int().min(0).optional(),
  mealPlan: z.enum(MEAL_PLANS).optional(),
  notes: optionalText(500),
});

const cancelSchema = z.object({ cancellationReason: z.enum(CANCELLATION_REASONS), cancellationNotes: optionalText(500) });
const checkInSchema = z.object({ mealPlan: z.enum(MEAL_PLANS).optional() });
const extendSchema = z.object({ checkOut: z.coerce.date() });
const optionalDate = z.preprocess(blankToUndefined, z.coerce.date().optional());
// What a checkout can carry beyond a payment: if a balance is left, why it's
// being left and when it's expected (checkout on credit).
const creditFields = { creditReason: optionalText(255), creditExpectedAt: optionalDate };
const guestSchema = z.object({ name: z.string().trim().min(1).max(120), idNumber: optionalText(40), notes: optionalText(255) });
const chargeSchema = z.object({
  source: z.enum(["SERVICE", "AD_HOC"]),
  label: z.string().trim().min(1).max(120).optional(),
  amount: z.coerce.number().nonnegative().optional(),
  quantity: z.coerce.number().int().min(1).default(1),
  sourceRefId: z.string().cuid().optional(),
}).refine((v) => v.source !== "AD_HOC" || (v.label && v.amount !== undefined), { message: "Ad-hoc charges need a label and amount", path: ["label"] })
  .refine((v) => v.source !== "SERVICE" || v.sourceRefId, { message: "Choose a service", path: ["sourceRefId"] });
const paymentSchema = z.object({ paymentMethodId: z.string().trim().min(1), amount: z.coerce.number().positive(), reference: optionalText(60) });

async function resolvePaymentMethod(tid: string, paymentMethodId: string, reference: string | undefined) {
  const method = await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, tenantId: tid, isActive: true } });
  if (!method) throw Object.assign(new Error("Choose a valid, active payment method"), { status: 400 });
  if (method.requiresReference && !reference) throw Object.assign(new Error(`${method.name} requires a reference number`), { status: 400 });
  return method;
}

function tenantId(req: { tenantId?: string }): string { if (!req.tenantId) throw new Error("Tenant context is required"); return req.tenantId; }
function invalid(res: { status: (code: number) => { json: (value: unknown) => unknown } }, label: string, details: unknown) { return res.status(400).json({ error: `Invalid ${label}`, details }); }
function nights(checkIn: Date, checkOut: Date): number { return Math.max(1, Math.ceil((checkOut.getTime() - checkIn.getTime()) / 86_400_000)); }

type ActorContext = { locationId: string | null; performedBy: string | undefined; name: string };

// Best-effort "who/where" for the activity log — an employee's fixed
// location (RECEP1 -> RECEPTION, etc.) when known, null otherwise. Never
// blocks the action: forcing every receptionist to pick a location on every
// click would be new friction nobody asked for, unlike POS where a sale's
// location is load-bearing for stock/sales logic.
async function resolveActor(tid: string, req: { userId?: string; header?: (name: string) => string | undefined }): Promise<ActorContext> {
  if (!req.userId) return { locationId: null, performedBy: undefined, name: "System" };
  const employee = await prisma.employee.findFirst({ where: { id: req.userId, tenantId: tid }, select: { firstName: true, lastName: true } });
  if (!employee) return { locationId: null, performedBy: req.userId, name: "System" };
  return { locationId: await resolveActorLocationWithHint(tid, req.userId, req.header?.("x-location-id") || undefined), performedBy: req.userId, name: `${employee.firstName} ${employee.lastName}` };
}

async function logActivity(
  tx: Prisma.TransactionClient,
  tid: string,
  reservationId: string,
  action: ReservationActivityAction,
  label: string,
  actor: ActorContext,
) {
  await tx.reservationActivity.create({
    data: { tenantId: tid, reservationId, action, summary: `${label} by ${actor.name}`, performedBy: actor.performedBy, locationId: actor.locationId },
  });
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Terms as stored: complimentary ignores any discount, a paid room ignores
 * the complimentary reason, and a zero discount is no discount. */
function normalizeTerms(t: { roomSaleType: "PAID" | "COMPLIMENTARY"; complimentaryReason?: string; discountType?: "PERCENT" | "AMOUNT"; discountValue: number; discountReason?: string }) {
  if (t.roomSaleType === "COMPLIMENTARY") {
    return { roomSaleType: "COMPLIMENTARY" as const, complimentaryReason: t.complimentaryReason ?? null, discountType: null, discountValue: 0, discountReason: null };
  }
  const discounted = Boolean(t.discountType) && t.discountValue > 0;
  return {
    roomSaleType: "PAID" as const,
    complimentaryReason: null,
    discountType: discounted ? t.discountType! : null,
    discountValue: discounted ? t.discountValue : 0,
    discountReason: discounted ? t.discountReason ?? null : null,
  };
}

const ROOM_ADJUSTMENT_REFS = ["ROOM_DISCOUNT", "ROOM_COMPLIMENTARY"];

/** Recomputes the single write-off line for a stay's room charges from the
 * reservation's terms: a complimentary room is written off in full, a
 * discount takes a percentage (or a fixed amount) off. Idempotent — it
 * replaces its own previous line, so it can run after check-in, an
 * extension, or an edit of the terms without stacking. */
async function syncRoomAdjustment(tx: Prisma.TransactionClient, tid: string, reservationId: string, by: string | undefined) {
  const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: { room: true, folio: { include: { lineItems: true } } } });
  if (!reservation.folio) return;
  await tx.folioLineItem.deleteMany({ where: { folioId: reservation.folio.id, source: "DISCOUNT", sourceRefId: { in: ROOM_ADJUSTMENT_REFS } } });
  const roomTotal = round2(reservation.folio.lineItems.filter((l) => l.source === "ROOM").reduce((sum, l) => sum + Number(l.amount) * l.quantity, 0));
  if (roomTotal <= 0) return;
  let off = 0;
  let label = "";
  let ref = "ROOM_DISCOUNT";
  if (reservation.roomSaleType === "COMPLIMENTARY") {
    off = roomTotal;
    ref = "ROOM_COMPLIMENTARY";
    label = `Complimentary room ${reservation.room.number}${reservation.complimentaryReason ? ` — ${reservation.complimentaryReason}` : ""}`;
  } else if (reservation.discountType && Number(reservation.discountValue) > 0) {
    const value = Number(reservation.discountValue);
    off = reservation.discountType === "PERCENT" ? round2(roomTotal * Math.min(value, 100) / 100) : Math.min(round2(value), roomTotal);
    label = `Room discount — ${reservation.discountType === "PERCENT" ? `${value}%` : `KSh ${value.toLocaleString("en-KE")}`}${reservation.discountReason ? ` (${reservation.discountReason})` : ""}`;
  }
  if (off <= 0) return;
  await tx.folioLineItem.create({ data: { tenantId: tid, folioId: reservation.folio.id, source: "DISCOUNT", label, amount: -off, quantity: 1, sourceRefId: ref, createdBy: by } });
}

/** Adds each settled stay's outstanding credit to its folio, for display. */
async function withCreditOutstanding<T extends { folio: { id: string; creditAmount: unknown } | null }>(tid: string, reservations: T[]) {
  const ids = reservations.flatMap((r) => (r.folio && Number(r.folio.creditAmount) > 0 ? [r.folio.id] : []));
  const outstanding = await folioCreditOutstanding(prisma, tid, ids);
  return reservations.map((r) => (r.folio ? { ...r, folio: { ...r.folio, creditOutstanding: outstanding.get(r.folio.id) ?? 0 } } : r));
}

// The room's own nightlyRate is the fallback when a RoomType hasn't
// configured a RoomRate tier for the requested meal plan — most tenants will
// have set up all four, but nothing forces it, so a stay is never blocked on
// a missing tier.
async function roomRateFor(
  client: { roomRate: { findFirst: (args: { where: { roomTypeId: string; mealPlan: (typeof MEAL_PLANS)[number] } }) => Promise<{ price: Prisma.Decimal } | null> } },
  roomTypeId: string,
  mealPlan: (typeof MEAL_PLANS)[number],
  fallback: Prisma.Decimal,
) {
  const rate = await client.roomRate.findFirst({ where: { roomTypeId, mealPlan } });
  return rate ? rate.price : fallback;
}

receptionRouter.get("/customers", async (req, res) => res.json({ customers: await prisma.customer.findMany({ where: { tenantId: tenantId(req) }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }] }) }));
receptionRouter.post("/customers", async (req, res) => { const data = customerSchema.safeParse(req.body); if (!data.success) { invalid(res, "customer", data.error.flatten()); return; } const tid = tenantId(req); const customerNo = await nextCustomerNo(tid); const actor = await resolveActor(tid, req); res.status(201).json({ customer: await prisma.customer.create({ data: { tenantId: tid, customerNo, createdBy: actor.performedBy, locationId: actor.locationId, ...data.data } }) }); });
receptionRouter.patch("/customers/:id", async (req, res) => { const data = partialNoDefaults(customerSchema).safeParse(req.body); if (!data.success) { invalid(res, "customer", data.error.flatten()); return; } const customer = await prisma.customer.updateMany({ where: { id: req.params.id, tenantId: tenantId(req) }, data: { ...data.data, updatedBy: req.userId } }); if (!customer.count) { res.status(404).json({ error: "Customer not found" }); return; } res.json({ customer: await prisma.customer.findUniqueOrThrow({ where: { id: req.params.id } }) }); });
receptionRouter.delete("/customers/:id", async (req, res) => { const customer = await prisma.customer.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } }); if (!customer.count) { res.status(404).json({ error: "Customer not found" }); return; } res.status(204).send(); });

// Full Room/RoomType CRUD lives in rooms.routes.ts (mounted at /rooms) — this
// is read-only, kept here only for the reservation form's room picker.
receptionRouter.get("/rooms", async (req, res) => res.json({ rooms: await prisma.room.findMany({ where: { tenantId: tenantId(req) }, include: { roomType: true }, orderBy: { number: "asc" } }) }));

async function roomIsAvailable(scope: { tenantId: string; roomId: string; checkIn: Date; checkOut: Date; excludeId?: string }) {
  return !(await prisma.reservation.findFirst({ where: { tenantId: scope.tenantId, roomId: scope.roomId, status: { in: [...OPEN_RESERVATION_STATUSES] }, checkIn: { lt: scope.checkOut }, checkOut: { gt: scope.checkIn }, ...(scope.excludeId ? { id: { not: scope.excludeId } } : {}) } }));
}

const reservationInclude = {
  customer: true,
  room: { include: { roomType: true } },
  location: { select: { id: true, name: true } },
  additionalGuests: { orderBy: { addedAt: "asc" as const } },
  activities: {
    orderBy: { occurredAt: "desc" as const },
    include: {
      employee: { select: { id: true, firstName: true, lastName: true } },
      location: { select: { id: true, name: true } },
    },
  },
  folio: {
    include: {
      lineItems: { orderBy: { createdAt: "asc" as const } },
      payments: { include: { paymentMethod: { select: { id: true, name: true, requiresReference: true } } }, orderBy: { createdAt: "asc" as const } },
    },
  },
};

function folioTotals(folio: { lineItems: { amount: unknown; quantity: number }[]; payments: { amount: unknown }[] } | null) {
  if (!folio) return { charges: 0, paid: 0, balance: 0 };
  const charges = folio.lineItems.reduce((sum, item) => sum + Number(item.amount) * item.quantity, 0);
  const paid = folio.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  return { charges, paid, balance: charges - paid };
}

async function freeRoom(tx: Prisma.TransactionClient, tenantId: string, roomId: string, customerName: string, reason: string) {
  await tx.room.update({ where: { id: roomId }, data: { status: "VACANT", cleanliness: "DIRTY" } });
  const activeTask = await tx.housekeepingTask.findFirst({ where: { roomId, status: { in: ["PENDING", "IN_PROGRESS"] }, type: "CLEANING" } });
  if (!activeTask) await tx.housekeepingTask.create({ data: { tenantId, roomId, type: "CLEANING", notes: `Automatic turnover after ${customerName} ${reason}` } });
}

receptionRouter.get("/reservations", async (req, res) => {
  const query = z.object({ status: z.enum(["PENDING", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"]).optional(), search: optionalText(120) }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const { status, search } = query.data;
  const reservations = await prisma.reservation.findMany({
    where: {
      tenantId: tenantId(req),
      status,
      ...(search
        ? {
            OR: [
              { reservationNo: { contains: search, mode: "insensitive" } },
              { room: { number: { contains: search, mode: "insensitive" } } },
              { customer: { firstName: { contains: search, mode: "insensitive" } } },
              { customer: { lastName: { contains: search, mode: "insensitive" } } },
              { customer: { phone: { contains: search, mode: "insensitive" } } },
              { customer: { customerNo: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    include: reservationInclude,
    orderBy: [{ updatedAt: "desc" }],
  });
  res.json({ reservations: await withCreditOutstanding(tenantId(req), reservations) });
});

receptionRouter.get("/reservations/:id", async (req, res) => {
  const reservation = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: reservationInclude });
  if (!reservation) { res.status(404).json({ error: "Reservation not found" }); return; }
  const [withCredit] = await withCreditOutstanding(tenantId(req), [reservation]);
  res.json({ reservation: withCredit, totals: folioTotals(reservation.folio) });
});

receptionRouter.post("/reservations", async (req, res) => {
  const data = reservationSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "reservation", data.error.flatten()); return; }
  const tid = tenantId(req);
  const { status, roomSaleType, complimentaryReason, discountType, discountValue, discountReason, ...fields } = data.data;
  const terms = normalizeTerms({ roomSaleType, complimentaryReason, discountType, discountValue, discountReason });
  const [customer, room, available, actor] = await Promise.all([
    prisma.customer.findFirst({ where: { id: fields.customerId, tenantId: tid } }),
    prisma.room.findFirst({ where: { id: fields.roomId, tenantId: tid, status: "VACANT", cleanliness: "CLEAN" }, include: { roomType: true } }),
    roomIsAvailable({ tenantId: tid, ...fields }),
    resolveActor(tid, req),
  ]);
  if (!customer || !room) { res.status(400).json({ error: "Choose a clean, vacant room and a customer from this property" }); return; }
  if (!available) { res.status(409).json({ error: "This room is already booked for those dates" }); return; }

  const reservation = await prisma.$transaction(async (tx) => {
    const reservationNo = await nextReservationNo(tid);
    const created = await tx.reservation.create({
      data: { tenantId: tid, reservationNo, status, createdBy: req.userId, locationId: actor.locationId, ...fields, ...terms },
    });
    const folioNo = await nextFolioNo(tid);
    await tx.folio.create({ data: { tenantId: tid, folioNo, reservationId: created.id } });
    await logActivity(tx, tid, created.id, "CREATED", "Reservation created", actor);
    if (status === "CHECKED_IN") {
      await tx.room.update({ where: { id: room.id }, data: { status: "OCCUPIED" } });
      const amount = await roomRateFor(tx, room.roomTypeId, fields.mealPlan, room.nightlyRate);
      await tx.folioLineItem.create({
        data: {
          tenantId: tid,
          folioId: (await tx.folio.findUniqueOrThrow({ where: { reservationId: created.id }, select: { id: true } })).id,
          source: "ROOM",
          label: `Room ${room.number} — ${room.roomType.name} · ${MEAL_PLAN_LABELS[fields.mealPlan]}`,
          amount,
          quantity: nights(fields.checkIn, fields.checkOut),
          createdBy: req.userId,
        },
      });
      await syncRoomAdjustment(tx, tid, created.id, req.userId);
      await logActivity(tx, tid, created.id, "CHECKED_IN", "Checked in", actor);
    }
    return tx.reservation.findUniqueOrThrow({ where: { id: created.id }, include: reservationInclude });
  });
  res.status(201).json({ reservation });
});

receptionRouter.patch("/reservations/:id", async (req, res) => {
  const data = reservationUpdateSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "reservation", data.error.flatten()); return; }
  const tid = tenantId(req);
  const current = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Reservation not found" }); return; }
  if (!["PENDING", "CONFIRMED"].includes(current.status)) {
    res.status(409).json({ error: "This reservation can no longer be edited — it has already checked in, checked out, or been cancelled" });
    return;
  }
  const next = { ...current, ...data.data };
  if (next.checkOut <= next.checkIn) { res.status(400).json({ error: "Check-out must be after check-in" }); return; }
  if (!(await roomIsAvailable({ tenantId: tid, roomId: next.roomId, checkIn: next.checkIn, checkOut: next.checkOut, excludeId: current.id }))) {
    res.status(409).json({ error: "This room is already booked for those dates" });
    return;
  }
  const actor = await resolveActor(tid, req);
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.reservation.update({ where: { id: current.id }, data: { ...data.data, updatedBy: req.userId } });
    await logActivity(tx, tid, current.id, "UPDATED", "Reservation details updated", actor);
    return tx.reservation.findUniqueOrThrow({ where: { id: current.id }, include: reservationInclude });
  });
  res.json({ reservation });
});

receptionRouter.patch("/reservations/:id/check-in", async (req, res) => {
  const data = checkInSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "check-in", data.error.flatten()); return; }
  const tid = tenantId(req);
  const current = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { customer: true, room: { include: { roomType: true } }, folio: true } });
  if (!current) { res.status(404).json({ error: "Reservation not found" }); return; }
  if (!["PENDING", "CONFIRMED"].includes(current.status)) { res.status(409).json({ error: "Only a pending or confirmed reservation can be checked in" }); return; }
  const mealPlan = data.data.mealPlan ?? current.mealPlan;
  const actor = await resolveActor(tid, req);
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.reservation.update({ where: { id: current.id }, data: { status: "CHECKED_IN", mealPlan, updatedBy: req.userId } });
    await tx.room.update({ where: { id: current.roomId }, data: { status: "OCCUPIED" } });
    if (current.folio) {
      const amount = await roomRateFor(tx, current.room.roomTypeId, mealPlan, current.room.nightlyRate);
      await tx.folioLineItem.create({
        data: {
          tenantId: tid,
          folioId: current.folio.id,
          source: "ROOM",
          label: `Room ${current.room.number} — ${current.room.roomType.name} · ${MEAL_PLAN_LABELS[mealPlan]}`,
          amount,
          quantity: nights(current.checkIn, current.checkOut),
          createdBy: req.userId,
        },
      });
      await syncRoomAdjustment(tx, tid, current.id, req.userId);
    }
    await logActivity(tx, tid, current.id, "CHECKED_IN", "Checked in", actor);
    return tx.reservation.findUniqueOrThrow({ where: { id: current.id }, include: reservationInclude });
  });
  res.json({ reservation });
});

receptionRouter.patch("/reservations/:id/cancel", async (req, res) => {
  const data = cancelSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "cancellation", data.error.flatten()); return; }
  const tid = tenantId(req);
  const current = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Reservation not found" }); return; }
  if (!["PENDING", "CONFIRMED"].includes(current.status)) { res.status(409).json({ error: "Only a pending or confirmed reservation can be cancelled — a checked-in guest must check out instead" }); return; }
  const actor = await resolveActor(tid, req);
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.reservation.update({
      where: { id: current.id },
      data: { status: "CANCELLED", cancellationReason: data.data.cancellationReason, cancellationNotes: data.data.cancellationNotes, updatedBy: req.userId },
    });
    await logActivity(tx, tid, current.id, "CANCELLED", `Cancelled (${data.data.cancellationReason.replace(/_/g, " ").toLowerCase()})`, actor);
    return tx.reservation.findUniqueOrThrow({ where: { id: current.id }, include: reservationInclude });
  });
  res.json({ reservation });
});

receptionRouter.patch("/reservations/:id/no-show", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Reservation not found" }); return; }
  if (!["PENDING", "CONFIRMED"].includes(current.status)) { res.status(409).json({ error: "Only a pending or confirmed reservation can be marked as a no-show" }); return; }
  const actor = await resolveActor(tid, req);
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.reservation.update({ where: { id: current.id }, data: { status: "NO_SHOW", updatedBy: req.userId } });
    await logActivity(tx, tid, current.id, "NO_SHOW", "Marked as no-show", actor);
    return tx.reservation.findUniqueOrThrow({ where: { id: current.id }, include: reservationInclude });
  });
  res.json({ reservation });
});

receptionRouter.patch("/reservations/:id/extend", async (req, res) => {
  const data = extendSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "extension", data.error.flatten()); return; }
  const tid = tenantId(req);
  const current = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { room: { include: { roomType: true } }, folio: true } });
  if (!current) { res.status(404).json({ error: "Reservation not found" }); return; }
  if (current.status !== "CHECKED_IN") { res.status(409).json({ error: "Only a checked-in stay can be extended" }); return; }
  if (data.data.checkOut <= current.checkOut) { res.status(400).json({ error: "New check-out must be later than the current one" }); return; }
  if (!(await roomIsAvailable({ tenantId: tid, roomId: current.roomId, checkIn: current.checkOut, checkOut: data.data.checkOut, excludeId: current.id }))) {
    res.status(409).json({ error: "This room is already booked for those extra nights" });
    return;
  }
  const extraNights = nights(current.checkOut, data.data.checkOut);
  const actor = await resolveActor(tid, req);
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.reservation.update({ where: { id: current.id }, data: { checkOut: data.data.checkOut, updatedBy: req.userId } });
    if (current.folio) {
      const amount = await roomRateFor(tx, current.room.roomTypeId, current.mealPlan, current.room.nightlyRate);
      await tx.folioLineItem.create({ data: { tenantId: tid, folioId: current.folio.id, source: "ROOM", label: `Extended stay (${extraNights} extra night${extraNights === 1 ? "" : "s"} · ${MEAL_PLAN_LABELS[current.mealPlan]})`, amount, quantity: extraNights, createdBy: req.userId } });
      await syncRoomAdjustment(tx, tid, current.id, req.userId);
    }
    await logActivity(tx, tid, current.id, "EXTENDED", `Extended by ${extraNights} night${extraNights === 1 ? "" : "s"}`, actor);
    return tx.reservation.findUniqueOrThrow({ where: { id: current.id }, include: reservationInclude });
  });
  res.json({ reservation });
});

receptionRouter.patch("/reservations/:id/checkout", async (req, res) => {
  const data = paymentSchema.partial({ paymentMethodId: true, amount: true }).extend({ amount: z.coerce.number().min(0), ...creditFields }).safeParse(req.body);
  if (!data.success) { invalid(res, "checkout payment", data.error.flatten()); return; }
  const tid = tenantId(req);
  const current = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { customer: true, folio: { include: { lineItems: true, payments: true } } } });
  if (!current) { res.status(404).json({ error: "Reservation not found" }); return; }
  if (current.status !== "CHECKED_IN") { res.status(409).json({ error: "Only a checked-in stay can be checked out" }); return; }
  if (!current.folio) { res.status(500).json({ error: "This reservation has no folio on record" }); return; }
  if (data.data.amount > 0 && !data.data.paymentMethodId) { res.status(400).json({ error: "Choose a payment method" }); return; }
  if (data.data.paymentMethodId) await resolvePaymentMethod(tid, data.data.paymentMethodId, data.data.reference);
  // A balance can't just vanish at checkout: it's either paid, or the stay is
  // completed on credit with a reason and an expected payment date (same rule
  // as a POS order). The unpaid part then sits on the customer's balance.
  const balanceBefore = folioTotals(current.folio).balance;
  if (data.data.amount > balanceBefore + 0.01) { res.status(400).json({ error: `Amount exceeds the balance due of ${round2(balanceBefore).toFixed(2)}` }); return; }
  const onCredit = round2(balanceBefore - data.data.amount);
  if (onCredit > 0.01 && ((data.data.creditReason ?? "").length < 3 || !data.data.creditExpectedAt)) {
    res.status(409).json({ error: `A balance of ${onCredit.toFixed(2)} remains — pay it, or complete on credit with a reason and an expected payment date`, code: "BALANCE_DUE", balance: onCredit });
    return;
  }
  const transactionNo = data.data.amount > 0 ? await nextTransactionNo(tid) : null;
  const actor = await resolveActor(tid, req);
  const reservation = await prisma.$transaction(async (tx) => {
    if (data.data.amount > 0) {
      const created = await tx.folioPayment.create({ data: { tenantId: tid, folioId: current.folio!.id, kind: "SETTLEMENT", paymentMethodId: data.data.paymentMethodId!, amount: data.data.amount, reference: data.data.reference, createdBy: req.userId } });
      await tx.transaction.create({
        data: {
          tenantId: tid,
          transactionNo: transactionNo!,
          direction: "IN",
          source: "FOLIO_SETTLEMENT",
          amount: data.data.amount,
          paymentMethodId: data.data.paymentMethodId!,
          reference: data.data.reference,
          customerId: current.customerId,
          employeeId: req.userId,
          description: `Checkout settlement — ${current.reservationNo}`,
          sourceRefId: created.id,
        },
      });
    }
    await tx.folio.update({
      where: { id: current.folio!.id },
      data: onCredit > 0.01
        ? { status: "SETTLED", creditAmount: onCredit, creditReason: data.data.creditReason, creditExpectedAt: data.data.creditExpectedAt }
        : { status: "SETTLED" },
    });
    if (onCredit > 0.01) {
      await applyCustomerBalance(tx, { tenantId: tid, customerId: current.customerId, folioId: current.folio!.id, delta: onCredit, type: "CREDIT", note: `Stay ${current.reservationNo} checked out on credit`, by: req.userId });
    }
    await tx.reservation.update({ where: { id: current.id }, data: { status: "CHECKED_OUT", updatedBy: req.userId } });
    await freeRoom(tx, tid, current.roomId, `${current.customer.firstName} ${current.customer.lastName}`, "checked out");
    await logActivity(tx, tid, current.id, "CHECKED_OUT", onCredit > 0.01 ? `Checked out on credit (${onCredit.toFixed(2)} owing)` : "Checked out", actor);
    return tx.reservation.findUniqueOrThrow({ where: { id: current.id }, include: reservationInclude });
  });
  res.json({ reservation, totals: folioTotals(reservation.folio) });
});

receptionRouter.post("/reservations/:id/guests", async (req, res) => {
  const data = guestSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "guest", data.error.flatten()); return; }
  const tid = tenantId(req);
  const reservation = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
  if (!reservation) { res.status(404).json({ error: "Reservation not found" }); return; }
  const actor = await resolveActor(tid, req);
  const guest = await prisma.$transaction(async (tx) => {
    const created = await tx.reservationGuest.create({ data: { tenantId: tid, reservationId: reservation.id, addedBy: req.userId, ...data.data } });
    await logActivity(tx, tid, reservation.id, "GUEST_ADDED", `Added guest ${data.data.name}`, actor);
    return created;
  });
  res.status(201).json({ guest });
});

receptionRouter.delete("/reservations/:id/guests/:guestId", async (req, res) => {
  const tid = tenantId(req);
  const guest = await prisma.reservationGuest.findFirst({ where: { id: req.params.guestId, reservationId: req.params.id, tenantId: tid } });
  if (!guest) { res.status(404).json({ error: "Guest not found" }); return; }
  const actor = await resolveActor(tid, req);
  await prisma.$transaction(async (tx) => {
    await tx.reservationGuest.delete({ where: { id: guest.id } });
    await logActivity(tx, tid, req.params.id, "GUEST_REMOVED", `Removed guest ${guest.name}`, actor);
  });
  res.status(204).send();
});

receptionRouter.post("/reservations/:id/folio/charges", async (req, res) => {
  const data = chargeSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "charge", data.error.flatten()); return; }
  const tid = tenantId(req);
  const reservation = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { folio: true } });
  if (!reservation || !reservation.folio) { res.status(404).json({ error: "Reservation not found" }); return; }

  let label = data.data.label;
  let amount = data.data.amount;
  if (data.data.source === "SERVICE") {
    const service = await prisma.service.findFirst({ where: { id: data.data.sourceRefId, tenantId: tid, isActive: true } });
    if (!service) { res.status(400).json({ error: "Choose a valid, active service" }); return; }
    label = service.name;
    amount = Number(service.price);
  }
  const actor = await resolveActor(tid, req);
  const lineItem = await prisma.$transaction(async (tx) => {
    const created = await tx.folioLineItem.create({
      data: {
        tenantId: tid,
        folioId: reservation.folio!.id,
        source: data.data.source,
        label: label!,
        amount: amount!,
        quantity: data.data.quantity,
        sourceRefId: data.data.sourceRefId,
        createdBy: req.userId,
      },
    });
    await logActivity(tx, tid, reservation.id, "CHARGE_ADDED", `Charge added — ${label}`, actor);
    return created;
  });
  res.status(201).json({ lineItem });
});

receptionRouter.delete("/reservations/:id/folio/charges/:lineItemId", async (req, res) => {
  const tid = tenantId(req);
  const reservation = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { folio: true } });
  if (!reservation || !reservation.folio) { res.status(404).json({ error: "Reservation not found" }); return; }
  const lineItem = await prisma.folioLineItem.findFirst({ where: { id: req.params.lineItemId, folioId: reservation.folio.id } });
  if (!lineItem) { res.status(404).json({ error: "Charge not found" }); return; }
  if (lineItem.source === "ROOM" || lineItem.source === "DISCOUNT") { res.status(409).json({ error: "Room charges and discounts are managed from the room terms, not removed as a charge" }); return; }
  const actor = await resolveActor(tid, req);
  await prisma.$transaction(async (tx) => {
    await tx.folioLineItem.delete({ where: { id: lineItem.id } });
    await logActivity(tx, tid, reservation.id, "CHARGE_REMOVED", `Charge removed — ${lineItem.label}`, actor);
  });
  res.status(204).send();
});

receptionRouter.post("/reservations/:id/folio/deposits", async (req, res) => {
  const data = paymentSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "deposit", data.error.flatten()); return; }
  const tid = tenantId(req);
  const reservation = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { folio: true } });
  if (!reservation || !reservation.folio) { res.status(404).json({ error: "Reservation not found" }); return; }
  await resolvePaymentMethod(tid, data.data.paymentMethodId, data.data.reference);
  const transactionNo = await nextTransactionNo(tid);
  const actor = await resolveActor(tid, req);
  const payment = await prisma.$transaction(async (tx) => {
    const created = await tx.folioPayment.create({
      data: { tenantId: tid, folioId: reservation.folio!.id, kind: "DEPOSIT", ...data.data, createdBy: req.userId },
      include: { paymentMethod: { select: { id: true, name: true, requiresReference: true } } },
    });
    await tx.transaction.create({
      data: {
        tenantId: tid,
        transactionNo,
        direction: "IN",
        source: "FOLIO_DEPOSIT",
        amount: data.data.amount,
        paymentMethodId: data.data.paymentMethodId,
        reference: data.data.reference,
        customerId: reservation.customerId,
        employeeId: req.userId,
        description: `Deposit — ${reservation.reservationNo}`,
        sourceRefId: created.id,
      },
    });
    await logActivity(tx, tid, reservation.id, "DEPOSIT_RECORDED", `Deposit recorded — ${data.data.amount}`, actor);
    return created;
  });
  res.status(201).json({ payment });
});

receptionRouter.get("/reservations/:id/folio", async (req, res) => {
  const tid = tenantId(req);
  const reservation = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tid }, include: reservationInclude });
  if (!reservation || !reservation.folio) { res.status(404).json({ error: "Reservation not found" }); return; }
  res.json({ folio: reservation.folio, totals: folioTotals(reservation.folio) });
});

/** Change how a room is sold — paid (with or without a discount) or
 * complimentary — before or during the stay. Re-prices the folio's write-off
 * line; the room charges themselves never change. */
receptionRouter.patch("/reservations/:id/room-terms", async (req, res) => {
  const data = roomTermsSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "room terms", data.error.flatten()); return; }
  const tid = tenantId(req);
  const current = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Reservation not found" }); return; }
  if (!["PENDING", "CONFIRMED", "CHECKED_IN"].includes(current.status)) { res.status(409).json({ error: "Room terms can only be changed before checkout" }); return; }
  const terms = normalizeTerms(data.data);
  const actor = await resolveActor(tid, req);
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.reservation.update({ where: { id: current.id }, data: { ...terms, updatedBy: req.userId } });
    if (current.status === "CHECKED_IN") await syncRoomAdjustment(tx, tid, current.id, req.userId);
    const summary = terms.roomSaleType === "COMPLIMENTARY" ? "Room marked complimentary" : terms.discountType ? "Room discount applied" : "Room set to paid, no discount";
    await logActivity(tx, tid, current.id, "ROOM_TERMS_CHANGED", summary, actor);
    return tx.reservation.findUniqueOrThrow({ where: { id: current.id }, include: reservationInclude });
  });
  res.json({ reservation, totals: folioTotals(reservation.folio) });
});

/** Receive payment against credit left when a stay was checked out on credit.
 * Records the payment on the (already settled) folio and the money in the
 * ledger, and brings the customer's balance down. */
receptionRouter.post("/reservations/:id/folio/credit-payments", async (req, res) => {
  const data = paymentSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "payment", data.error.flatten()); return; }
  const tid = tenantId(req);
  const reservation = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { folio: true } });
  if (!reservation || !reservation.folio) { res.status(404).json({ error: "Reservation not found" }); return; }
  const outstanding = (await folioCreditOutstanding(prisma, tid, [reservation.folio.id])).get(reservation.folio.id) ?? 0;
  if (outstanding <= 0.01) { res.status(409).json({ error: "This stay has no credit left to pay" }); return; }
  if (data.data.amount > outstanding + 0.01) { res.status(400).json({ error: `Amount exceeds the credit owing of ${outstanding.toFixed(2)}` }); return; }
  await resolvePaymentMethod(tid, data.data.paymentMethodId, data.data.reference);
  const transactionNo = await nextTransactionNo(tid);
  const actor = await resolveActor(tid, req);
  const payment = await prisma.$transaction(async (tx) => {
    const created = await tx.folioPayment.create({
      data: { tenantId: tid, folioId: reservation.folio!.id, kind: "SETTLEMENT", ...data.data, createdBy: req.userId },
      include: { paymentMethod: { select: { id: true, name: true, requiresReference: true } } },
    });
    await tx.transaction.create({
      data: {
        tenantId: tid,
        transactionNo,
        direction: "IN",
        source: "FOLIO_SETTLEMENT",
        amount: data.data.amount,
        paymentMethodId: data.data.paymentMethodId,
        reference: data.data.reference,
        customerId: reservation.customerId,
        employeeId: req.userId,
        description: `Credit payment — ${reservation.reservationNo}`,
        sourceRefId: created.id,
      },
    });
    await applyCustomerBalance(tx, { tenantId: tid, customerId: reservation.customerId, folioId: reservation.folio!.id, delta: -data.data.amount, type: "REPAYMENT", note: `Payment against stay ${reservation.reservationNo}`, by: req.userId });
    await logActivity(tx, tid, reservation.id, "CREDIT_PAYMENT", `Credit payment received — ${data.data.amount}`, actor);
    return created;
  });
  res.status(201).json({ payment });
});
