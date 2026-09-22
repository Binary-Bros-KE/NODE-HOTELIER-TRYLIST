import { Router } from "express";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { orderInclude, taxSettingsFor, withFinancials } from "../pos/pos.routes.js";
import { resolveServiceLines } from "../../lib/serviceSale.js";
import { computeStockRequirements } from "../../lib/stockRequirements.js";
import { deductStockForOrder, resolveStockLocationId } from "../../lib/orderStock.js";

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export const serviceCenterRouter = Router();
serviceCenterRouter.use(requireModule("SERVICE_CENTER"));

const appointmentStatus = z.enum(["BOOKED", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"]);
const paymentStatus = z.enum(["PENDING", "PAID", "REFUNDED", "FAILED"]);
const membershipStatus = z.enum(["ACTIVE", "PAUSED", "EXPIRED", "CANCELLED"]);
const membershipSchema = z.object({
  customerId: z.string().cuid(),
  planName: z.string().trim().min(2).max(80),
  planPrice: z.coerce.number().min(0).max(100_000_000).default(0),
  durationDays: z.coerce.number().int().min(1).max(3650).default(30),
  discountPercent: z.coerce.number().min(0).max(100).default(0),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().optional(),
  status: membershipStatus.default("ACTIVE"),
});
const paymentMethodSchema = z.object({
  name: z.string().trim().min(2).max(60),
  isActive: z.boolean().default(true),
});
const membershipPaymentSchema = z.object({
  membershipId: z.string().cuid(),
  // Not .cuid(): the system payment methods (Cash, M-Pesa...) are seeded with plain
  // UUIDs, same convention as every other paymentMethodId field in the codebase.
  paymentMethodId: z.string().trim().min(1),
  amount: z.coerce.number().positive().max(100_000_000),
  status: paymentStatus.default("PAID"),
  reference: z.string().trim().max(120).nullable().optional(),
  paidAt: z.coerce.date().nullable().optional(),
});
const providerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  specialty: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  isActive: z.boolean().default(true),
});
const appointmentSchema = z.object({
  customerId: z.string().cuid(),
  serviceId: z.string().cuid(),
  // Which size/duration option of the service, when it has any (same convention as the till).
  serviceVariantId: z.string().cuid().nullable().optional(),
  providerId: z.string().cuid(),
  membershipId: z.string().cuid().nullable().optional(),
  // Not .cuid(): system payment methods are seeded with plain UUIDs.
  paymentMethodId: z.string().trim().min(1).nullable().optional(),
  // Optional: only matters when the chosen service is itself restricted to specific locations.
  locationId: z.string().cuid().nullable().optional(),
  startsAt: z.coerce.date(),
  status: appointmentStatus.default("BOOKED"),
  paymentStatus: paymentStatus.default("PENDING"),
  notes: z.string().trim().max(500).nullable().optional(),
});
const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};
const include = {
  customer: true,
  service: { include: { variants: { where: { isActive: true } }, locations: { select: { id: true } } } },
  serviceVariant: true,
  provider: true,
  membership: true,
  paymentMethod: true,
  location: { select: { id: true, name: true } },
  // Once completed, the real sale (tax, payment status, receipt) lives here — see /appointments/:id/complete.
  order: { select: { id: true, orderNumber: true, status: true } },
} as const;
const membershipInclude = {
  customer: true,
  payments: { include: { paymentMethod: true }, orderBy: { createdAt: "desc" as const } },
  _count: { select: { appointments: true } },
} as const;

function planSnapshot(membership: { id: string; planName: string; planPrice: unknown; durationDays: number; discountPercent: unknown }) {
  return {
    id: membership.id,
    name: membership.planName,
    price: membership.planPrice,
    durationDays: membership.durationDays,
    discountPercent: membership.discountPercent,
    isActive: true,
  };
}

function withPlanSnapshot<T extends { id: string; planName: string; planPrice: unknown; durationDays: number; discountPercent: unknown }>(membership: T) {
  return { ...membership, plan: planSnapshot(membership) };
}

function withAppointmentMembershipPlan<T extends { membership: ({ id: string; planName: string; planPrice: unknown; durationDays: number; discountPercent: unknown } | null) }>(appointment: T) {
  return { ...appointment, membership: appointment.membership ? withPlanSnapshot(appointment.membership) : null };
}

