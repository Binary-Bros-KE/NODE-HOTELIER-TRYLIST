import { Router } from "express";
import { z } from "zod";
import type { Prisma, ReservationActivityAction } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { nextCustomerNo, nextReservationNo, nextFolioNo, nextTransactionNo, nextGroupNo } from "../../lib/sequence.js";
import { resolveActorLocationWithHint } from "../../lib/location.js";
import { resolveRoomCharge, type RoomCharge, type TaxFallback } from "../../lib/roomCharge.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { applyCustomerBalance, folioCreditOutstanding } from "../../lib/customerCredit.js";
import { createRoomTask } from "../../lib/housekeeping.js";
import { computeOrderFinancials } from "../../lib/orderTotals.js";

export const receptionRouter = Router();
receptionRouter.use(requireModule("RESERVATIONS"));

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const RESERVATION_SOURCES = ["WALK_IN", "PHONE", "WEBSITE", "BOOKING_ENGINE", "TRAVEL_AGENT", "OTA", "CORPORATE", "OTHER"] as const;
const CANCELLATION_REASONS = ["CHANGED_MIND", "NO_SHOW", "FOUND_ALTERNATIVE", "DUPLICATE_BOOKING", "HOTEL_CANCELLED", "OTHER"] as const;
const OPEN_RESERVATION_STATUSES = ["PENDING", "CONFIRMED", "CHECKED_IN"] as const;
const MEAL_PLANS = ["ROOM_ONLY", "BED_AND_BREAKFAST", "HALF_BOARD", "FULL_BOARD"] as const;

const CUSTOMER_TYPES = ["PERSONAL", "BUSINESS"] as const;
// Personal fields apply to any guest; the business fields only matter when
// customerType is BUSINESS, but are accepted either way (same as the full
// Customers screen) so a personal guest can still carry a company on file.
const customerSchema = z.object({
  customerType: z.enum(CUSTOMER_TYPES).default("PERSONAL"),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1).optional(),
  email: z.email().optional(),
  phone: z.string().trim().min(5).max(30),
  idNumber: optionalText(40),
  businessName: optionalText(160),
  registrationNumber: optionalText(80),
  kraPin: optionalText(40),
  contactPerson: optionalText(120),
  billingPhone: optionalText(30),
  billingEmail: z.preprocess(blankToUndefined, z.email().optional()),
});

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
  // Required (server-checked) when the room type is sold by rate variant.
  rateId: z.string().trim().min(1).optional(),
  // The rate's auto-calculated quantity (elapsed hours/days, or headcount)
  // is only ever a starting suggestion — this replaces it outright when set,
  // e.g. rounding a 4.3-hour stay to 4 or 5, or a headcount rate to the
  // actual number of attendees rather than just "adults".
  quantityOverride: z.coerce.number().positive().optional(),
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
const checkInSchema = z.object({ mealPlan: z.enum(MEAL_PLANS).optional(), rateId: z.string().trim().min(1).optional(), quantityOverride: z.coerce.number().positive().optional() }).default({});
const extendSchema = z.object({ checkOut: z.coerce.date(), quantityOverride: z.coerce.number().positive().optional() });
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

/** The tenant's tax defaults, for resolving a room/service's own null tax
 * fields at charge time (same convention as POS's taxSettingsFor). */
async function taxDefaults(tid: string): Promise<TaxFallback> {
  const profile = await prisma.businessProfile.findUnique({ where: { tenantId: tid }, select: { taxRate: true, taxMode: true, taxTreatment: true } });
  return profile ?? null;
}
function invalid(res: { status: (code: number) => { json: (value: unknown) => unknown } }, label: string, details: unknown) { return res.status(400).json({ error: `Invalid ${label}`, details }); }

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
  const roomLines = reservation.folio.lineItems.filter((l) => l.source === "ROOM");
  const roomTotal = round2(roomLines.reduce((sum, l) => sum + Number(l.amount) * Number(l.quantity), 0));
  if (roomTotal <= 0) return;
  // The write-off is netted at the same tax settings as the room charges it
  // offsets (they're all the same room/type in the near-universal case), so
  // folioTotals' per-line tax math cancels the discounted share correctly
  // instead of treating it as its own separately-taxed line.
  const roomTax = roomLines[0];
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
  await tx.folioLineItem.create({
    data: {
      tenantId: tid, folioId: reservation.folio.id, source: "DISCOUNT", label, amount: -off, quantity: 1, sourceRefId: ref, createdBy: by,
      taxRate: roomTax.taxRate, taxMode: roomTax.taxMode, taxTreatment: roomTax.taxTreatment,
    },
  });
}

