import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";

import { env } from "../../config/env.js";
import { initiateStkPush, normalizeMsisdn, queryStkStatus, describeResultCode, type MpesaCredentials } from "../../lib/mpesa.js";
import { applyStkResult } from "../../lib/mpesaStk.js";
import { prisma } from "../../lib/prisma.js";
import { blockingReservationWhere } from "../../lib/roomAvailability.js";
import { syncRoomBilledOrderPayments } from "../../lib/roomBilledOrders.js";
import { nextCustomerNo, nextFolioNo, nextReservationNo, nextTransactionNo } from "../../lib/sequence.js";
import { syncStayInvoicesForFolio } from "../commercial-documents/commercial-documents.routes.js";
import { resolveMpesaCredentials } from "../locations/locations.routes.js";
import type { PublicSite } from "./site.js";

// Online room bookings. A booking is a normal Reservation (source WEBSITE,
// status PENDING) with its own folio — staff confirm it in Reception exactly
// like a phone booking. When the site requires an M-Pesa deposit, the room is
// held for website.holdMinutes; an unpaid hold is released (cancelled) after.

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export class BookingError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type GuestDetails = { firstName: string; lastName: string; phone: string; email?: string };

export type RoomBookingInput = {
  roomTypeId: string;
  rateId?: string;
  checkIn: Date;
  checkOut: Date;
  adults: number;
  children: number;
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  notes?: string;
  /** Only when the site takes payment: "deposit" (the minimum) or "full". */
  payment?: "deposit" | "full";
  /** Safaricom number for the STK prompt; defaults to the guest's phone. */
  mpesaPhone?: string;
};

export const nightsBetween = (checkIn: Date, checkOut: Date) => Math.round((checkOut.getTime() - checkIn.getTime()) / DAY_MS);

/** What the guest owes up front: the larger of depositPercent of the stay and
 * depositMinimum, never more than the stay. */
export function depositFor(site: PublicSite, total: number): number {
  const w = site.website;
  const byPercent = (total * Number(w.depositPercent)) / 100;
  return round2(Math.min(total, Math.max(byPercent, Number(w.depositMinimum))));
}

/** Payment rules as the website shows them. */
export function bookingRules(site: PublicSite) {
  const w = site.website;
  return {
    confirmation: w.bookingConfirmation,
    requirePayment: w.requirePayment,
    depositPercent: Number(w.depositPercent),
    depositMinimum: Number(w.depositMinimum),
    holdMinutes: w.holdMinutes,
    // A deposit can only be taken where the booking location has M-Pesa set up.
    paymentAvailable: site.paymentReady,
  };
}

function phoneVariants(raw: string): string[] {
  const msisdn = normalizeMsisdn(raw);
  const trimmed = raw.trim();
  if (!msisdn) return [trimmed];
  const local = `0${msisdn.slice(3)}`;
  return [...new Set([trimmed, msisdn, `+${msisdn}`, local, `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`])];
}

/** An existing guest record (same phone, else same email), or a new one. */
export async function findOrCreateCustomer(tx: Prisma.TransactionClient, site: PublicSite, input: GuestDetails) {
  const email = input.email?.toLowerCase();
  const existing = await tx.customer.findFirst({
    where: { tenantId: site.tenantId, OR: [{ phone: { in: phoneVariants(input.phone) } }, ...(email ? [{ email }] : [])] },
    orderBy: { createdAt: "asc" },
  });
  if (existing) {
    // Fill gaps only — never overwrite what the front desk recorded.
    if (email && !existing.email) await tx.customer.update({ where: { id: existing.id }, data: { email } });
    return existing;
  }
  return tx.customer.create({
    data: {
      tenantId: site.tenantId,
      customerNo: await nextCustomerNo(site.tenantId),
      firstName: input.firstName,
      lastName: input.lastName || null,
      phone: input.phone,
      email: email ?? null,
      notes: "Created from an online booking",
      locationId: site.website.bookingLocationId,
    },
  });
}

/**
 * Creates the booking. Bookings for the same room type are serialised with a
 * transaction-scoped advisory lock, and availability is re-checked inside it,
 * so two guests can never be given the last room at once.
 */
