import { randomBytes } from "node:crypto";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { verifySecret } from "../../lib/hash.js";
import { provisionTenantBootstrap, MODULE_KEYS, MODULE_GROUP_KEYS, type ModuleGroups } from "../../lib/tenantBootstrap.js";
import { platformAuth } from "./platform.auth.js";
import { adminsRouter } from "./admins.routes.js";
import { plansRouter } from "../plans/plans.routes.js";

// Tenant creation and license management for TANZ staff — a standalone
// surface above every tenant, gated by a real per-person session
// (platformAuth), never by x-tenant-id. This is the one place a new client
// actually comes into existence; everywhere else in the app assumes a
// Tenant already exists.
export const platformRouter = Router();

// --- Auth: email + password, backed by PlatformSession rows -----------------
// Mounted BEFORE platformAuth — signing in is the one request that can't
// already carry a session token.

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const publicAdmin = (admin: { id: string; email: string; name: string }) => ({
  id: admin.id, email: admin.email, name: admin.name,
});

platformRouter.post("/auth/login", async (req, res, next) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Enter your email and password" }); return; }
  try {
    const admin = await prisma.platformAdmin.findUnique({ where: { email: parsed.data.email } });
    // Same generic message whether the email is unknown, the password is
    // wrong, or the account is disabled — don't leak which.
    if (!admin || !admin.isActive || !verifySecret(parsed.data.password, admin.password)) {
      res.status(401).json({ error: "Incorrect email or password" });
      return;
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await prisma.$transaction([
      prisma.platformSession.create({ data: { token, adminId: admin.id, expiresAt } }),
      prisma.platformAdmin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } }),
    ]);
    res.json({ token, expiresAt, admin: publicAdmin(admin) });
  } catch (error) {
    next(error);
  }
});

platformRouter.use(platformAuth);

/** What the app pings on load to confirm the stored token is still good. */
platformRouter.get("/auth/me", (req, res) => {
  res.status(200).json({ admin: req.platformAdmin });
});