/** Adds each settled stay's outstanding credit to its folio, for display. */
async function withCreditOutstanding<T extends { folio: { id: string; creditAmount: unknown } | null }>(tid: string, reservations: T[]) {
  const ids = reservations.flatMap((r) => (r.folio && Number(r.folio.creditAmount) > 0 ? [r.folio.id] : []));
  const outstanding = await folioCreditOutstanding(prisma, tid, ids);
  return reservations.map((r) => (r.folio ? { ...r, folio: { ...r.folio, creditOutstanding: outstanding.get(r.folio.id) ?? 0 } } : r));
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
  group: { select: { id: true, name: true, groupNo: true } },
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

type FolioLineForTax = { amount: unknown; quantity: unknown; taxRate?: unknown; taxMode?: string | null; taxTreatment?: string | null };

// Reuses the POS money engine: each folio line is its own "item" (ROOM,
// SERVICE, AD_HOC positive; DISCOUNT negative), carrying its own resolved tax
// snapshot, with the order-level discount left at 0 since folios already
// model a discount as its own explicit line rather than an order-wide field.
// `charges` (== fin.total) matches the old flat sum exactly for INCLUSIVE-tax
// lines (the schema default) and only grows for EXCLUSIVE-tax lines, which is
// the point: an exclusive-VAT room rate must add tax on top at the till.
function folioTotals(folio: { lineItems: FolioLineForTax[]; payments: { amount: unknown }[] } | null, fallbackTax?: TaxFallback) {
  if (!folio) return { charges: 0, paid: 0, balance: 0, tax: null };
  const fin = computeOrderFinancials(
    {
      discount: 0,
      items: folio.lineItems.map((item) => ({
        quantity: Number(item.quantity),
        unitPrice: Number(item.amount),
        addons: [],
        taxRate: item.taxRate as never,
        taxMode: (item.taxMode ?? null) as never,
        taxTreatment: (item.taxTreatment ?? null) as never,
      })),
    },
    (fallbackTax as never) ?? null,
  );
  const paid = folio.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const charges = fin.total;
  return { charges, paid, balance: round2(charges - paid), tax: fin };
}

// Checkout frees the room and opens an unassigned turnover task for the housekeeping supervisor.
async function freeRoom(tx: Prisma.TransactionClient, tenantId: string, roomId: string, customerName: string, reason: string, reservationId: string, actor?: { id: string; name: string } | null) {
  await tx.room.update({ where: { id: roomId }, data: { status: "VACANT" } });
  await createRoomTask(tx, { tenantId, roomId, source: "CHECKOUT", reservationId, notes: `Turnover after ${customerName} ${reason}`, actor });
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
  res.json({ reservation: withCredit, totals: folioTotals(reservation.folio, await taxDefaults(tenantId(req))) });
});

