import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { orderInclude, taxSettingsFor, withFinancials } from "../pos/pos.routes.js";
import { resolveServiceLines } from "../../lib/serviceSale.js";
import { computeStockRequirements } from "../../lib/stockRequirements.js";
import { deductStockForOrder, resolveStockLocationId } from "../../lib/orderStock.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { visitsInTerm } from "../../lib/membership.js";
import { isWithinShift, resolveShiftFor } from "../../lib/shifts.js";
import { effectiveMembershipStatus } from "../../lib/membership.js";
import { nextTransactionNo } from "../../lib/sequence.js";
import { checkedPaymentReference } from "../../lib/paymentReferences.js";

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export const serviceCenterRouter = Router();
serviceCenterRouter.use(requireModule("SERVICE_CENTER"));

const appointmentStatus = z.enum(["BOOKED", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"]);
const paymentStatus = z.enum(["PENDING", "PAID", "REFUNDED", "FAILED"]);
const membershipStatus = z.enum(["ACTIVE", "PAUSED", "EXPIRED", "CANCELLED"]);
const groupSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  isActive: z.boolean().default(true),
});
const groupFilterSchema = z.object({ groupId: z.string().cuid().optional() });
const planSchema = z.object({
  name: z.string().trim().min(2).max(80),
  price: z.coerce.number().min(0).max(100_000_000).default(0),
  durationDays: z.coerce.number().int().min(1).max(3650).default(30),
  discountPercent: z.coerce.number().min(0).max(100).default(0),
  description: z.string().trim().max(300).nullable().optional(),
  visitLimit: z.preprocess((v) => (v === "" ? null : v), z.coerce.number().int().min(1).max(100_000).nullable()).optional(),
  discountOnProducts: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
const membershipSchema = z.object({
  customerId: z.string().cuid(),
  // Sell from the plan catalog (the plan fills the name/price/duration/discount), or leave out for a one-off.
  planId: z.string().cuid().nullable().optional(),
  planName: z.string().trim().min(2).max(80).optional(),
  planPrice: z.coerce.number().min(0).max(100_000_000).default(0),
  durationDays: z.coerce.number().int().min(1).max(3650).default(30),
  discountPercent: z.coerce.number().min(0).max(100).default(0),
  visitLimit: z.preprocess((v) => (v === "" ? null : v), z.coerce.number().int().min(1).max(100_000).nullable()).optional(),
  discountOnProducts: z.boolean().default(false),
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
  amount: z.coerce.number().positive().max(100_000_000).optional(),
  status: paymentStatus.default("PAID"),
  reference: z.string().trim().max(120).nullable().optional(),
  paidAt: z.coerce.date().nullable().optional(),
});
const membershipVisitSchema = z.object({
  visitedAt: z.coerce.date().optional(),
  note: z.string().trim().max(200).nullable().optional(),
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
// A provider is just an employee: active, and pinned to a location that sells services.
const providerSelect = { id: true, firstName: true, lastName: true, jobTitle: true, phone: true } as const;
type ProviderRow = { id: string; firstName: string; lastName: string; jobTitle: string; phone: string };
const toProvider = (e: ProviderRow | null | undefined) => (e ? { id: e.id, name: `${e.firstName} ${e.lastName}`.trim(), specialty: e.jobTitle, phone: e.phone, isActive: true } : null);
const serviceStaffWhere = (tid: string, locationId?: string | null) => ({
  tenantId: tid, status: "ACTIVE" as const,
  locations: { some: locationId ? { id: locationId, canSellServices: true } : { canSellServices: true, isActive: true } },
});

const serviceGroupSelect = { id: true, name: true, isActive: true } as const;
const customerInclude = { serviceGroup: { select: serviceGroupSelect } } as const;
const include = {
  customer: { include: customerInclude },
  service: { include: { variants: { where: { isActive: true } }, locations: { select: { id: true } } } },
  serviceVariant: true,
  provider: { select: providerSelect },
  membership: true,
  paymentMethod: true,
  location: { select: { id: true, name: true } },
  // Once completed, the real sale (tax, payment status, receipt) lives here — see /appointments/:id/complete.
  order: { select: { id: true, orderNumber: true, status: true } },
} as const;
const membershipInclude = {
  customer: { include: customerInclude },
  payments: { include: { paymentMethod: true }, orderBy: { createdAt: "desc" as const } },
  visits: { select: { id: true, visitedAt: true, note: true }, orderBy: { visitedAt: "desc" as const }, take: 500 },
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
  const m = membership as T & { status?: string; endsAt?: Date; startsAt?: Date; visits?: { visitedAt: Date }[] };
  const used = m.visits && m.startsAt && m.endsAt ? { visitsUsed: visitsInTerm({ startsAt: m.startsAt, endsAt: m.endsAt, durationDays: membership.durationDays }, m.visits) } : {};
  return { ...membership, ...used, ...(m.status && m.endsAt ? { status: effectiveMembershipStatus(m.status, m.endsAt) } : {}), plan: planSnapshot(membership) };
}

function withAppointmentMembershipPlan<T extends { provider?: unknown; membership: ({ id: string; planName: string; planPrice: unknown; durationDays: number; discountPercent: unknown } | null) }>(appointment: T) {
  return { ...appointment, provider: toProvider(appointment.provider as ProviderRow | null | undefined), membership: appointment.membership ? withPlanSnapshot(appointment.membership) : null };
}

serviceCenterRouter.get("/customer-groups", async (req, res) => {
  const tid = tenantId(req);
  const groups = await prisma.serviceCustomerGroup.findMany({
    where: { tenantId: tid },
    include: { _count: { select: { customers: true } } },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
  res.json({ groups });
});

serviceCenterRouter.post("/customer-groups", async (req, res) => {
  const parsed = groupSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid group", details: parsed.error.flatten() }); return; }
  try {
    const group = await prisma.serviceCustomerGroup.create({ data: { tenantId: tenantId(req), ...parsed.data }, include: { _count: { select: { customers: true } } } });
    res.status(201).json({ group });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") { res.status(409).json({ error: "A group with this name already exists" }); return; }
    throw error;
  }
});

serviceCenterRouter.patch("/customer-groups/:id", async (req, res) => {
  const parsed = partialNoDefaults(groupSchema).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid group", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const updated = await prisma.serviceCustomerGroup.updateMany({ where: { id: req.params.id, tenantId: tid }, data: parsed.data });
    if (!updated.count) { res.status(404).json({ error: "Group not found" }); return; }
    const group = await prisma.serviceCustomerGroup.findUniqueOrThrow({ where: { id: req.params.id }, include: { _count: { select: { customers: true } } } });
    res.json({ group });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") { res.status(409).json({ error: "A group with this name already exists" }); return; }
    throw error;
  }
});

serviceCenterRouter.delete("/customer-groups/:id", async (req, res) => {
  const tid = tenantId(req);
  const group = await prisma.serviceCustomerGroup.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { _count: { select: { customers: true } } } });
  if (!group) { res.status(404).json({ error: "Group not found" }); return; }
  if (group._count.customers > 0) { res.status(409).json({ error: "This group still has customers. Move them first or deactivate it." }); return; }
  await prisma.serviceCustomerGroup.delete({ where: { id: group.id } });
  res.status(204).send();
});

serviceCenterRouter.get("/memberships", async (req, res) => {
  const tid = tenantId(req);
  const query = groupFilterSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid membership filters" }); return; }
  const groupId = query.data.groupId;
  const memberships = await prisma.membership.findMany({
    where: { tenantId: tid, ...(groupId ? { customer: { serviceGroupId: groupId } } : {}) },
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
  // A catalog plan supplies the terms that get frozen onto the membership.
  let terms = { planName: data.planName, planPrice: data.planPrice, durationDays: data.durationDays, discountPercent: data.discountPercent, visitLimit: data.visitLimit ?? null, discountOnProducts: data.discountOnProducts };
  if (data.planId) {
    const plan = await prisma.membershipPlan.findFirst({ where: { id: data.planId, tenantId: tid } });
    if (!plan) return { error: "Choose a valid membership plan" } as const;
    terms = { planName: plan.name, planPrice: Number(plan.price), durationDays: plan.durationDays, discountPercent: Number(plan.discountPercent), visitLimit: plan.visitLimit, discountOnProducts: plan.discountOnProducts };
  }
  if (!terms.planName) return { error: "Choose a plan or name this membership" } as const;
  const endsAt = data.endsAt ?? new Date(data.startsAt.getTime() + terms.durationDays * 86_400_000);
  if (endsAt <= data.startsAt) return { error: "Membership end date must be after its start date" } as const;
  return { customer, endsAt, terms: { ...terms, planName: terms.planName } } as const;
}

serviceCenterRouter.get("/membership-plans", async (req, res) => {
  const plans = await prisma.membershipPlan.findMany({ where: { tenantId: tenantId(req) }, include: { _count: { select: { memberships: true } } }, orderBy: [{ isActive: "desc" }, { name: "asc" }] });
  res.json({ plans });
});
serviceCenterRouter.post("/membership-plans", async (req, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid plan", details: parsed.error.flatten() }); return; }
  try {
    res.status(201).json({ plan: await prisma.membershipPlan.create({ data: { tenantId: tenantId(req), ...parsed.data } }) });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") { res.status(409).json({ error: "A plan with this name already exists" }); return; }
    throw error;
  }
});
serviceCenterRouter.patch("/membership-plans/:id", async (req, res) => {
  const parsed = partialNoDefaults(planSchema).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid plan", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    // Members already on the plan keep the terms they were sold (snapshot).
    const updated = await prisma.membershipPlan.updateMany({ where: { id: req.params.id, tenantId: tid }, data: parsed.data });
    if (!updated.count) { res.status(404).json({ error: "Plan not found" }); return; }
    res.json({ plan: await prisma.membershipPlan.findUniqueOrThrow({ where: { id: req.params.id } }) });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") { res.status(409).json({ error: "A plan with this name already exists" }); return; }
    throw error;
  }
});
serviceCenterRouter.delete("/membership-plans/:id", async (req, res) => {
  const tid = tenantId(req);
  const plan = await prisma.membershipPlan.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { _count: { select: { memberships: true } } } });
  if (!plan) { res.status(404).json({ error: "Plan not found" }); return; }
  if (plan._count.memberships > 0) { res.status(409).json({ error: "Members have been sold this plan — deactivate it instead of deleting" }); return; }
  await prisma.membershipPlan.delete({ where: { id: plan.id } });
  res.status(204).send();
});

serviceCenterRouter.post("/memberships/:id/visits", async (req, res) => {
  const tid = tenantId(req);
  const m = await prisma.membership.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { visits: { select: { visitedAt: true } } } });
  if (!m) { res.status(404).json({ error: "Membership not found" }); return; }
  const parsed = membershipVisitSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid attendance record", details: parsed.error.flatten() }); return; }
  const visitedAt = parsed.data.visitedAt ?? new Date();
  if (effectiveMembershipStatus(m.status, m.endsAt, visitedAt) !== "ACTIVE" || m.startsAt > visitedAt) { res.status(409).json({ error: "This membership is not active for that date" }); return; }
  if (visitedAt > new Date()) { res.status(409).json({ error: "Attendance cannot be marked for a future date" }); return; }
  if (m.visitLimit != null && visitsInTerm(m, m.visits) >= m.visitLimit) { res.status(409).json({ error: `All ${m.visitLimit} visits for this term have been used` }); return; }
  const dayStart = new Date(visitedAt); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const duplicate = await prisma.membershipVisit.findFirst({ where: { tenantId: tid, membershipId: m.id, visitedAt: { gte: dayStart, lt: dayEnd } }, select: { id: true } });
  if (duplicate) { res.status(409).json({ error: "Attendance is already marked for that day" }); return; }
  await prisma.membershipVisit.create({ data: { tenantId: tid, membershipId: m.id, visitedAt, note: parsed.data.note || null, recordedBy: req.userId } });
  const membership = await prisma.membership.findUniqueOrThrow({ where: { id: m.id }, include: membershipInclude });
  res.status(201).json({ membership: withPlanSnapshot(membership) });
});
serviceCenterRouter.delete("/memberships/:id/visits/:visitId", async (req, res) => {
  const removed = await prisma.membershipVisit.deleteMany({ where: { id: req.params.visitId, membershipId: req.params.id, tenantId: tenantId(req) } });
  if (!removed.count) { res.status(404).json({ error: "Visit not found" }); return; }
  res.status(204).send();
});

/** Renew: extends from the later of now and the current end date (so an early renewal loses no days), reactivates, and optionally re-prices from the plan's current terms. */
serviceCenterRouter.post("/memberships/:id/renew", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.membership.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Membership not found" }); return; }
  if (current.status === "CANCELLED") { res.status(409).json({ error: "A cancelled membership can't be renewed — sell a new one" }); return; }
  const now = new Date();
  const from = current.endsAt > now ? current.endsAt : now;
  const membership = await prisma.membership.update({
    where: { id: current.id },
    data: { status: "ACTIVE", endsAt: new Date(from.getTime() + current.durationDays * 86_400_000) },
    include: membershipInclude,
  });
  res.json({ membership: withPlanSnapshot(membership) });
});