serviceCenterRouter.get("/memberships", async (req, res) => {
  const tid = tenantId(req);
  const memberships = await prisma.membership.findMany({
    where: { tenantId: tid },
    include: membershipInclude,
    orderBy: { createdAt: "desc" },
  });
  const now = new Date();
  res.json({
    memberships: memberships.map(withPlanSnapshot),
    summary: {
      total: memberships.length,
      active: memberships.filter((item) => item.status === "ACTIVE" && item.endsAt >= now).length,
      expiringSoon: memberships.filter((item) => item.status === "ACTIVE" && item.endsAt >= now && item.endsAt <= new Date(now.getTime() + 30 * 86_400_000)).length,
      revenue: memberships.flatMap((item) => item.payments).filter((payment) => payment.status === "PAID").reduce((sum, payment) => sum + Number(payment.amount), 0),
    },
  });
});

serviceCenterRouter.get("/memberships/:id", async (req, res) => {
  const membership = await prisma.membership.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: membershipInclude });
  if (!membership) { res.status(404).json({ error: "Membership not found" }); return; }
  res.json({ membership: withPlanSnapshot(membership) });
});

async function resolveMembership(tid: string, data: z.infer<typeof membershipSchema>) {
  const customer = await prisma.customer.findFirst({ where: { id: data.customerId, tenantId: tid } });
  if (!customer) return { error: "Choose a valid customer" } as const;
  const endsAt = data.endsAt ?? new Date(data.startsAt.getTime() + data.durationDays * 86_400_000);
  if (endsAt <= data.startsAt) return { error: "Membership end date must be after its start date" } as const;
  return { customer, endsAt } as const;
}

serviceCenterRouter.post("/memberships", async (req, res) => {
  const parsed = membershipSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid membership", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const resolved = await resolveMembership(tid, parsed.data);
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const membership = await prisma.membership.create({
    data: { tenantId: tid, ...parsed.data, endsAt: resolved.endsAt },
    include: membershipInclude,
  });
  res.status(201).json({ membership: withPlanSnapshot(membership) });
});

serviceCenterRouter.patch("/memberships/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.membership.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Membership not found" }); return; }
  const parsed = membershipSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid membership", details: parsed.error.flatten() }); return; }
  const merged = membershipSchema.parse({ ...current, ...parsed.data });
  const resolved = await resolveMembership(tid, merged);
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const membership = await prisma.membership.update({
    where: { id: current.id },
    data: { ...parsed.data, endsAt: resolved.endsAt },
    include: membershipInclude,
  });
  res.json({ membership: withPlanSnapshot(membership) });
});

serviceCenterRouter.delete("/memberships/:id", async (req, res) => {
  const deleted = await prisma.membership.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!deleted.count) { res.status(404).json({ error: "Membership not found" }); return; }
  res.status(204).send();
});

serviceCenterRouter.get("/membership-options", async (req, res) => {
  const tid = tenantId(req);
  const customers = await prisma.customer.findMany({ where: { tenantId: tid }, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] });
  res.json({ customers });
});

const membershipPaymentInclude = {
  paymentMethod: true,
  membership: {
    include: {
      customer: true,
      appointments: { include: { service: true, provider: true }, orderBy: { startsAt: "desc" as const } },
    },
  },
} as const;

function withPaymentMembershipPlan<T extends { membership: { id: string; planName: string; planPrice: unknown; durationDays: number; discountPercent: unknown } }>(payment: T) {
  return { ...payment, membership: withPlanSnapshot(payment.membership) };
}

serviceCenterRouter.get("/membership-payments", async (req, res) => {
  const tid = tenantId(req);
  const membershipPayments = await prisma.membershipPayment.findMany({ where: { tenantId: tid }, include: membershipPaymentInclude, orderBy: { createdAt: "desc" } });
  res.json({ membershipPayments: membershipPayments.map(withPaymentMembershipPlan) });
});

serviceCenterRouter.get("/membership-payments/:id", async (req, res) => {
  const membershipPayment = await prisma.membershipPayment.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: membershipPaymentInclude });
  if (!membershipPayment) { res.status(404).json({ error: "Membership payment not found" }); return; }
  res.json({ membershipPayment: withPaymentMembershipPlan(membershipPayment) });
});

async function resolveMembershipPayment(tid: string, membershipId: string, paymentMethodId: string) {
  const [membership, paymentMethod] = await Promise.all([
    prisma.membership.findFirst({ where: { id: membershipId, tenantId: tid }, include: { customer: true } }),
    prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, tenantId: tid } }),
  ]);
  if (!membership) return { error: "Choose a valid customer membership" } as const;
  if (!paymentMethod) return { error: "Choose a valid payment method" } as const;
  return { membership, paymentMethod } as const;
}