receptionRouter.post("/reservations", async (req, res) => {
  const data = reservationSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "reservation", data.error.flatten()); return; }
  const tid = tenantId(req);
  const { status, roomSaleType, complimentaryReason, discountType, discountValue, discountReason, quantityOverride, ...fields } = data.data;
  const terms = normalizeTerms({ roomSaleType, complimentaryReason, discountType, discountValue, discountReason });
  const [customer, room, available, actor] = await Promise.all([
    prisma.customer.findFirst({ where: { id: fields.customerId, tenantId: tid } }),
    prisma.room.findFirst({ where: { id: fields.roomId, tenantId: tid, status: "VACANT", cleanliness: "CLEAN" }, include: { roomType: true } }),
    roomIsAvailable({ tenantId: tid, ...fields }),
    resolveActor(tid, req),
  ]);
  if (!customer || !room) { res.status(400).json({ error: "Choose a clean, vacant room and a customer from this property" }); return; }
  if (!available) { res.status(409).json({ error: "This room is already booked for those dates" }); return; }

  const charge = await resolveRoomCharge(prisma, room, { rateId: fields.rateId, headcount: fields.adults + fields.children, quantityOverride }, fields.checkIn, fields.checkOut, await taxDefaults(tid));
  const reservation = await prisma.$transaction(async (tx) => {
    const reservationNo = await nextReservationNo(tid);
    const created = await tx.reservation.create({
      data: { tenantId: tid, reservationNo, status, createdBy: req.userId, locationId: actor.locationId, ...fields, rateId: charge.rateId, rateName: charge.rateName, ...terms },
    });
    const folioNo = await nextFolioNo(tid);
    await tx.folio.create({ data: { tenantId: tid, folioNo, reservationId: created.id } });
    await logActivity(tx, tid, created.id, "CREATED", "Reservation created", actor);
    if (status === "CHECKED_IN") {
      await tx.room.update({ where: { id: room.id }, data: { status: "OCCUPIED" } });
      await tx.folioLineItem.create({
        data: {
          tenantId: tid,
          folioId: (await tx.folio.findUniqueOrThrow({ where: { reservationId: created.id }, select: { id: true } })).id,
          source: "ROOM",
          label: charge.label,
          amount: charge.amount,
          quantity: charge.quantity,
          taxRate: charge.taxRate,
          taxMode: charge.taxMode,
          taxTreatment: charge.taxTreatment,
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
  const rateId = data.data.rateId ?? current.rateId;
  const charge = await resolveRoomCharge(prisma, current.room, { rateId, mealPlan: rateId ? undefined : mealPlan, headcount: current.adults + current.children, quantityOverride: data.data.quantityOverride }, current.checkIn, current.checkOut, await taxDefaults(tid));
  const actor = await resolveActor(tid, req);
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.reservation.update({ where: { id: current.id }, data: { status: "CHECKED_IN", mealPlan, rateId: charge.rateId, rateName: charge.rateName, updatedBy: req.userId } });
    await tx.room.update({ where: { id: current.roomId }, data: { status: "OCCUPIED" } });
    if (current.folio) {
      await tx.folioLineItem.create({
        data: {
          tenantId: tid,
          folioId: current.folio.id,
          source: "ROOM",
          label: charge.label,
          amount: charge.amount,
          quantity: charge.quantity,
          taxRate: charge.taxRate,
          taxMode: charge.taxMode,
          taxTreatment: charge.taxTreatment,
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
  const charge = await resolveRoomCharge(prisma, current.room, { rateId: current.rateId, mealPlan: current.rateId ? undefined : current.mealPlan, quantityOverride: data.data.quantityOverride }, current.checkOut, data.data.checkOut, await taxDefaults(tid));
  const extraNights = charge.quantity;
  const unitWord = (charge.unitName ?? "night").toLowerCase().replace(/^per\s+/, "");
  const actor = await resolveActor(tid, req);
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.reservation.update({ where: { id: current.id }, data: { checkOut: data.data.checkOut, updatedBy: req.userId } });
    if (current.folio) {
      await tx.folioLineItem.create({ data: { tenantId: tid, folioId: current.folio.id, source: "ROOM", label: `Extended stay (${extraNights} extra ${unitWord}${extraNights === 1 ? "" : "s"}${charge.rateName ? ` · ${charge.rateName}` : ""})`, amount: charge.amount, quantity: extraNights, taxRate: charge.taxRate, taxMode: charge.taxMode, taxTreatment: charge.taxTreatment, createdBy: req.userId } });
      await syncRoomAdjustment(tx, tid, current.id, req.userId);
    }
    await logActivity(tx, tid, current.id, "EXTENDED", `Extended by ${extraNights} ${unitWord}${extraNights === 1 ? "" : "s"}`, actor);
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
  const tax = await taxDefaults(tid);
  // A balance can't just vanish at checkout: it's either paid, or the stay is
  // completed on credit with a reason and an expected payment date (same rule
  // as a POS order). The unpaid part then sits on the customer's balance.
  const balanceBefore = folioTotals(current.folio, tax).balance;
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
    await freeRoom(tx, tid, current.roomId, `${current.customer.firstName} ${current.customer.lastName}`, "checked out", current.id);
    await logActivity(tx, tid, current.id, "CHECKED_OUT", onCredit > 0.01 ? `Checked out on credit (${onCredit.toFixed(2)} owing)` : "Checked out", actor);
    return tx.reservation.findUniqueOrThrow({ where: { id: current.id }, include: reservationInclude });
  });
  res.json({ reservation, totals: folioTotals(reservation.folio, tax) });
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
  const tax = await taxDefaults(tid);
  let lineTax = { taxRate: tax?.taxRate != null ? Number(tax.taxRate) : null, taxMode: tax?.taxMode ?? null, taxTreatment: tax?.taxTreatment ?? null };
  if (data.data.source === "SERVICE") {
    const service = await prisma.service.findFirst({ where: { id: data.data.sourceRefId, tenantId: tid, isActive: true } });
    if (!service) { res.status(400).json({ error: "Choose a valid, active service" }); return; }
    label = service.name;
    amount = Number(service.price);
    lineTax = {
      taxRate: service.taxRate != null ? Number(service.taxRate) : lineTax.taxRate,
      taxMode: service.taxMode ?? lineTax.taxMode,
      taxTreatment: service.taxTreatment ?? lineTax.taxTreatment,
    };
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
        taxRate: lineTax.taxRate,
        taxMode: lineTax.taxMode,
        taxTreatment: lineTax.taxTreatment,
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
  res.json({ folio: reservation.folio, totals: folioTotals(reservation.folio, await taxDefaults(tid)) });
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
  res.json({ reservation, totals: folioTotals(reservation.folio, await taxDefaults(tid)) });
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
  // The credit sits on whoever it was charged to — for a stay in a group, the
  // group's billing customer, not the guest in the room.
  const creditOwner = (await prisma.customerCreditEntry.findFirst({ where: { tenantId: tid, folioId: reservation.folio.id, type: "CREDIT" }, select: { customerId: true } }))?.customerId ?? reservation.customerId;
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
        customerId: creditOwner,
        employeeId: req.userId,
        description: `Credit payment — ${reservation.reservationNo}`,
        sourceRefId: created.id,
      },
    });
    await applyCustomerBalance(tx, { tenantId: tid, customerId: creditOwner, folioId: reservation.folio!.id, delta: -data.data.amount, type: "REPAYMENT", note: `Payment against stay ${reservation.reservationNo}`, by: req.userId });
    await logActivity(tx, tid, reservation.id, "CREDIT_PAYMENT", `Credit payment received — ${data.data.amount}`, actor);
    return created;
  });
  res.status(201).json({ payment });
});

// ============================================================================
// Groups — a party booked together (a company sending staff, a wedding, a
// tour). Each room is still its own reservation with its own folio, guests
// and terms, so any mix works: one person per room, several to a room, or a
// shared room. The group adds one billing customer and a single checkout /
// payment for all of its rooms.
// ============================================================================

const groupRoomSchema = z.object({
  roomId: z.string().cuid(),
  // Who the room is registered to; defaults to the group's billing customer.
  customerId: z.string().cuid().optional(),
  mealPlan: z.enum(MEAL_PLANS).default("ROOM_ONLY"),
  rateId: z.string().trim().min(1).optional(),
  quantityOverride: z.coerce.number().positive().optional(),
  adults: z.coerce.number().int().min(1).default(1),
  children: z.coerce.number().int().min(0).default(0),
  // Everyone sleeping in the room, by name.
  guests: z.array(z.object({ name: z.string().trim().min(1).max(120), idNumber: optionalText(40) })).max(30).default([]),
  notes: optionalText(500),
  // A room can arrive/leave on different dates from the rest of the party.
  checkIn: z.coerce.date().optional(),
  checkOut: z.coerce.date().optional(),
  // Its own terms; otherwise the group's defaults apply.
  terms: roomTermsSchema.optional(),
});
const groupBookingFields = {
  checkIn: z.coerce.date(),
  checkOut: z.coerce.date(),
  source: z.enum(RESERVATION_SOURCES).default("CORPORATE"),
  status: z.enum(["PENDING", "CONFIRMED", "CHECKED_IN"]).default("PENDING"),
  terms: roomTermsSchema.optional(),
  rooms: z.array(groupRoomSchema).min(1).max(200),
};
const groupCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  customerId: z.string().cuid(),
  notes: optionalText(500),
  ...groupBookingFields,
});
const groupAddRoomsSchema = z.object(groupBookingFields);
const groupPatchSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), notes: optionalText(500), customerId: z.string().cuid().optional() });
const groupPaymentsSchema = z.object({ payments: z.array(paymentSchema).max(10).default([]) });
const groupCheckoutSchema = groupPaymentsSchema.extend({ reservationIds: z.array(z.string().cuid()).optional(), ...creditFields });
const groupCheckInSchema = z.object({ reservationIds: z.array(z.string().cuid()).optional() });

