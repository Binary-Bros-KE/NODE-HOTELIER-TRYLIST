import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { loadActor } from "../../lib/housekeeping.js";
import { decryptSecret, encryptSecret, maskSecret } from "../../lib/secretBox.js";

// Locations are core tenant configuration (which selling points exist),
// not tied to any one operational module, so this router — like
// business-profile — is intentionally not gated by requireModule.
export const locationsRouter = Router();

const LOCATION_TYPES = ["RECEPTION", "RESTAURANT", "CAFE", "BAKERY", "BAR", "GYM", "SPA", "STORE", "SHOP", "HOUSEKEEPING"] as const;
const SERVE_MODES = ["KITCHEN", "COUNTER", "DIRECT"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalDocText = z.preprocess(blankToUndefined, z.string().trim().max(2000).optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());
const optionalEmail = z.preprocess(blankToUndefined, z.email().optional());
const optionalTime = z.preprocess(blankToUndefined, z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM").optional());

// Only name is required — everything else here just makes a location easier
// to identify and reach, not something the POS filtering logic depends on.
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(LOCATION_TYPES),
  description: optionalText(500),
  address: optionalText(255),
  managerId: optionalId,
  primaryPhone: optionalText(30),
  secondaryPhone: optionalText(30),
  email: optionalEmail,
  openingTime: optionalTime,
  closingTime: optionalTime,
  isActive: z.boolean().default(true),
  canSellRooms: z.boolean().default(true),
  canSellMenu: z.boolean().default(true),
  canSellServices: z.boolean().default(true),
  canSellProducts: z.boolean().default(true),
  serveMode: z.enum(SERVE_MODES).default("KITCHEN"),
  // Kitchen must get its ingredients dispatched by a store before starting a ticket.
  requireStoreDispatch: z.boolean().default(false),
  // Print the store's dispatch slip automatically when an order is posted (else the storekeeper prints it).
  dispatchAutoPrint: z.boolean().default(true),
  dispatchFromLocationId: z.string().cuid().nullable().optional(),
  // Printed on the matching document for orders/invoices/quotations from
  // this location — e.g. a branch-specific thank-you note or return policy.
  receiptHeader: optionalDocText,
  receiptFooter: optionalDocText,
  invoiceHeader: optionalDocText,
  invoiceFooter: optionalDocText,
  quotationHeader: optionalDocText,
  quotationFooter: optionalDocText,
});
const updateSchema = partialNoDefaults(createSchema);

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const locationFields = {
  id: true,
  name: true,
  type: true,
  description: true,
  address: true,
  managerId: true,
  manager: { select: { id: true, firstName: true, lastName: true } },
  primaryPhone: true,
  secondaryPhone: true,
  email: true,
  openingTime: true,
  closingTime: true,
  isActive: true,
  canSellRooms: true,
  canSellMenu: true,
  canSellServices: true,
  canSellProducts: true,
  serveMode: true,
  requireStoreDispatch: true,
  dispatchAutoPrint: true,
  dispatchFromLocationId: true,
  receiptHeader: true,
  receiptFooter: true,
  invoiceHeader: true,
  invoiceFooter: true,
  quotationHeader: true,
  quotationFooter: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { menuItems: true, employees: true } },
} as const;

async function assertManagerInTenant(managerId: string | undefined, tenant: string) {
  if (!managerId) return;
  const manager = await prisma.employee.findFirst({ where: { id: managerId, tenantId: tenant }, select: { id: true } });
  if (!manager) throw Object.assign(new Error("Selected manager was not found"), { status: 400 });
}

locationsRouter.get("/", async (req, res) => {
  const locations = await prisma.location.findMany({ where: { tenantId: tenantId(req) }, select: locationFields, orderBy: { name: "asc" } });
  res.json({ locations });
});

/** The store that supplies a kitchen must be another location in the same property. */
async function assertSupplyingStore(id: string | null | undefined, tid: string, selfId?: string) {
  if (!id) return;
  if (id === selfId) throw Object.assign(new Error("A location cannot be supplied by itself"), { status: 400 });
  const store = await prisma.location.findFirst({ where: { id, tenantId: tid }, select: { id: true } });
  if (!store) throw Object.assign(new Error("Choose a store from this property to supply the kitchen"), { status: 400 });
}

locationsRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid location", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    await assertManagerInTenant(data.data.managerId, tid);
    await assertSupplyingStore(data.data.dispatchFromLocationId, tid);
    const location = await prisma.location.create({ data: { tenantId: tid, ...data.data }, select: locationFields });
    res.status(201).json({ location });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A location with this name already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

locationsRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid location", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    if (data.data.managerId !== undefined) await assertManagerInTenant(data.data.managerId, tid);
    await assertSupplyingStore(data.data.dispatchFromLocationId, tid, req.params.id);
    const updated = await prisma.location.updateMany({ where: { id: req.params.id, tenantId: tid }, data: data.data });
    if (!updated.count) { res.status(404).json({ error: "Location not found" }); return; }
    const location = await prisma.location.findUniqueOrThrow({ where: { id: req.params.id }, select: locationFields });
    res.json({ location });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A location with this name already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