serviceCenterRouter.post("/membership-payments", async (req, res) => {
  const parsed = membershipPaymentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid membership payment", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const resolved = await resolveMembershipPayment(tid, parsed.data.membershipId, parsed.data.paymentMethodId);
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const paidAt = parsed.data.status === "PAID" ? (parsed.data.paidAt ?? new Date()) : parsed.data.paidAt;
  const membershipPayment = await prisma.membershipPayment.create({ data: { tenantId: tid, ...parsed.data, paidAt }, include: membershipPaymentInclude });
  res.status(201).json({ membershipPayment: withPaymentMembershipPlan(membershipPayment) });
});

serviceCenterRouter.patch("/membership-payments/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.membershipPayment.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Membership payment not found" }); return; }
  const parsed = membershipPaymentSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid membership payment", details: parsed.error.flatten() }); return; }
  const membershipId = parsed.data.membershipId ?? current.membershipId;
  const paymentMethodId = parsed.data.paymentMethodId ?? current.paymentMethodId;
  const resolved = await resolveMembershipPayment(tid, membershipId, paymentMethodId);
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const nextStatus = parsed.data.status ?? current.status;
  const paidAt = parsed.data.paidAt !== undefined ? parsed.data.paidAt : nextStatus === "PAID" && !current.paidAt ? new Date() : current.paidAt;
  const membershipPayment = await prisma.membershipPayment.update({ where: { id: current.id }, data: { ...parsed.data, paidAt }, include: membershipPaymentInclude });
  res.json({ membershipPayment: withPaymentMembershipPlan(membershipPayment) });
});

serviceCenterRouter.delete("/membership-payments/:id", async (req, res) => {
  const deleted = await prisma.membershipPayment.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!deleted.count) { res.status(404).json({ error: "Membership payment not found" }); return; }
  res.status(204).send();
});

serviceCenterRouter.get("/membership-payment-options", async (req, res) => {
  const tid = tenantId(req);
  const [memberships, paymentMethods] = await Promise.all([
    prisma.membership.findMany({ where: { tenantId: tid }, include: { customer: true, appointments: { select: { id: true, startsAt: true, service: { select: { name: true } } } } }, orderBy: { createdAt: "desc" } }),
    prisma.paymentMethod.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
  ]);
  res.json({ memberships: memberships.map(withPlanSnapshot), paymentMethods });
});

const providerInclude = {
  appointments: { include: { customer: true, service: true }, orderBy: { startsAt: "desc" as const }, take: 20 },
  _count: { select: { appointments: true } },
} as const;

serviceCenterRouter.get("/providers", async (req, res) => {
  const providers = await prisma.serviceProvider.findMany({ where: { tenantId: tenantId(req) }, include: providerInclude, orderBy: [{ isActive: "desc" }, { name: "asc" }] });
  res.json({ providers });
});

serviceCenterRouter.get("/providers/:id", async (req, res) => {
  const provider = await prisma.serviceProvider.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: providerInclude });
  if (!provider) { res.status(404).json({ error: "Provider not found" }); return; }
  res.json({ provider });
});

serviceCenterRouter.post("/providers", async (req, res) => {
  const parsed = providerSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid provider", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const duplicate = await prisma.serviceProvider.findFirst({ where: { tenantId: tid, name: { equals: parsed.data.name, mode: "insensitive" } } });
  if (duplicate) { res.status(409).json({ error: "A provider with this name already exists" }); return; }
  const provider = await prisma.serviceProvider.create({ data: { tenantId: tid, ...parsed.data }, include: providerInclude });
  res.status(201).json({ provider });
});

serviceCenterRouter.patch("/providers/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.serviceProvider.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Provider not found" }); return; }
  const parsed = providerSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid provider", details: parsed.error.flatten() }); return; }
  if (parsed.data.name) {
    const duplicate = await prisma.serviceProvider.findFirst({ where: { tenantId: tid, name: { equals: parsed.data.name, mode: "insensitive" }, id: { not: current.id } } });
    if (duplicate) { res.status(409).json({ error: "A provider with this name already exists" }); return; }
  }
  const provider = await prisma.serviceProvider.update({ where: { id: current.id }, data: parsed.data, include: providerInclude });
  res.json({ provider });
});