const GROUP_TX = { timeout: 120_000, maxWait: 15_000 } as const;

type GroupRoomInput = z.infer<typeof groupRoomSchema>;

/** Checks every requested room is bookable for its dates before anything is
 * written, so a 40-room party either goes in whole or not at all. */
async function prepareGroupRooms(tid: string, defaults: { checkIn: Date; checkOut: Date; terms?: z.infer<typeof roomTermsSchema> }, rows: GroupRoomInput[], billingCustomerId: string) {
  const ids = rows.map((r) => r.roomId);
  if (new Set(ids).size !== ids.length) throw Object.assign(new Error("The same room is listed twice"), { status: 400 });
  const [rooms, customers] = await Promise.all([
    prisma.room.findMany({ where: { id: { in: ids }, tenantId: tid }, include: { roomType: true } }),
    prisma.customer.findMany({ where: { tenantId: tid, id: { in: [...new Set([billingCustomerId, ...rows.flatMap((r) => (r.customerId ? [r.customerId] : []))])] } }, select: { id: true } }),
  ]);
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const customerIds = new Set(customers.map((c) => c.id));
  const tax = await taxDefaults(tid);
  const prepared: { row: GroupRoomInput; room: (typeof rooms)[number]; checkIn: Date; checkOut: Date; customerId: string; charge: RoomCharge }[] = [];
  for (const row of rows) {
    const room = roomById.get(row.roomId);
    if (!room) throw Object.assign(new Error("One of the rooms is not from this property"), { status: 400 });
    if (room.status !== "VACANT" || room.cleanliness !== "CLEAN") throw Object.assign(new Error(`Room ${room.number} isn't clean and vacant`), { status: 409 });
    const checkIn = row.checkIn ?? defaults.checkIn;
    const checkOut = row.checkOut ?? defaults.checkOut;
    if (checkOut <= checkIn) throw Object.assign(new Error(`Room ${room.number}: check-out must be after check-in`), { status: 400 });
    const customerId = row.customerId ?? billingCustomerId;
    if (!customerIds.has(customerId)) throw Object.assign(new Error(`Room ${room.number}: guest not found`), { status: 400 });
    if (!(await roomIsAvailable({ tenantId: tid, roomId: room.id, checkIn, checkOut }))) throw Object.assign(new Error(`Room ${room.number} is already booked for those dates`), { status: 409 });
    const charge = await resolveRoomCharge(prisma, room, { rateId: row.rateId, headcount: row.adults + row.children, quantityOverride: row.quantityOverride }, checkIn, checkOut, tax);
    prepared.push({ row, room, checkIn, checkOut, customerId, charge });
  }
  return prepared;
}