locationsRouter.delete("/:id", async (req, res) => {
  const tid = tenantId(req);
  const existing = await prisma.location.findFirst({
    where: { id: req.params.id, tenantId: tid },
    select: { id: true, _count: { select: { employees: true, productStocks: true, inventoryMovements: true } } },
  });
  if (!existing) { res.status(404).json({ error: "Location not found" }); return; }
  if (existing._count.employees > 0) { res.status(409).json({ error: "Reassign or unassign its employees first" }); return; }
  // Stock/movement history is never discarded (same append-only discipline
  // as the rest of the ledger) — a location that's ever held stock can be
  // deactivated but not deleted.
  if (existing._count.productStocks > 0 || existing._count.inventoryMovements > 0) {
    res.status(409).json({ error: "This location has recorded stock activity and can't be deleted — deactivate it instead" });
    return;
  }
  // Menu items, services, and past orders just lose the association
  // (SetNull) — an item with no locations is unallocated (sellable
  // everywhere), and historical orders keep their own record regardless.
  await prisma.location.delete({ where: { id: existing.id } });
  res.status(204).send();
});

// ============================================================================
// M-Pesa (Safaricom Daraja) STK push config — one per location, deliberately:
// each outlet has its own Paybill/Till and its own Daraja app credentials.
// Reading/writing is supervisor-only (real production secrets); secrets are
// stored encrypted (lib/secretBox.ts) and never returned in full.
// ============================================================================

const mpesaAccountTypes = ["PAYBILL", "TILL"] as const;
const mpesaEnvironments = ["SANDBOX", "PRODUCTION"] as const;
// Secrets are optional on write: blank means "leave the stored value alone" —
// a supervisor editing the shortcode shouldn't be forced to retype the
// consumer secret every time.
const mpesaConfigSchema = z.object({
  accountType: z.enum(mpesaAccountTypes),
  shortcode: z.string().trim().min(1).max(20),
  tillNumber: optionalText(20),
  passkey: optionalText(200),
  consumerKey: optionalText(200),
  consumerSecret: optionalText(200),
  environment: z.enum(mpesaEnvironments).default("SANDBOX"),
  isActive: z.boolean().default(true),
});

async function requireSupervisor(req: { tenantId?: string; userId?: string }) {
  const actor = await loadActor(req.tenantId, req.userId);
  if (!actor.isManager) throw Object.assign(new Error("Only a supervisor can view or change M-Pesa settings"), { status: 403 });
}

function maskedMpesaConfig(config: {
  accountType: string; shortcode: string; tillNumber: string | null; environment: string; isActive: boolean;
  passkeyEncrypted: string; consumerKeyEncrypted: string; consumerSecretEncrypted: string;
} | null) {
  if (!config) return null;
  return {
    accountType: config.accountType,
    shortcode: config.shortcode,
    tillNumber: config.tillNumber,
    environment: config.environment,
    isActive: config.isActive,
    passkeyMasked: maskSecret(decryptSecret(config.passkeyEncrypted)),
    consumerKeyMasked: maskSecret(decryptSecret(config.consumerKeyEncrypted)),
    consumerSecretMasked: maskSecret(decryptSecret(config.consumerSecretEncrypted)),
  };
}

locationsRouter.get("/:id/mpesa-config", async (req, res, next) => {
  try {
    await requireSupervisor(req);
    const tid = tenantId(req);
    const config = await prisma.locationMpesaConfig.findFirst({ where: { locationId: req.params.id, tenantId: tid } });
    res.json({ config: maskedMpesaConfig(config) });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

locationsRouter.put("/:id/mpesa-config", async (req, res, next) => {
  const data = mpesaConfigSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid M-Pesa settings", details: data.error.flatten() }); return; }
  try {
    await requireSupervisor(req);
    const tid = tenantId(req);
    const location = await prisma.location.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!location) { res.status(404).json({ error: "Location not found" }); return; }
    const existing = await prisma.locationMpesaConfig.findUnique({ where: { locationId: location.id } });
    if (!existing && (!data.data.passkey || !data.data.consumerKey || !data.data.consumerSecret)) {
      res.status(400).json({ error: "Enter the passkey, consumer key and consumer secret to set up M-Pesa for this location" });
      return;
    }
    const { passkey, consumerKey, consumerSecret, ...rest } = data.data;
    const config = await prisma.locationMpesaConfig.upsert({
      where: { locationId: location.id },
      create: {
        tenantId: tid, locationId: location.id, ...rest,
        passkeyEncrypted: encryptSecret(passkey!), consumerKeyEncrypted: encryptSecret(consumerKey!), consumerSecretEncrypted: encryptSecret(consumerSecret!),
        createdBy: req.userId, updatedBy: req.userId,
      },
      update: {
        ...rest,
        ...(passkey ? { passkeyEncrypted: encryptSecret(passkey) } : {}),
        ...(consumerKey ? { consumerKeyEncrypted: encryptSecret(consumerKey) } : {}),
        ...(consumerSecret ? { consumerSecretEncrypted: encryptSecret(consumerSecret) } : {}),
        updatedBy: req.userId,
      },
    });
    res.json({ config: maskedMpesaConfig(config) });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

/** Decrypted credentials for actually calling Safaricom — used by the STK
 * push routes, never exposed over the API. Returns null when unconfigured or
 * disabled, so callers can give one clear "M-Pesa isn't set up here" error. */
export async function resolveMpesaCredentials(tid: string, locationId: string) {
  const config = await prisma.locationMpesaConfig.findFirst({ where: { tenantId: tid, locationId, isActive: true } });
  if (!config) return null;
  return {
    environment: config.environment,
    accountType: config.accountType,
    shortcode: config.shortcode,
    tillNumber: config.tillNumber,
    passkey: decryptSecret(config.passkeyEncrypted),
    consumerKey: decryptSecret(config.consumerKeyEncrypted),
    consumerSecret: decryptSecret(config.consumerSecretEncrypted),
  };
}