serviceCenterRouter.delete("/providers/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.serviceProvider.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { _count: { select: { appointments: true } } } });
  if (!current) { res.status(404).json({ error: "Provider not found" }); return; }
  if (current._count.appointments) { res.status(409).json({ error: "This provider has appointment history. Deactivate them instead of deleting them." }); return; }
  await prisma.serviceProvider.delete({ where: { id: current.id } });
  res.status(204).send();
});

serviceCenterRouter.get("/payment-methods", async (req, res) => {
  const tid = tenantId(req);
  const paymentMethods = await prisma.paymentMethod.findMany({
    where: { tenantId: tid },
    include: { _count: { select: { membershipPayments: true, appointments: true } } },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
  res.json({ paymentMethods });
});

serviceCenterRouter.get("/payment-methods/:id", async (req, res) => {
  const paymentMethod = await prisma.paymentMethod.findFirst({
    where: { id: req.params.id, tenantId: tenantId(req) },
    include: { _count: { select: { membershipPayments: true, appointments: true } } },
  });
  if (!paymentMethod) { res.status(404).json({ error: "Payment method not found" }); return; }
  res.json({ paymentMethod });
});

serviceCenterRouter.post("/payment-methods", async (req, res) => {
  const parsed = paymentMethodSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid payment method", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const duplicate = await prisma.paymentMethod.findFirst({ where: { tenantId: tid, name: { equals: parsed.data.name, mode: "insensitive" } } });
  if (duplicate) { res.status(409).json({ error: "A payment method with this name already exists" }); return; }
  const code = `SC_${parsed.data.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
  const paymentMethod = await prisma.paymentMethod.create({ data: { tenantId: tid, code, ...parsed.data }, include: { _count: { select: { membershipPayments: true, appointments: true } } } });
  res.status(201).json({ paymentMethod });
});

serviceCenterRouter.patch("/payment-methods/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.paymentMethod.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Payment method not found" }); return; }
  const parsed = paymentMethodSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid payment method", details: parsed.error.flatten() }); return; }
  if (parsed.data.name) {
    const duplicate = await prisma.paymentMethod.findFirst({ where: { tenantId: tid, name: { equals: parsed.data.name, mode: "insensitive" }, id: { not: current.id } } });
    if (duplicate) { res.status(409).json({ error: "A payment method with this name already exists" }); return; }
  }
  const paymentMethod = await prisma.paymentMethod.update({ where: { id: current.id }, data: parsed.data, include: { _count: { select: { membershipPayments: true, appointments: true } } } });
  res.json({ paymentMethod });
});

serviceCenterRouter.delete("/payment-methods/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.paymentMethod.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { _count: { select: { membershipPayments: true, appointments: true } } } });
  if (!current) { res.status(404).json({ error: "Payment method not found" }); return; }
  if (current._count.membershipPayments || current._count.appointments) {
    res.status(409).json({ error: "This method has transaction history. Deactivate it instead of deleting it." }); return;
  }
  await prisma.paymentMethod.delete({ where: { id: current.id } });
  res.status(204).send();
});

serviceCenterRouter.get("/appointments", async (req, res) => {
  const tid = tenantId(req);
  const appointments = await prisma.appointment.findMany({ where: { tenantId: tid }, include, orderBy: { startsAt: "asc" } });
  const now = new Date();
  res.json({ appointments: appointments.map(withAppointmentMembershipPlan), summary: { total: appointments.length, today: appointments.filter((item) => item.startsAt.toDateString() === now.toDateString() && !["CANCELLED", "NO_SHOW"].includes(item.status)).length, upcoming: appointments.filter((item) => item.startsAt > now && !["CANCELLED", "NO_SHOW"].includes(item.status)).length, completed: appointments.filter((item) => item.status === "COMPLETED").length } });
});

serviceCenterRouter.get("/appointments/:id", async (req, res) => {
  const appointment = await prisma.appointment.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include });
  if (!appointment) { res.status(404).json({ error: "Appointment not found" }); return; }
  res.json({ appointment: withAppointmentMembershipPlan(appointment) });
});

async function resolveAppointment(tid: string, data: z.infer<typeof appointmentSchema>, excludeId?: string) {
  const [customer, service, provider, membership, paymentMethod] = await Promise.all([
    prisma.customer.findFirst({ where: { id: data.customerId, tenantId: tid } }),
    prisma.service.findFirst({ where: { id: data.serviceId, tenantId: tid, isActive: true }, include: { variants: { where: { isActive: true } }, locations: { select: { id: true } } } }),
    prisma.serviceProvider.findFirst({ where: { id: data.providerId, tenantId: tid, isActive: true } }),
    data.membershipId ? prisma.membership.findFirst({ where: { id: data.membershipId, tenantId: tid, customerId: data.customerId, status: "ACTIVE", startsAt: { lte: data.startsAt }, endsAt: { gte: data.startsAt } } }) : null,
    data.paymentMethodId ? prisma.paymentMethod.findFirst({ where: { id: data.paymentMethodId, tenantId: tid, isActive: true } }) : null,
  ]);
  if (!customer || !service || !provider) return { error: "Choose a valid customer, service, and provider" } as const;
  if (data.membershipId && !membership) return { error: "The selected membership is not active for this customer and appointment date" } as const;
  if (data.paymentMethodId && !paymentMethod) return { error: "Choose an active payment method" } as const;
  // A service with options (sizes/durations) needs one chosen — same rule the till uses.
  const variant = data.serviceVariantId ? service.variants.find((v) => v.id === data.serviceVariantId) : undefined;
  if (service.variants.length > 0 && !variant) return { error: `Choose an option for "${service.name}"` } as const;
  if (data.serviceVariantId && !variant) return { error: "That option isn't available for this service" } as const;
  // A service allocated to specific locations may only be booked there (empty = everywhere).
  if (service.locations.length > 0 && (!data.locationId || !service.locations.some((l) => l.id === data.locationId))) {
    return { error: `"${service.name}" isn't offered at that location — choose one it's offered at` } as const;
  }
  const durationMinutes = variant?.durationMinutes ?? service.durationMinutes;
  if (!durationMinutes) return { error: `"${service.name}" has no duration set — add one under Services before booking it` } as const;
  const endsAt = new Date(data.startsAt.getTime() + durationMinutes * 60_000);
  const conflict = await prisma.appointment.findFirst({ where: { tenantId: tid, providerId: provider.id, status: { notIn: ["CANCELLED", "NO_SHOW"] }, startsAt: { lt: endsAt }, endsAt: { gt: data.startsAt }, ...(excludeId ? { id: { not: excludeId } } : {}) } });
  if (conflict) return { error: `${provider.name} already has an appointment during this time` } as const;
  const listPrice = Number(variant?.price ?? service.price);
  const discount = membership ? Number(membership.discountPercent) : 0;
  // An estimate shown while booking - the real charged amount is fixed at completion (lib/serviceSale.ts),
  // since prices (and which membership is active) can move between booking and the appointment happening.
  return { customer, service, variant, provider, membership, paymentMethod, endsAt, amount: round2(listPrice * (1 - discount / 100)) } as const;
}

serviceCenterRouter.post("/appointments", async (req, res) => {
  const parsed = appointmentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid appointment", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const resolved = await resolveAppointment(tid, parsed.data);
  if ("error" in resolved) { res.status(409).json({ error: resolved.error }); return; }
  const appointment = await prisma.appointment.create({ data: { tenantId: tid, ...parsed.data, membershipId: resolved.membership?.id, paymentMethodId: resolved.paymentMethod?.id, endsAt: resolved.endsAt, amount: resolved.amount }, include });
  res.status(201).json({ appointment: withAppointmentMembershipPlan(appointment) });
});

serviceCenterRouter.patch("/appointments/:id", async (req, res) => {
  const current = await prisma.appointment.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!current) { res.status(404).json({ error: "Appointment not found" }); return; }
  if (current.orderId) { res.status(409).json({ error: "This appointment has already been completed and sold — see Receipts to change the sale." }); return; }
  const parsed = appointmentSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid appointment", details: parsed.error.flatten() }); return; }
  const merged = appointmentSchema.parse({ ...current, ...parsed.data });
  const resolved = await resolveAppointment(current.tenantId, merged, current.id);
  if ("error" in resolved) { res.status(409).json({ error: resolved.error }); return; }
  const appointment = await prisma.appointment.update({ where: { id: current.id }, data: { ...parsed.data, membershipId: resolved.membership?.id, paymentMethodId: resolved.paymentMethod?.id, endsAt: resolved.endsAt, amount: resolved.amount }, include });
  res.json({ appointment: withAppointmentMembershipPlan(appointment) });
});

serviceCenterRouter.delete("/appointments/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.appointment.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, orderId: true } });
  if (!current) { res.status(404).json({ error: "Appointment not found" }); return; }
  if (current.orderId) { res.status(409).json({ error: "This appointment has been completed and sold — cancel or return the sale in Receipts instead." }); return; }
  await prisma.appointment.delete({ where: { id: current.id } });
  res.status(204).send();
});

/** Turns a due appointment into a real sale: the service (with its option and any
 * membership discount, expressed the same way a till price override is - kept as an
 * audited line, not silently folded into the total) is rung up as a SERVICES order,
 * its stock is consumed, and the order is left SERVED - ready to be paid the same way
 * any other service sale is (cash, room, credit) via the usual payment routes, or
 * immediately if the appointment already had a payment method chosen. */
serviceCenterRouter.post("/appointments/:id/complete", async (req, res) => {
  const tid = tenantId(req);
  const appt = await prisma.appointment.findFirst({
    where: { id: req.params.id, tenantId: tid },
    include: { service: true, serviceVariant: true, membership: true },
  });
  if (!appt) { res.status(404).json({ error: "Appointment not found" }); return; }
  if (appt.orderId) { res.status(409).json({ error: "This appointment has already been completed" }); return; }
  if (["CANCELLED", "NO_SHOW"].includes(appt.status)) { res.status(409).json({ error: `This appointment was ${appt.status === "NO_SHOW" ? "a no-show" : "cancelled"} — it can't be completed` }); return; }
  try {
    const tax = await taxSettingsFor(tid);
    const fallbackTax = { taxRate: tax?.taxRate ?? null, taxMode: tax?.taxMode ?? null, taxTreatment: tax?.taxTreatment ?? null };
    const listPrice = Number(appt.serviceVariant?.price ?? appt.service.price);
    const discountPercent = appt.membership ? Number(appt.membership.discountPercent) : 0;
    const overridePrice = discountPercent > 0 ? round2(listPrice * (1 - discountPercent / 100)) : undefined;
    const order = await prisma.$transaction(async (tx) => {
      const itemsCreate = await resolveServiceLines(
        tx, tid,
        [{
          serviceId: appt.serviceId, variantId: appt.serviceVariantId ?? undefined, quantity: 1, addons: [],
          ...(overridePrice !== undefined ? { unitPrice: overridePrice, overrideReason: `Membership: ${appt.membership!.planName} (${discountPercent}% off)` } : {}),
        }],
        appt.locationId, req.userId, fallbackTax,
      );
      const last = await tx.posOrder.findFirst({ where: { tenantId: tid }, orderBy: { orderNumber: "desc" }, select: { orderNumber: true } });
      const created = await tx.posOrder.create({
        data: {
          tenantId: tid, orderNumber: (last?.orderNumber ?? 0) + 1, channel: "SERVICES", status: "SERVED", servedAt: new Date(),
          locationId: appt.locationId, customerId: appt.customerId, createdBy: req.userId,
          notes: `${appt.service.name}${req.body?.notes ? ` — ${req.body.notes}` : ""}`.slice(0, 500),
          discount: 0, items: { create: itemsCreate },
        },
        include: orderInclude,
      });
      const requirements = computeStockRequirements(created.items);
      if (requirements.size > 0) {
        const stockLocationId = await resolveStockLocationId(tid, appt.locationId);
        if (!stockLocationId) throw Object.assign(new Error("No location is configured to hold stock for this service"), { status: 400 });
        await deductStockForOrder(tx, tid, requirements, stockLocationId, created.orderNumber, req);
      }
      await tx.appointment.update({ where: { id: appt.id }, data: { status: "COMPLETED", orderId: created.id, amount: created.items[0]!.unitPrice } });
      return created;
    });
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id }, include });
    res.status(200).json({ order: withFinancials(order, tax), appointment: withAppointmentMembershipPlan(appointment) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

serviceCenterRouter.get("/appointment-options", async (req, res) => {
  const tid = tenantId(req);
  const [customers, services, providers, memberships, paymentMethods, membershipPayments, locations] = await Promise.all([
    prisma.customer.findMany({ where: { tenantId: tid }, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    prisma.service.findMany({ where: { tenantId: tid, isActive: true }, include: { variants: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }, locations: { select: { id: true } } }, orderBy: { name: "asc" } }),
    prisma.serviceProvider.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
    prisma.membership.findMany({ where: { tenantId: tid }, include: { customer: true }, orderBy: { endsAt: "desc" } }),
    prisma.paymentMethod.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
    prisma.membershipPayment.findMany({ where: { tenantId: tid }, include: { membership: { include: { customer: true } }, paymentMethod: true }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.location.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
  ]);
  res.json({ customers, services, providers, memberships: memberships.map(withPlanSnapshot), paymentMethods, membershipPayments: membershipPayments.map(withPaymentMembershipPlan), locations });
});