/** Writes one group's rooms: reservation + folio (+ room charges if checking in) + guests. */
async function bookGroupRooms(
  tx: Prisma.TransactionClient,
  tid: string,
  actor: ActorContext,
  userId: string | undefined,
  group: { id: string; name: string },
  prepared: Awaited<ReturnType<typeof prepareGroupRooms>>,
  args: { status: "PENDING" | "CONFIRMED" | "CHECKED_IN"; source: (typeof RESERVATION_SOURCES)[number]; defaultTerms?: z.infer<typeof roomTermsSchema>; numbers: { reservationNo: string; folioNo: string }[] },
) {
  const baseTerms = args.defaultTerms ?? { roomSaleType: "PAID" as const, discountValue: 0 };
  for (const [index, item] of prepared.entries()) {
    const { row, room, checkIn, checkOut, customerId, charge } = item;
    const terms = normalizeTerms(row.terms ?? baseTerms);
    const created = await tx.reservation.create({
      data: {
        tenantId: tid, reservationNo: args.numbers[index].reservationNo, groupId: group.id, customerId, roomId: room.id, source: args.source,
        checkIn, checkOut, adults: row.adults, children: row.children, mealPlan: row.mealPlan, rateId: charge.rateId, rateName: charge.rateName, notes: row.notes,
        status: args.status, createdBy: userId, locationId: actor.locationId, ...terms,
      },
    });
    const folio = await tx.folio.create({ data: { tenantId: tid, folioNo: args.numbers[index].folioNo, reservationId: created.id } });
    if (row.guests.length > 0) {
      await tx.reservationGuest.createMany({ data: row.guests.map((g) => ({ tenantId: tid, reservationId: created.id, name: g.name, idNumber: g.idNumber, addedBy: userId })) });
    }
    await logActivity(tx, tid, created.id, "CREATED", `Reservation created for group ${group.name}`, actor);
    if (args.status === "CHECKED_IN") {
      await tx.room.update({ where: { id: room.id }, data: { status: "OCCUPIED" } });
      await tx.folioLineItem.create({
        data: { tenantId: tid, folioId: folio.id, source: "ROOM", label: charge.label, amount: charge.amount, quantity: charge.quantity, taxRate: charge.taxRate, taxMode: charge.taxMode, taxTreatment: charge.taxTreatment, createdBy: userId },
      });
      await syncRoomAdjustment(tx, tid, created.id, userId);
      await logActivity(tx, tid, created.id, "CHECKED_IN", "Checked in", actor);
    }
  }
}

const groupReservationInclude = {
  customer: true,
  room: { include: { roomType: true } },
  additionalGuests: { orderBy: { addedAt: "asc" as const } },
  folio: {
    include: {
      lineItems: { orderBy: { createdAt: "asc" as const } },
      payments: { include: { paymentMethod: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" as const } },
    },
  },
};

async function groupSummary(tid: string, reservations: { status: string; adults: number; children: number; additionalGuests?: unknown[]; folio: { id: string; creditAmount: unknown; lineItems: FolioLineForTax[]; payments: { amount: unknown }[] } | null }[]) {
  const live = reservations.filter((r) => r.status !== "CANCELLED" && r.status !== "NO_SHOW");
  const tax = await taxDefaults(tid);
  const totals = live.reduce((sum, r) => {
    const t = folioTotals(r.folio, tax);
    return { charges: sum.charges + t.charges, paid: sum.paid + t.paid, balance: sum.balance + t.balance };
  }, { charges: 0, paid: 0, balance: 0 });
  const outstanding = await folioCreditOutstanding(prisma, tid, live.flatMap((r) => (r.folio && Number(r.folio.creditAmount) > 0 ? [r.folio.id] : [])));
  return {
    rooms: live.length,
    pending: live.filter((r) => r.status === "PENDING" || r.status === "CONFIRMED").length,
    checkedIn: live.filter((r) => r.status === "CHECKED_IN").length,
    checkedOut: live.filter((r) => r.status === "CHECKED_OUT").length,
    guests: live.reduce((sum, r) => sum + r.adults + r.children, 0),
    charges: round2(totals.charges),
    paid: round2(totals.paid),
    balance: round2(totals.balance),
    creditOutstanding: round2([...outstanding.values()].reduce((sum, v) => sum + Math.max(0, v), 0)),
  };
}

async function groupDetail(tid: string, id: string) {
  const group = await prisma.reservationGroup.findFirst({
    where: { id, tenantId: tid },
    include: { customer: true, reservations: { include: groupReservationInclude, orderBy: { room: { number: "asc" } } } },
  });
  if (!group) return null;
  const outstanding = await folioCreditOutstanding(prisma, tid, group.reservations.flatMap((r) => (r.folio && Number(r.folio.creditAmount) > 0 ? [r.folio.id] : [])));
  return {
    ...group,
    reservations: group.reservations.map((r) => (r.folio ? { ...r, folio: { ...r.folio, creditOutstanding: outstanding.get(r.folio.id) ?? 0 } } : r)),
    summary: await groupSummary(tid, group.reservations),
  };
}

function sendStatusError(res: { status: (code: number) => { json: (value: unknown) => unknown } }, error: unknown) {
  if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return true; }
  return false;
}

receptionRouter.post("/groups", async (req, res, next) => {
  const data = groupCreateSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "group", data.error.flatten()); return; }
  if (data.data.checkOut <= data.data.checkIn) { res.status(400).json({ error: "Check-out must be after check-in" }); return; }
  const tid = tenantId(req);
  try {
    const billing = await prisma.customer.findFirst({ where: { id: data.data.customerId, tenantId: tid }, select: { id: true } });
    if (!billing) { res.status(400).json({ error: "Choose the billing customer from this property" }); return; }
    const prepared = await prepareGroupRooms(tid, data.data, data.data.rooms, billing.id);
    const actor = await resolveActor(tid, req);
    const groupNo = await nextGroupNo(tid);
    const numbers: { reservationNo: string; folioNo: string }[] = [];
    for (let i = 0; i < prepared.length; i++) numbers.push({ reservationNo: await nextReservationNo(tid), folioNo: await nextFolioNo(tid) });
    const groupId = await prisma.$transaction(async (tx) => {
      const group = await tx.reservationGroup.create({ data: { tenantId: tid, groupNo, name: data.data.name, customerId: billing.id, notes: data.data.notes, createdBy: req.userId } });
      await bookGroupRooms(tx, tid, actor, req.userId, group, prepared, { status: data.data.status, source: data.data.source, defaultTerms: data.data.terms, numbers });
      return group.id;
    }, GROUP_TX);
    res.status(201).json({ group: await groupDetail(tid, groupId) });
  } catch (error) {
    if (sendStatusError(res, error)) return;
    next(error);
  }
});