export async function createRoomBooking(site: PublicSite, input: RoomBookingInput) {
  const nights = nightsBetween(input.checkIn, input.checkOut);
  const roomType = await prisma.roomType.findFirst({
    where: { id: input.roomTypeId, tenantId: site.tenantId, isActive: true, showOnWebsite: true },
    include: { rates: { orderBy: { price: "asc" } } },
  });
  if (!roomType) throw new BookingError(404, "That room isn't available to book online");
  if (input.adults + input.children > roomType.capacity) throw new BookingError(400, `The ${roomType.name} sleeps up to ${roomType.capacity}`);
  const rate = roomType.rates.length > 0
    ? roomType.rates.find((r) => r.id === input.rateId) ?? (input.rateId ? null : roomType.rates[0])
    : null;
  if (roomType.rates.length > 0 && !rate) throw new BookingError(400, "Choose one of this room's rates");
  const nightly = rate ? Number(rate.price) : Number(roomType.baseRate);
  const total = round2(nightly * nights);

  const w = site.website;
  const takesPayment = w.requirePayment && input.payment !== undefined;
  if (w.requirePayment) {
    if (!input.payment) throw new BookingError(400, "Choose how much to pay now");
    if (!w.bookingLocationId || !(await resolveMpesaCredentials(site.tenantId, w.bookingLocationId))) {
      throw new BookingError(409, "Online payment isn't available right now — please call us to book");
    }
  }
  const amountDue = takesPayment ? (input.payment === "full" ? total : depositFor(site, total)) : 0;
  const payPhone = takesPayment ? normalizeMsisdn(input.mpesaPhone || input.phone) : null;
  if (takesPayment && !payPhone) throw new BookingError(400, "Enter a Safaricom number for the M-Pesa prompt, e.g. 0712 345 678");

  const manageToken = randomBytes(24).toString("base64url");
  const guestNote = [`Booked online — ${rate?.name ?? roomType.name}, ${nights} night${nights === 1 ? "" : "s"}, est. ${total.toFixed(2)}.`, input.notes ? `Guest note: ${input.notes}` : null]
    .filter(Boolean).join("\n");

  const reservation = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`web-booking:${site.tenantId}:${roomType.id}`}))`;
    const busy = await tx.reservation.findMany({
      where: { ...blockingReservationWhere({ tenantId: site.tenantId, checkIn: input.checkIn, checkOut: input.checkOut }), room: { roomTypeId: roomType.id } },
      select: { roomId: true },
    });
    const room = await tx.room.findFirst({
      where: { tenantId: site.tenantId, roomTypeId: roomType.id, status: { not: "OUT_OF_SERVICE" }, id: { notIn: busy.map((b) => b.roomId) } },
      orderBy: { number: "asc" },
    });
    if (!room) throw new BookingError(409, "Sorry — that room was just booked for those dates. Please choose another room or other dates.");

    const customer = await findOrCreateCustomer(tx, site, input);
    const created = await tx.reservation.create({
      data: {
        tenantId: site.tenantId,
        reservationNo: await nextReservationNo(site.tenantId),
        customerId: customer.id,
        roomId: room.id,
        source: "WEBSITE",
        status: "PENDING",
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        adults: input.adults,
        children: input.children,
        mealPlan: rate?.mealPlan ?? "ROOM_ONLY",
        rateId: rate?.id ?? null,
        rateName: rate?.name ?? null,
        notes: guestNote,
        locationId: w.bookingLocationId,
        manageToken,
        holdExpiresAt: takesPayment ? new Date(Date.now() + w.holdMinutes * 60_000) : null,
      },
    });
    await tx.folio.create({ data: { tenantId: site.tenantId, folioNo: await nextFolioNo(site.tenantId), reservationId: created.id } });
    await tx.reservationActivity.create({
      data: { tenantId: site.tenantId, reservationId: created.id, action: "CREATED", summary: `Requested online by ${input.firstName} ${input.lastName}`.trim(), locationId: w.bookingLocationId },
    });
    return created;
  });

  let payment: Awaited<ReturnType<typeof startBookingPayment>> | null = null;
  let paymentError: string | null = null;
  if (takesPayment && payPhone) {
    try {
      payment = await startBookingPayment(site, reservation.id, payPhone, amountDue);
    } catch (error) {
      // The room stays held; the guest can retry from their booking page.
      paymentError = error instanceof Error ? error.message : "Could not send the M-Pesa prompt";
    }
  }
  return { manageToken, reservationNo: reservation.reservationNo, payment, paymentError };
}

function callbackUrl(): string {
  if (!env.MPESA_CALLBACK_BASE_URL) throw new BookingError(503, "Online payment isn't available right now — please call us to book");
  return `${env.MPESA_CALLBACK_BASE_URL.replace(/\/+$/, "")}/public/mpesa/callback`;
}

/** Sends the STK prompt for a booking's deposit / full amount. */
export async function startBookingPayment(site: PublicSite, reservationId: string, phone: string, amount: number) {
  const locationId = site.website.bookingLocationId;
  const creds = locationId ? await resolveMpesaCredentials(site.tenantId, locationId) : null;
  if (!locationId || !creds) throw new BookingError(409, "Online payment isn't available right now — please call us");
  const reservation = await prisma.reservation.findFirstOrThrow({ where: { id: reservationId, tenantId: site.tenantId }, select: { reservationNo: true } });
  const request = await prisma.mpesaStkRequest.create({
    data: { tenantId: site.tenantId, locationId, purpose: "WEBSITE_BOOKING", purposeRefId: reservationId, phoneNumber: phone, amount: Math.ceil(amount) },
  });
  try {
    const result = await initiateStkPush(creds as MpesaCredentials, {
      phone, amount: Math.ceil(amount), accountRef: reservation.reservationNo.replace(/\W/g, "").slice(0, 12),
      description: "Room booking", callbackUrl: callbackUrl(),
    });
    await prisma.mpesaStkRequest.update({ where: { id: request.id }, data: { merchantRequestId: result.merchantRequestId, checkoutRequestId: result.checkoutRequestId } });
  } catch (error) {
    await prisma.mpesaStkRequest.update({ where: { id: request.id }, data: { status: "FAILED", resultDesc: error instanceof Error ? error.message : "Could not reach Safaricom" } });
    throw new BookingError(502, "We couldn't send the M-Pesa prompt. Please try again.");
  }
  return { requestId: request.id, amount: Math.ceil(amount) };
}

/** Polls one booking payment, nudging Safaricom's query endpoint when the
 * callback is late (same approach as the POS). Scoped to the booking. */
export async function bookingPaymentStatus(site: PublicSite, reservationId: string, requestId: string) {
  let row = await prisma.mpesaStkRequest.findFirst({ where: { id: requestId, tenantId: site.tenantId, purpose: "WEBSITE_BOOKING", purposeRefId: reservationId } });
  if (!row) return null;
  if (row.status === "PENDING" && row.checkoutRequestId && Date.now() - row.createdAt.getTime() > 5000) {
    const creds = await resolveMpesaCredentials(site.tenantId, row.locationId);
    if (creds) {
      const queried = await queryStkStatus(creds as MpesaCredentials, row.checkoutRequestId).catch(() => null);
      if (queried) await applyStkResult(row.id, { resultCode: queried.resultCode, resultDesc: queried.resultDesc });
    }
    row = await prisma.mpesaStkRequest.findUniqueOrThrow({ where: { id: row.id } });
  }
  return { status: row.status, message: row.status === "PENDING" ? null : row.resultCode != null ? describeResultCode(row.resultCode) : row.resultDesc };
}

/**
 * Called from applyStkResult when a WEBSITE_BOOKING push succeeds: records the
 * money as a folio deposit (plus its ledger Transaction), exactly like a
 * deposit taken at the desk, and ends the hold. The booking stays PENDING for
 * staff to confirm. Runs inside the caller's transaction.
 */
export async function recordBookingPayment(tx: Prisma.TransactionClient, row: { tenantId: string; purposeRefId: string; amount: Prisma.Decimal }, receipt: string | undefined) {
  const reservation = await tx.reservation.findFirstOrThrow({ where: { id: row.purposeRefId, tenantId: row.tenantId }, include: { folio: true } });
  if (!reservation.folio) throw new Error("The booking has no folio");
  const method = await tx.paymentMethod.findFirstOrThrow({ where: { tenantId: row.tenantId, code: "MPESA" } });
  const amount = Number(row.amount);
  const payment = await tx.folioPayment.create({
    data: { tenantId: row.tenantId, folioId: reservation.folio.id, kind: "DEPOSIT", paymentMethodId: method.id, amount, reference: receipt },
  });
  await syncStayInvoicesForFolio(tx, payment.folioId);
  await syncRoomBilledOrderPayments(tx, payment.folioId);
  await tx.transaction.create({
    data: {
      tenantId: row.tenantId,
      transactionNo: await nextTransactionNo(row.tenantId),
      direction: "IN",
      source: "FOLIO_DEPOSIT",
      locationId: reservation.locationId,
      amount,
      paymentMethodId: method.id,
      reference: receipt,
      customerId: reservation.customerId,
      description: `Online deposit — ${reservation.reservationNo}`,
      sourceRefId: payment.id,
    },
  });
  const lateNote = reservation.status === "CANCELLED" ? " (arrived after the hold had expired — refund or rebook)" : "";
  await tx.reservationActivity.create({
    data: { tenantId: row.tenantId, reservationId: reservation.id, action: "DEPOSIT_RECORDED", summary: `Paid online via M-Pesa — ${amount.toFixed(2)}${receipt ? ` (${receipt})` : ""}${lateNote}`, locationId: reservation.locationId },
  });
  await tx.reservation.update({ where: { id: reservation.id }, data: { holdExpiresAt: null } });
}

/** What the guest's "manage my booking" page shows. */
export async function bookingForGuest(site: PublicSite, manageToken: string) {
  const r = await prisma.reservation.findFirst({
    where: { manageToken, tenantId: site.tenantId },
    include: {
      customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
      room: { select: { roomType: { select: { id: true, name: true, imageUrls: true, baseRate: true } } } },
      rate: { select: { price: true } },
      folio: { select: { payments: { select: { amount: true } } } },
    },
  });
  if (!r) return null;
  const nights = nightsBetween(r.checkIn, r.checkOut);
  const nightly = r.rate ? Number(r.rate.price) : Number(r.room.roomType.baseRate);
  const total = round2(nightly * nights);
  const paid = round2((r.folio?.payments ?? []).reduce((s, p) => s + Number(p.amount), 0));
  const holdActive = r.status === "PENDING" && r.holdExpiresAt != null && r.holdExpiresAt > new Date();
  const pendingPayment = await prisma.mpesaStkRequest.findFirst({
    where: { tenantId: site.tenantId, purpose: "WEBSITE_BOOKING", purposeRefId: r.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    select: { id: true, amount: true },
  });
  return {
    reference: r.reservationNo,
    status: r.status,
    checkIn: r.checkIn.toISOString().slice(0, 10),
    checkOut: r.checkOut.toISOString().slice(0, 10),
    nights,
    adults: r.adults,
    children: r.children,
    roomType: { id: r.room.roomType.id, name: r.room.roomType.name, imageUrl: r.room.roomType.imageUrls[0] ?? null },
    rateName: r.rateName,
    guest: { firstName: r.customer.firstName, lastName: r.customer.lastName, email: r.customer.email },
    estimatedTotal: total,
    paid,
    // Owed now to keep the hold (0 once paid, or when no payment is required).
    paymentDue: holdActive && paid === 0 ? depositFor(site, total) : 0,
    holdExpiresAt: holdActive ? r.holdExpiresAt!.toISOString() : null,
    pendingPaymentId: pendingPayment?.id ?? null,
    canCancel: (r.status === "PENDING" || r.status === "CONFIRMED") && r.checkIn.getTime() > Date.now(),
    cancellationReason: r.cancellationReason,
  };
}

/** Guest-initiated cancellation (before arrival). Any deposit is refunded by staff. */
export async function cancelBookingByGuest(site: PublicSite, manageToken: string) {
  const r = await prisma.reservation.findFirst({ where: { manageToken, tenantId: site.tenantId } });
  if (!r) throw new BookingError(404, "Booking not found");
  if (!(r.status === "PENDING" || r.status === "CONFIRMED") || r.checkIn.getTime() <= Date.now()) {
    throw new BookingError(409, "This booking can no longer be cancelled online — please call us");
  }
  await prisma.$transaction([
    prisma.reservation.update({
      where: { id: r.id },
      data: { status: "CANCELLED", cancellationReason: "CHANGED_MIND", cancellationNotes: "Cancelled by the guest online", holdExpiresAt: null },
    }),
    prisma.reservationActivity.create({ data: { tenantId: r.tenantId, reservationId: r.id, action: "CANCELLED", summary: "Cancelled by the guest online", locationId: r.locationId } }),
  ]);
}

/**
 * Cancels online bookings whose payment hold ran out unpaid, so they stop
 * cluttering Reception's pending list. Their rooms were already free again
 * (expired holds never block availability). Safe to run anywhere, any time.
 */
export async function releaseExpiredHolds(): Promise<number> {
  const expired = await prisma.reservation.findMany({
    where: { source: "WEBSITE", status: "PENDING", holdExpiresAt: { lt: new Date() } },
    select: { id: true, tenantId: true, locationId: true },
    take: 200,
  });
  for (const r of expired) {
    // A guest may be typing their M-Pesa PIN right now — give a fresh prompt time to land.
    const inFlight = await prisma.mpesaStkRequest.count({
      where: { purpose: "WEBSITE_BOOKING", purposeRefId: r.id, status: "PENDING", createdAt: { gt: new Date(Date.now() - 3 * 60_000) } },
    });
    if (inFlight > 0) continue;
    await prisma.$transaction([
      prisma.reservation.update({
        where: { id: r.id },
        data: { status: "CANCELLED", cancellationReason: "OTHER", cancellationNotes: "Online payment wasn't completed in time", holdExpiresAt: null },
      }),
      prisma.reservationActivity.create({ data: { tenantId: r.tenantId, reservationId: r.id, action: "CANCELLED", summary: "Released — online payment wasn't completed in time", locationId: r.locationId } }),
    ]);
  }
  return expired.length;
}