platformRouter.post("/auth/logout", async (req, res, next) => {
  try {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
    if (token) await prisma.platformSession.deleteMany({ where: { token } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// Subscription catalog — see plans.routes.ts.
platformRouter.use("/plans", plansRouter);

// Platform admin accounts — see admins.routes.ts.
platformRouter.use("/admins", adminsRouter);

// Slugs that must never be handed to a real tenant — they either collide
// with a real hostname this system already answers on (the platform admin
// app's own subdomain, the API's own conventional subdomains) or are
// reserved DNS/web conventions. Extend this list if the platform app or
// API ever moves to a different subdomain.
// Subdomains that must never be handed to a tenant — they collide with a
// host this system (or common infra) already answers on. `server` is the
// API's own subdomain; `admin`/`platform` the admin app's; the rest are
// standard reservations.
const RESERVED_SLUGS = new Set([
  "www", "api", "server", "admin", "platform", "app", "dashboard",
  "mail", "ftp", "cdn", "assets", "static", "status", "staging", "dev",
  "docs", "blog", "help", "support", "hotelier",
]);

const slugSchema = z.string().trim().toLowerCase().min(3).max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Use lowercase letters, numbers, and hyphens only — no leading/trailing hyphen")
  .refine((slug) => !RESERVED_SLUGS.has(slug), "That subdomain is reserved");

const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema,
  businessType: z.enum(["RESTAURANT", "CAFE", "HOTEL", "MOTEL", "CLUB"]),
  currency: z.enum(["KES", "UGX", "TZS", "USD"]).default("KES"),
  // Seeds the tenant's BusinessProfile.email.
  contactEmail: z.string().trim().toLowerCase().email(),
  // The catalog plan this tenant is on — required. Its limits are copied
  // into the tenant snapshot; anything passed explicitly still wins
  // (per-tenant override is allowed).
  planId: z.string().trim().min(1),
  subscriptionPlan: z.string().trim().min(1).max(120).optional(),
  maxBranches: z.coerce.number().int().min(1).max(1000).optional(),
  maxUsers: z.coerce.number().int().min(1).max(10000).optional(),
  maxDevices: z.coerce.number().int().min(1).max(10000).optional(),
  // How long the trial period runs before nextDueDate hits — left unset
  // means no due date is scheduled yet (handled manually later).
  trialDays: z.coerce.number().int().min(1).max(3650).optional(),
  modules: z.object({ rooms: z.boolean(), sales: z.boolean(), services: z.boolean() })
    .refine((m) => m.rooms || m.sales || m.services, { message: "Enable at least one module", path: ["rooms"] }),
});

const modulesSchema = z.object({ rooms: z.boolean(), sales: z.boolean(), services: z.boolean() })
  .refine((m) => m.rooms || m.sales || m.services, { message: "Enable at least one module", path: ["rooms"] });

const GROUPED_KEY_SET = new Set<string>([...MODULE_GROUP_KEYS.rooms, ...MODULE_GROUP_KEYS.sales, ...MODULE_GROUP_KEYS.services]);

/** Derives the three admin-facing toggles from a tenant's enabled
 * TenantModule keys — one representative key per group is enough since
 * they're only ever flipped together (see MODULE_GROUP_KEYS). */
function moduleGroupsFrom(enabledKeys: string[]): ModuleGroups {
  const enabled = new Set(enabledKeys);
  return {
    rooms: MODULE_GROUP_KEYS.rooms.some((k) => enabled.has(k)),
    sales: MODULE_GROUP_KEYS.sales.some((k) => enabled.has(k)),
    services: MODULE_GROUP_KEYS.services.some((k) => enabled.has(k)),
  };
}

const updateTenantSchema = partialNoDefaults(z.object({
  name: z.string().trim().min(2).max(120),
  // null detaches the tenant from any catalog plan (snapshot stays as-is).
  planId: z.string().trim().min(1).nullable(),
  subscriptionPlan: z.string().trim().min(1).max(120),
  maxBranches: z.coerce.number().int().min(1).max(1000),
  maxUsers: z.coerce.number().int().min(1).max(10000),
  maxDevices: z.coerce.number().int().min(1).max(10000),
  licenseStatus: z.enum(["TRIAL", "ACTIVE", "EXPIRED", "SUSPENDED"]),
  // Deliberately separate from licenseStatus — see the comment on the PATCH
  // handler below for why these must never be conflated in the UI either.
  isActive: z.boolean(),
  nextDueDate: z.coerce.date().nullable(),
}));

const planSummarySelect = {
  id: true, name: true, billingType: true, currency: true,
  monthlyPrice: true, oneTimePrice: true, annualMaintenanceFee: true, supportLevel: true,
} satisfies Prisma.PlanSelect;

/**
 * Pulls a catalog plan's limits into a tenant-snapshot patch. `overrides`
 * are the values the request passed explicitly — those always win, so
 * picking a plan pre-fills the limits without preventing a per-tenant
 * tweak in the same call.
 */
async function planSnapshotPatch(
  planId: string,
  overrides: { subscriptionPlan?: string; maxBranches?: number; maxUsers?: number; maxDevices?: number },
): Promise<{ subscriptionPlan: string; maxBranches: number; maxUsers: number; maxDevices: number }> {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) throw new PlanNotFoundError();
  return {
    subscriptionPlan: overrides.subscriptionPlan ?? plan.name,
    maxBranches: overrides.maxBranches ?? plan.maxBranches,
    maxUsers: overrides.maxUsers ?? plan.maxUsers,
    maxDevices: overrides.maxDevices ?? plan.maxDevices,
  };
}

class PlanNotFoundError extends Error {}

const listQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.enum(["TRIAL", "ACTIVE", "EXPIRED", "SUSPENDED"]).optional(),
});

const tenantSummarySelect = {
  id: true, name: true, slug: true, isActive: true,
  licenseStatus: true, subscriptionPlan: true, subscriptionStart: true, nextDueDate: true,
  maxBranches: true, maxUsers: true, maxDevices: true, createdAt: true,
  planId: true, plan: { select: planSummarySelect },
  // Employee, not User — Employee is this app's real PIN-based staff
  // account; User is an unrelated, unused legacy model.
  _count: { select: { employees: true, locations: true } },
} satisfies Prisma.TenantSelect;

// Plan carries Decimal price columns — normalise to numbers for the UI.
function serialiseTenantPlan<T extends { plan: { monthlyPrice: Prisma.Decimal; oneTimePrice: Prisma.Decimal; annualMaintenanceFee: Prisma.Decimal } | null }>(row: T) {
  return {
    ...row,
    plan: row.plan && {
      ...row.plan,
      monthlyPrice: Number(row.plan.monthlyPrice),
      oneTimePrice: Number(row.plan.oneTimePrice),
      annualMaintenanceFee: Number(row.plan.annualMaintenanceFee),
    },
  };
}

function loginUrlFor(slug: string): string | null {
  return env.APP_DOMAIN ? `https://${slug}.${env.APP_DOMAIN}` : null;
}