receptionRouter.get("/groups", async (req, res) => {
  const tid = tenantId(req);
  const search = optionalText(120).safeParse(req.query.search);
  const groups = await prisma.reservationGroup.findMany({
    where: {
      tenantId: tid,
      ...(search.success && search.data ? { OR: [
        { name: { contains: search.data, mode: "insensitive" } },
        { groupNo: { contains: search.data, mode: "insensitive" } },
        { customer: { firstName: { contains: search.data, mode: "insensitive" } } },
        { customer: { lastName: { contains: search.data, mode: "insensitive" } } },
      ] } : {}),
    },
    include: { customer: true, reservations: { select: { status: true, adults: true, children: true, folio: { include: { lineItems: true, payments: true } } } } },
    orderBy: { createdAt: "desc" },
  });
  res.json({ groups: await Promise.all(groups.map(async ({ reservations, ...group }) => ({ ...group, summary: await groupSummary(tid, reservations) }))) });
});

receptionRouter.get("/groups/:id", async (req, res) => {
  const group = await groupDetail(tenantId(req), req.params.id);
  if (!group) { res.status(404).json({ error: "Group not found" }); return; }
  res.json({ group });
});

receptionRouter.patch("/groups/:id", async (req, res) => {
  const data = groupPatchSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "group", data.error.flatten()); return; }
  const tid = tenantId(req);
  const found = await prisma.reservationGroup.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
  if (!found) { res.status(404).json({ error: "Group not found" }); return; }
  if (data.data.customerId && !(await prisma.customer.findFirst({ where: { id: data.data.customerId, tenantId: tid }, select: { id: true } }))) { res.status(400).json({ error: "Choose the billing customer from this property" }); return; }
  await prisma.reservationGroup.update({ where: { id: found.id }, data: data.data });
  res.json({ group: await groupDetail(tid, found.id) });
});

/** Add more rooms to a group that already exists (more people arriving). */
receptionRouter.post("/groups/:id/rooms", async (req, res, next) => {
  const data = groupAddRoomsSchema.safeParse(req.body);
  if (!data.success) { invalid(res, "rooms", data.error.flatten()); return; }
  if (data.data.checkOut <= data.data.checkIn) { res.status(400).json({ error: "Check-out must be after check-in" }); return; }
  const tid = tenantId(req);
  try {
    const group = await prisma.reservationGroup.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    const prepared = await prepareGroupRooms(tid, data.data, data.data.rooms, group.customerId);
    const actor = await resolveActor(tid, req);
    const numbers: { reservationNo: string; folioNo: string }[] = [];
    for (let i = 0; i < prepared.length; i++) numbers.push({ reservationNo: await nextReservationNo(tid), folioNo: await nextFolioNo(tid) });
    await prisma.$transaction((tx) => bookGroupRooms(tx, tid, actor, req.userId, group, prepared, { status: data.data.status, source: data.data.source, defaultTerms: data.data.terms, numbers }), GROUP_TX);
    res.status(201).json({ group: await groupDetail(tid, group.id) });
  } catch (error) {
    if (sendStatusError(res, error)) return;
    next(error);
  }
});

/** Check in the group's waiting rooms (all of them, or the chosen ones). */
receptionRouter.post("/groups/:id/check-in", async (req, res, next) => {
  const data = groupCheckInSchema.safeParse(req.body ?? {});
  if (!data.success) { invalid(res, "check-in", data.error.flatten()); return; }
  const tid = tenantId(req);
  try {
    const group = await prisma.reservationGroup.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    const waiting = await prisma.reservation.findMany({
      where: { groupId: group.id, tenantId: tid, status: { in: ["PENDING", "CONFIRMED"] }, ...(data.data.reservationIds ? { id: { in: data.data.reservationIds } } : {}) },
      include: { room: { include: { roomType: true } }, folio: true },
    });
    if (waiting.length === 0) { res.status(409).json({ error: "No waiting rooms to check in" }); return; }
    const actor = await resolveActor(tid, req);
    const tax = await taxDefaults(tid);
    await prisma.$transaction(async (tx) => {
      for (const current of waiting) {
        await tx.reservation.update({ where: { id: current.id }, data: { status: "CHECKED_IN", updatedBy: req.userId } });
        await tx.room.update({ where: { id: current.roomId }, data: { status: "OCCUPIED" } });
        if (current.folio) {
          const charge = await resolveRoomCharge(tx, current.room, { rateId: current.rateId, mealPlan: current.rateId ? undefined : current.mealPlan, headcount: current.adults + current.children }, current.checkIn, current.checkOut, tax);
          await tx.folioLineItem.create({
            data: { tenantId: tid, folioId: current.folio.id, source: "ROOM", label: charge.label, amount: charge.amount, quantity: charge.quantity, taxRate: charge.taxRate, taxMode: charge.taxMode, taxTreatment: charge.taxTreatment, createdBy: req.userId },
          });
          await syncRoomAdjustment(tx, tid, current.id, req.userId);
        }
        await logActivity(tx, tid, current.id, "CHECKED_IN", "Checked in with the group", actor);
      }
    }, GROUP_TX);
    res.json({ group: await groupDetail(tid, group.id) });
  } catch (error) {
    if (sendStatusError(res, error)) return;
    next(error);
  }
});