serviceCenterRouter.post("/memberships", async (req, res) => {
  const parsed = membershipSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid membership", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const resolved = await resolveMembership(tid, parsed.data);
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const membership = await prisma.membership.create({
    data: { tenantId: tid, customerId: parsed.data.customerId, planId: parsed.data.planId ?? null, ...resolved.terms, startsAt: parsed.data.startsAt, status: parsed.data.status, endsAt: resolved.endsAt },
    include: membershipInclude,
  });
  res.status(201).json({ membership: withPlanSnapshot(membership) });
});

serviceCenterRouter.patch("/memberships/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.membership.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Membership not found" }); return; }
  const parsed = partialNoDefaults(membershipSchema).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid membership", details: parsed.error.flatten() }); return; }
  const merged = membershipSchema.parse({ ...current, ...parsed.data });
  const newPlan = parsed.data.planId && parsed.data.planId !== current.planId ? parsed.data.planId : null;
  const resolved = await resolveMembership(tid, { ...merged, planId: newPlan });
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const membership = await prisma.membership.update({
    where: { id: current.id },
    data: { customerId: merged.customerId, planId: parsed.data.planId !== undefined ? parsed.data.planId : current.planId, ...resolved.terms, startsAt: merged.startsAt, status: merged.status, endsAt: resolved.endsAt },
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
  const [customers, groups, paymentMethods] = await Promise.all([
    prisma.customer.findMany({ where: { tenantId: tid }, include: customerInclude, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    prisma.serviceCustomerGroup.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
    prisma.paymentMethod.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
  ]);
  res.json({ customers, groups, paymentMethods });
});

const membershipPaymentInclude = {
  paymentMethod: true,
  membership: {
    include: {
      customer: { include: customerInclude },
      appointments: { include: { service: true, provider: { select: providerSelect } }, orderBy: { startsAt: "desc" as const } },
    },
  },
} as const;

function withPaymentMembershipPlan<T extends { membership: { id: string; planName: string; planPrice: unknown; durationDays: number; discountPercent: unknown } }>(payment: T) {
  return { ...payment, membership: withPlanSnapshot(payment.membership) };
}

serviceCenterRouter.get("/membership-payments", async (req, res) => {
  const tid = tenantId(req);
  const query = groupFilterSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid payment filters" }); return; }
  const groupId = query.data.groupId;
  const membershipPayments = await prisma.membershipPayment.findMany({ where: { tenantId: tid, ...(groupId ? { membership: { customer: { serviceGroupId: groupId } } } : {}) }, include: membershipPaymentInclude, orderBy: { createdAt: "desc" } });
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

async function resolveMembershipPaymentReference(tid: string, method: { name: string; requiresReference: boolean }, reference: string | null | undefined, excludeId?: string) {
  const cleanReference = await checkedPaymentReference(prisma, tid, method, reference);
  if (!cleanReference) return null;
  const duplicate = await prisma.membershipPayment.findFirst({
    where: { tenantId: tid, status: "PAID", reference: { equals: cleanReference, mode: "insensitive" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (duplicate) throw Object.assign(new Error(`Transaction code ${cleanReference} has already been used on another membership payment`), { status: 400 });
  return cleanReference;
}

/** Keeps the unified ledger in step with a membership payment: PAID has exactly one
 * COMPLETE transaction (amount/method/reference kept current); anything else voids it. */
async function syncPaymentLedger(
  tx: Prisma.TransactionClient,
  tid: string,
  payment: { id: string; status: string; amount: unknown; paymentMethodId: string; reference: string | null; membershipId: string },
  customerId: string,
  transactionNo: string | null,
  userId: string | undefined,
) {
  const existing = await tx.transaction.findFirst({ where: { tenantId: tid, source: "MEMBERSHIP_PAYMENT", sourceRefId: payment.id } });
  if (payment.status !== "PAID") {
    if (existing) await tx.transaction.update({ where: { id: existing.id }, data: { status: "VOIDED" } });
    return;
  }
  const fields = { amount: Number(payment.amount), paymentMethodId: payment.paymentMethodId, reference: payment.reference, customerId, status: "COMPLETE" as const };
  if (existing) { await tx.transaction.update({ where: { id: existing.id }, data: fields }); return; }
  await tx.transaction.create({
    data: { tenantId: tid, transactionNo: transactionNo!, direction: "IN", source: "MEMBERSHIP_PAYMENT", employeeId: userId, description: "Membership payment", sourceRefId: payment.id, ...fields },
  });
}

serviceCenterRouter.post("/membership-payments", async (req, res) => {
  const parsed = membershipPaymentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid membership payment", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const resolved = await resolveMembershipPayment(tid, parsed.data.membershipId, parsed.data.paymentMethodId);
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  if (parsed.data.status !== "PAID") { res.status(400).json({ error: "Membership payments are recorded only when fully paid" }); return; }
  const amount = Number(resolved.membership.planPrice);
  if (parsed.data.amount !== undefined && Math.abs(Number(parsed.data.amount) - amount) > 0.01) {
    res.status(400).json({ error: "Membership payments must match the full plan price" });
    return;
  }
  const reference = await resolveMembershipPaymentReference(tid, resolved.paymentMethod, parsed.data.reference);
  const paidAt = parsed.data.paidAt ?? new Date();
  const transactionNo = await nextTransactionNo(tid);
  const membershipPayment = await prisma.$transaction(async (tx) => {
    const created = await tx.membershipPayment.create({ data: { tenantId: tid, membershipId: parsed.data.membershipId, paymentMethodId: parsed.data.paymentMethodId, amount, status: "PAID", reference, paidAt }, include: membershipPaymentInclude });
    await syncPaymentLedger(tx, tid, created, resolved.membership.customerId, transactionNo, req.userId);
    return created;
  });
  res.status(201).json({ membershipPayment: withPaymentMembershipPlan(membershipPayment) });
});

serviceCenterRouter.patch("/membership-payments/:id", async (_req, res) => {
  res.status(405).json({ error: "Membership payments are immutable. Record a new payment instead." });
});

serviceCenterRouter.delete("/membership-payments/:id", async (_req, res) => {
  res.status(405).json({ error: "Membership payments are immutable and cannot be deleted." });
});

serviceCenterRouter.get("/membership-payment-options", async (req, res) => {
  const tid = tenantId(req);
  const [memberships, paymentMethods, groups] = await Promise.all([
    prisma.membership.findMany({ where: { tenantId: tid }, include: { customer: { include: customerInclude }, appointments: { select: { id: true, startsAt: true, service: { select: { name: true } } } } }, orderBy: { createdAt: "desc" } }),
    prisma.paymentMethod.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
    prisma.serviceCustomerGroup.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
  ]);
  res.json({ memberships: memberships.map(withPlanSnapshot), paymentMethods, groups });
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
  const query = groupFilterSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid appointment filters" }); return; }
  const groupId = query.data.groupId;
  const appointments = await prisma.appointment.findMany({ where: { tenantId: tid, ...(groupId ? { customer: { serviceGroupId: groupId } } : {}) }, include, orderBy: { startsAt: "asc" } });
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
    prisma.employee.findFirst({ where: { ...serviceStaffWhere(tid, data.locationId), id: data.providerId }, select: providerSelect }),
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
  // Availability comes from the employee's shift (rotation/override): no shift configured = unrestricted.
  const providerName = `${provider.firstName} ${provider.lastName}`.trim();
  const shift = await resolveShiftFor(tid, provider.id, data.startsAt);
  if (shift && !(isWithinShift(shift, data.startsAt) && isWithinShift(shift, new Date(endsAt.getTime() - 60_000)))) {
    return { error: `${providerName} is on the ${shift.name} shift (${shift.startTime}-${shift.endTime}) at that time - pick a time inside it` } as const;
  }
  const conflict = await prisma.appointment.findFirst({ where: { tenantId: tid, providerId: provider.id, status: { notIn: ["CANCELLED", "NO_SHOW"] }, startsAt: { lt: endsAt }, endsAt: { gt: data.startsAt }, ...(excludeId ? { id: { not: excludeId } } : {}) } });
  if (conflict) return { error: `${providerName} already has an appointment during this time` } as const;
  const listPrice = Number(variant?.price ?? service.price);
  const discount = membership ? Number(membership.discountPercent) : 0;
  // An estimate shown while booking - the real charged amount is fixed at completion (lib/serviceSale.ts),
  // since prices (and which membership is active) can move between booking and the appointment happening.
  return { customer, service, variant, provider: toProvider(provider)!, membership, paymentMethod, endsAt, amount: round2(listPrice * (1 - discount / 100)) } as const;
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
    // The chosen membership only discounts while it's current — a lapsed/paused one gives nothing.
    const now = new Date();
    const m = appt.membership;
    const memberDiscount = m && m.status === "ACTIVE" && m.startsAt <= now && m.endsAt >= now && Number(m.discountPercent) > 0
      ? { percent: Number(m.discountPercent), label: `Membership: ${m.planName} (${Number(m.discountPercent)}% off)` }
      : null;
    const order = await prisma.$transaction(async (tx) => {
      const itemsCreate = await resolveServiceLines(
        tx, tid,
        [{
          serviceId: appt.serviceId, variantId: appt.serviceVariantId ?? undefined, quantity: 1, addons: [],
        }],
        appt.locationId, req.userId, fallbackTax, memberDiscount,
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
  const [customers, services, providers, memberships, paymentMethods, membershipPayments, locations, groups] = await Promise.all([
    prisma.customer.findMany({ where: { tenantId: tid }, include: customerInclude, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    prisma.service.findMany({ where: { tenantId: tid, isActive: true }, include: { variants: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }, locations: { select: { id: true } } }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: serviceStaffWhere(tid), select: { ...providerSelect, locations: { select: { id: true } } }, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    prisma.membership.findMany({ where: { tenantId: tid }, include: { customer: { include: customerInclude } }, orderBy: { endsAt: "desc" } }),
    prisma.paymentMethod.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
    prisma.membershipPayment.findMany({ where: { tenantId: tid }, include: { membership: { include: { customer: { include: customerInclude } } }, paymentMethod: true }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.location.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
    prisma.serviceCustomerGroup.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
  ]);
  res.json({ customers, services, providers: providers.map((p) => ({ ...toProvider(p)!, locationIds: p.locations.map((l) => l.id) })), memberships: memberships.map(withPlanSnapshot), paymentMethods, membershipPayments: membershipPayments.map(withPaymentMembershipPlan), locations, groups });
});