platformRouter.get("/tenants", async (req, res) => {
  const query = listQuerySchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid filters" }); return; }
  const tenants = await prisma.tenant.findMany({
    where: {
      ...(query.data.status ? { licenseStatus: query.data.status } : {}),
      ...(query.data.q ? { OR: [{ name: { contains: query.data.q, mode: "insensitive" } }, { slug: { contains: query.data.q, mode: "insensitive" } }] } : {}),
    },
    select: tenantSummarySelect,
    orderBy: { createdAt: "desc" },
  });
  res.status(200).json({
    tenants: tenants.map(({ _count, ...tenant }) => ({
      ...serialiseTenantPlan(tenant),
      employeeCount: _count.employees,
      locationCount: _count.locations,
    })),
  });
});

platformRouter.post("/tenants", async (req, res) => {
  const parsed = createTenantSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid tenant details", details: parsed.error.flatten() }); return; }
  const data = parsed.data;

  const existing = await prisma.tenant.findUnique({ where: { slug: data.slug }, select: { id: true } });
  if (existing) { res.status(409).json({ error: "That subdomain is already taken" }); return; }

  const nextDueDate = data.trialDays ? new Date(Date.now() + data.trialDays * 24 * 60 * 60 * 1000) : null;

  // Limits come from the (required) plan; explicit values in the request
  // still override.
  let snapshot: { subscriptionPlan: string; maxBranches: number; maxUsers: number; maxDevices: number };
  try {
    snapshot = await planSnapshotPatch(data.planId, data);
  } catch (error) {
    if (error instanceof PlanNotFoundError) { res.status(400).json({ error: "That plan no longer exists" }); return; }
    throw error;
  }

  try {
    const { tenant, bootstrap } = await prisma.$transaction(async (tx) => {
      const created = await tx.tenant.create({
        data: {
          name: data.name,
          slug: data.slug,
          licenseStatus: "TRIAL",
          planId: data.planId,
          subscriptionPlan: snapshot.subscriptionPlan,
          maxBranches: snapshot.maxBranches,
          maxUsers: snapshot.maxUsers,
          maxDevices: snapshot.maxDevices,
          nextDueDate,
        },
      });
      const bootstrapResult = await provisionTenantBootstrap(tx, {
        tenantId: created.id,
        businessName: data.name,
        businessType: data.businessType,
        currency: data.currency,
        contactEmail: data.contactEmail,
        modules: data.modules,
      });
      return { tenant: created, bootstrap: bootstrapResult };
    });

    res.status(201).json({
      tenant,
      // The one and only time this PIN is ever surfaced — the platform UI
      // must show it prominently with a copy affordance right here.
      bootstrapLogin: { employeeCode: bootstrap.bootstrapEmployeeCode, pin: bootstrap.bootstrapPin },
      loginUrl: loginUrlFor(tenant.slug),
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "That subdomain is already taken" }); return; }
    throw error;
  }
});

platformRouter.get("/tenants/:id", async (req, res) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.params.id },
    include: {
      businessProfile: true,
      plan: { select: planSummarySelect },
      tenantModules: { where: { isEnabled: true }, select: { moduleKey: true } },
      _count: { select: { employees: true, locations: true, roles: true } },
    },
  });
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
  const { tenantModules, _count, ...rest } = tenant;
  const moduleKeys = tenantModules.map((m) => m.moduleKey);
  res.status(200).json({
    tenant: {
      ...serialiseTenantPlan(rest),
      moduleKeys,
      moduleGroups: moduleGroupsFrom(moduleKeys),
      employeeCount: _count.employees,
      locationCount: _count.locations,
      roleCount: _count.roles,
      loginUrl: loginUrlFor(tenant.slug),
    },
  });
});

/** The only way to flip Room Management / Sales / Services after creation —
 * everything else a tenant has (Products, Store, HR, Reports, Customers,
 * Accounting) is common infrastructure and never toggled. Self-healing: also
 * upserts the common keys to enabled, so a tenant provisioned before a given
 * key existed (e.g. Service Center, added after some tenants were created)
 * gets it the first time an admin touches this tenant's modules at all. */
platformRouter.patch("/tenants/:id/modules", async (req, res) => {
  const parsed = modulesSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid modules", details: parsed.error.flatten() }); return; }
  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  await prisma.$transaction(async (tx) => {
    for (const moduleKey of MODULE_KEYS) {
      const isEnabled = GROUPED_KEY_SET.has(moduleKey)
        ? (MODULE_GROUP_KEYS.rooms as readonly string[]).includes(moduleKey) ? parsed.data.rooms
          : (MODULE_GROUP_KEYS.sales as readonly string[]).includes(moduleKey) ? parsed.data.sales
          : parsed.data.services
        : true;
      await tx.tenantModule.upsert({
        where: { tenantId_moduleKey: { tenantId: tenant.id, moduleKey } },
        update: { isEnabled },
        create: { tenantId: tenant.id, moduleKey, isEnabled },
      });
    }
  });

  const updated = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenant.id },
    include: { businessProfile: true, plan: { select: planSummarySelect }, tenantModules: { where: { isEnabled: true }, select: { moduleKey: true } }, _count: { select: { employees: true, locations: true, roles: true } } },
  });
  const { tenantModules, _count, ...rest } = updated;
  const moduleKeys = tenantModules.map((m) => m.moduleKey);
  res.status(200).json({
    tenant: {
      ...serialiseTenantPlan(rest),
      moduleKeys,
      moduleGroups: moduleGroupsFrom(moduleKeys),
      employeeCount: _count.employees,
      locationCount: _count.locations,
      roleCount: _count.roles,
      loginUrl: loginUrlFor(updated.slug),
    },
  });
});