/** Spread payments over rooms in order: each payment fills the first room's
 * balance, then the next, and so on. Returns one allocation per (payment, room). */
function allocatePayments(rooms: { id: string; due: number }[], payments: { paymentMethodId: string; amount: number; reference?: string }[]) {
  const remaining = new Map(rooms.map((r) => [r.id, r.due]));
  const allocations: { roomId: string; paymentMethodId: string; amount: number; reference?: string }[] = [];
  for (const payment of payments) {
    let left = round2(payment.amount);
    for (const room of rooms) {
      if (left <= 0.004) break;
      const due = remaining.get(room.id) ?? 0;
      if (due <= 0.004) continue;
      const take = round2(Math.min(left, due));
      allocations.push({ roomId: room.id, paymentMethodId: payment.paymentMethodId, amount: take, reference: payment.reference });
      remaining.set(room.id, round2(due - take));
      left = round2(left - take);
    }
  }
  return { allocations, remaining };
}

/** Check the whole group (or the chosen rooms) out at once: payments — cash,
 * card, one company card, any mix — are spread across the rooms, and whatever
 * isn't paid is completed on credit against the billing customer, with a
 * reason and expected payment date, ready to be invoiced. */
receptionRouter.post("/groups/:id/checkout", async (req, res, next) => {
  const data = groupCheckoutSchema.safeParse(req.body ?? {});
  if (!data.success) { invalid(res, "group checkout", data.error.flatten()); return; }
  const tid = tenantId(req);
  try {
    const group = await prisma.reservationGroup.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    const targets = (await prisma.reservation.findMany({
      where: { groupId: group.id, tenantId: tid, status: "CHECKED_IN", ...(data.data.reservationIds ? { id: { in: data.data.reservationIds } } : {}) },
      include: { customer: true, room: true, folio: { include: { lineItems: true, payments: true } } },
    })).sort((a, b) => a.room.number.localeCompare(b.room.number, undefined, { numeric: true }));
    if (targets.length === 0) { res.status(409).json({ error: "No checked-in rooms to check out" }); return; }
    if (targets.some((r) => !r.folio)) { res.status(500).json({ error: "A room in this group has no folio on record" }); return; }

    for (const payment of data.data.payments) await resolvePaymentMethod(tid, payment.paymentMethodId, payment.reference);
    const groupTax = await taxDefaults(tid);
    const rooms = targets.map((r) => ({ id: r.id, due: Math.max(0, round2(folioTotals(r.folio, groupTax).balance)) }));
    const dueTotal = round2(rooms.reduce((sum, r) => sum + r.due, 0));
    const paidTotal = round2(data.data.payments.reduce((sum, p) => sum + p.amount, 0));
    if (paidTotal > dueTotal + 0.01) { res.status(400).json({ error: `Payments of ${paidTotal.toFixed(2)} exceed the balance due of ${dueTotal.toFixed(2)}` }); return; }
    const shortfall = round2(dueTotal - paidTotal);
    if (shortfall > 0.01 && ((data.data.creditReason ?? "").length < 3 || !data.data.creditExpectedAt)) {
      res.status(409).json({ error: `A balance of ${shortfall.toFixed(2)} remains — pay it, or complete on credit with a reason and an expected payment date`, code: "BALANCE_DUE", balance: shortfall });
      return;
    }
    const { allocations, remaining } = allocatePayments(rooms, data.data.payments);
    const transactionNos: string[] = [];
    for (let i = 0; i < allocations.length; i++) transactionNos.push(await nextTransactionNo(tid));
    const actor = await resolveActor(tid, req);
    const byId = new Map(targets.map((r) => [r.id, r]));

    await prisma.$transaction(async (tx) => {
      for (const [index, alloc] of allocations.entries()) {
        const reservation = byId.get(alloc.roomId)!;
        const created = await tx.folioPayment.create({ data: { tenantId: tid, folioId: reservation.folio!.id, kind: "SETTLEMENT", paymentMethodId: alloc.paymentMethodId, amount: alloc.amount, reference: alloc.reference, createdBy: req.userId } });
        await tx.transaction.create({
          data: {
            tenantId: tid, transactionNo: transactionNos[index], direction: "IN", source: "FOLIO_SETTLEMENT", amount: alloc.amount,
            paymentMethodId: alloc.paymentMethodId, reference: alloc.reference, customerId: group.customerId, employeeId: req.userId,
            description: `Group checkout ${group.groupNo} — ${reservation.reservationNo}`, sourceRefId: created.id,
          },
        });
      }
      for (const reservation of targets) {
        const credit = round2(remaining.get(reservation.id) ?? 0);
        const onCredit = credit > 0.01;
        await tx.folio.update({
          where: { id: reservation.folio!.id },
          data: onCredit ? { status: "SETTLED", creditAmount: credit, creditReason: data.data.creditReason, creditExpectedAt: data.data.creditExpectedAt } : { status: "SETTLED" },
        });
        if (onCredit) {
          await applyCustomerBalance(tx, { tenantId: tid, customerId: group.customerId, folioId: reservation.folio!.id, delta: credit, type: "CREDIT", note: `Group ${group.groupNo} — stay ${reservation.reservationNo} checked out on credit`, by: req.userId });
        }
        await tx.reservation.update({ where: { id: reservation.id }, data: { status: "CHECKED_OUT", updatedBy: req.userId } });
        await freeRoom(tx, tid, reservation.roomId, `${reservation.customer.firstName} ${reservation.customer.lastName}`, "checked out with the group", reservation.id);
        await logActivity(tx, tid, reservation.id, "CHECKED_OUT", onCredit ? `Checked out with the group on credit (${credit.toFixed(2)} owing)` : "Checked out with the group", actor);
      }
    }, GROUP_TX);
    res.json({ group: await groupDetail(tid, group.id) });
  } catch (error) {
    if (sendStatusError(res, error)) return;
    next(error);
  }
});

/** Receive payment against the credit a group was checked out on. Spread over
 * the rooms with credit outstanding, oldest expected date first. */
receptionRouter.post("/groups/:id/credit-payments", async (req, res, next) => {
  const data = groupPaymentsSchema.safeParse(req.body ?? {});
  if (!data.success || data.data.payments.length === 0) { invalid(res, "payment", data.success ? { payments: ["Add at least one payment"] } : data.error.flatten()); return; }
  const tid = tenantId(req);
  try {
    const group = await prisma.reservationGroup.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    const stays = await prisma.reservation.findMany({ where: { groupId: group.id, tenantId: tid, folio: { creditAmount: { gt: 0 } } }, include: { room: true, folio: true } });
    const outstanding = await folioCreditOutstanding(prisma, tid, stays.map((r) => r.folio!.id));
    const owing = stays
      .map((r) => ({ reservation: r, due: Math.max(0, outstanding.get(r.folio!.id) ?? 0) }))
      .filter((r) => r.due > 0.01)
      .sort((a, b) => (a.reservation.folio!.creditExpectedAt?.getTime() ?? Infinity) - (b.reservation.folio!.creditExpectedAt?.getTime() ?? Infinity) || a.reservation.room.number.localeCompare(b.reservation.room.number, undefined, { numeric: true }));
    const owingTotal = round2(owing.reduce((sum, r) => sum + r.due, 0));
    if (owingTotal <= 0.01) { res.status(409).json({ error: "This group has no credit left to pay" }); return; }
    const paidTotal = round2(data.data.payments.reduce((sum, p) => sum + p.amount, 0));
    if (paidTotal > owingTotal + 0.01) { res.status(400).json({ error: `Payments of ${paidTotal.toFixed(2)} exceed the credit owing of ${owingTotal.toFixed(2)}` }); return; }
    for (const payment of data.data.payments) await resolvePaymentMethod(tid, payment.paymentMethodId, payment.reference);
    const { allocations } = allocatePayments(owing.map((r) => ({ id: r.reservation.id, due: r.due })), data.data.payments);
    const transactionNos: string[] = [];
    for (let i = 0; i < allocations.length; i++) transactionNos.push(await nextTransactionNo(tid));
    const actor = await resolveActor(tid, req);
    const byId = new Map(owing.map((r) => [r.reservation.id, r.reservation]));
    await prisma.$transaction(async (tx) => {
      for (const [index, alloc] of allocations.entries()) {
        const reservation = byId.get(alloc.roomId)!;
        const created = await tx.folioPayment.create({ data: { tenantId: tid, folioId: reservation.folio!.id, kind: "SETTLEMENT", paymentMethodId: alloc.paymentMethodId, amount: alloc.amount, reference: alloc.reference, createdBy: req.userId } });
        await tx.transaction.create({
          data: {
            tenantId: tid, transactionNo: transactionNos[index], direction: "IN", source: "FOLIO_SETTLEMENT", amount: alloc.amount,
            paymentMethodId: alloc.paymentMethodId, reference: alloc.reference, customerId: group.customerId, employeeId: req.userId,
            description: `Group credit payment ${group.groupNo} — ${reservation.reservationNo}`, sourceRefId: created.id,
          },
        });
        await applyCustomerBalance(tx, { tenantId: tid, customerId: group.customerId, folioId: reservation.folio!.id, delta: -alloc.amount, type: "REPAYMENT", note: `Group ${group.groupNo} payment against stay ${reservation.reservationNo}`, by: req.userId });
        await logActivity(tx, tid, reservation.id, "CREDIT_PAYMENT", `Credit payment received with the group — ${alloc.amount}`, actor);
      }
    }, GROUP_TX);
    res.status(201).json({ group: await groupDetail(tid, group.id) });
  } catch (error) {
    if (sendStatusError(res, error)) return;
    next(error);
  }
});