/**
 * Updates plan/limits/license status/activation. Deliberately kept as one
 * flexible PATCH rather than separate endpoints per field, but the fields
 * fall into two groups the platform UI must keep visually and behaviorally
 * separate:
 *   - licenseStatus: the SOFT signal (drives only a warning banner inside
 *     the tenant's own app — see LicenseBanner.tsx). Use this for
 *     "suspended for non-payment," "expired," "back to active."
 *   - isActive: HARD — /tenant/resolve already filters on it, so flipping
 *     this to false immediately 404s the tenant's subdomain, blocking
 *     login entirely. This is "deactivate this workspace," not a billing
 *     status, and the UI must present it as a distinct danger-zone action.
 */
platformRouter.patch("/tenants/:id", async (req, res) => {
  const parsed = updateTenantSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid update", details: parsed.error.flatten() }); return; }

  // Switching to a plan re-applies its limits into the snapshot, unless the
  // same request also passes explicit limit values (override wins).
  // planId: null detaches without touching the snapshot.
  const data: Prisma.TenantUncheckedUpdateInput = { ...parsed.data };
  if (typeof parsed.data.planId === "string") {
    try {
      Object.assign(data, await planSnapshotPatch(parsed.data.planId, parsed.data));
    } catch (error) {
      if (error instanceof PlanNotFoundError) { res.status(400).json({ error: "That plan no longer exists" }); return; }
      throw error;
    }
  }

  try {
    const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data });
    res.status(200).json({ tenant });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") { res.status(404).json({ error: "Tenant not found" }); return; }
    throw error;
  }
});

// Free-form contact / business details, all optional — edited from the
// tenant's Profile card in the admin app. `tenantName` updates the Tenant
// row itself; everything else lands on its BusinessProfile. Empty strings
// clear a field (stored as NULL).
const optionalText = (max: number) => z.string().trim().max(max).optional();
const optionalEmail = z.union([z.string().trim().toLowerCase().email(), z.literal("")]).optional();

const updateProfileSchema = z.object({
  tenantName: z.string().trim().min(2).max(120).optional(),
  // The routable subdomain label (<slug>.APP_DOMAIN). Same rules/reserved
  // list as at creation — kept short by the operator, not auto-derived.
  slug: slugSchema.optional(),
  businessName: z.string().trim().min(2).max(120).optional(),
  businessType: z.enum(["RESTAURANT", "CAFE", "HOTEL", "MOTEL", "CLUB"]).optional(),
  currency: z.enum(["KES", "UGX", "TZS", "USD"]).optional(),
  email: optionalEmail,
  primaryPhone: optionalText(40),
  alternativePhone: optionalText(40),
  website: optionalText(200),
  registrationNumber: optionalText(80),
  kraPin: optionalText(40),
  ownerName: optionalText(120),
  ownerPhone: optionalText(40),
  ownerEmail: optionalEmail,
  country: optionalText(80),
  county: optionalText(80),
  city: optionalText(80),
  address: optionalText(400),
});

platformRouter.patch("/tenants/:id/profile", async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid profile", details: parsed.error.flatten() }); return; }

  const { tenantName, slug, ...profile } = parsed.data;
  // "" → null so a cleared field actually clears.
  const profileData = Object.fromEntries(
    Object.entries(profile).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v === "" ? null : v]),
  );
  const tenantData = {
    ...(tenantName ? { name: tenantName } : {}),
    ...(slug ? { slug } : {}),
  };

  try {
    await prisma.$transaction(async (tx) => {
      if (Object.keys(tenantData).length) await tx.tenant.update({ where: { id: req.params.id }, data: tenantData });
      await tx.businessProfile.update({ where: { tenantId: req.params.id }, data: profileData });
    });
    res.status(200).json({ ok: true });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "That subdomain is already taken" }); return; }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") { res.status(404).json({ error: "Tenant not found" }); return; }
    throw error;
  }
});
