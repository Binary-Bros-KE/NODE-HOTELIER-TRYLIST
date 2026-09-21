import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { partialNoDefaults } from "../../lib/zod.js";

export const servicesRouter = Router();

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
// null = "not set": cost not costed, tax inherited from the business default.
const nullableCost = z.preprocess(blankToNull, z.coerce.number().min(0).max(9_999_999).nullable());
const nullableRate = z.preprocess(blankToNull, z.coerce.number().min(0).max(100).nullable());
const nullableEnum = <T extends readonly [string, ...string[]]>(values: T) => z.preprocess(blankToNull, z.enum(values).nullable());

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  categoryId: z.string().cuid(),
  unitId: z.string().cuid(),
  price: z.coerce.number().nonnegative(),
  cost: nullableCost.optional(),
  // Same tax model as menu items: all null = business default; else an override.
  taxRate: nullableRate.optional(),
  taxMode: nullableEnum(["INCLUSIVE", "EXCLUSIVE"] as const).optional(),
  taxTreatment: nullableEnum(["STANDARD", "ZERO_RATED", "EXEMPT"] as const).optional(),
  description: optionalText(500),
  isActive: z.boolean().default(true),
  // Empty = unallocated = sellable at every location (the default) —
  // identical convention to MenuItem.locationIds.
  locationIds: z.array(z.string().cuid()).default([]),
});
const updateSchema = partialNoDefaults(createSchema);

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const serviceInclude = { category: { select: { id: true, name: true } }, unit: { select: { id: true, name: true } }, locations: { select: { id: true, name: true } } } as const;

async function assertLocationsInTenant(locationIds: string[], tid: string) {
  if (!locationIds.length) return;
  const count = await prisma.location.count({ where: { id: { in: locationIds }, tenantId: tid } });
  if (count !== new Set(locationIds).size) throw Object.assign(new Error("Every location must belong to this property"), { status: 400 });
}

async function assertCategoryInTenant(categoryId: string, tid: string) {
  const category = await prisma.serviceCategory.findFirst({ where: { id: categoryId, tenantId: tid }, select: { id: true } });
  if (!category) throw Object.assign(new Error("Choose a valid service category"), { status: 400 });
}

async function assertUnitInTenant(unitId: string, tid: string) {
  const unit = await prisma.unitOfMeasure.findFirst({ where: { id: unitId, tenantId: tid }, select: { id: true } });
  if (!unit) throw Object.assign(new Error("Choose a valid unit of measure"), { status: 400 });
}

servicesRouter.get("/", async (req, res) => {
  const services = await prisma.service.findMany({ where: { tenantId: tenantId(req) }, include: serviceInclude, orderBy: { name: "asc" } });
  res.json({ services });
});

servicesRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid service", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    await Promise.all([assertCategoryInTenant(data.data.categoryId, tid), assertUnitInTenant(data.data.unitId, tid), assertLocationsInTenant(data.data.locationIds, tid)]);
    const { locationIds, ...fields } = data.data;
    const service = await prisma.service.create({ data: { tenantId: tid, ...fields, locations: { connect: locationIds.map((id) => ({ id })) } }, include: serviceInclude });
    res.status(201).json({ service });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A service with this name already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

servicesRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid service", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    if (data.data.categoryId) await assertCategoryInTenant(data.data.categoryId, tid);
    if (data.data.unitId) await assertUnitInTenant(data.data.unitId, tid);
    if (data.data.locationIds) await assertLocationsInTenant(data.data.locationIds, tid);
    const { locationIds, ...fields } = data.data;
    const existing = await prisma.service.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Service not found" }); return; }
    const service = await prisma.service.update({
      where: { id: existing.id },
      data: { ...fields, ...(locationIds ? { locations: { set: locationIds.map((id) => ({ id })) } } : {}) },
      include: serviceInclude,
    });
    res.json({ service });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A service with this name already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

servicesRouter.delete("/:id", async (req, res, next) => {
  const tid = tenantId(req);
  try {
    // Sold services are part of receipts and reports - they can only be deactivated.
    // Checked up front: the driver adapter doesn't surface a foreign-key violation as a Prisma known error.
    const sold = await prisma.posOrderItem.count({ where: { serviceId: req.params.id, order: { tenantId: tid } } });
    if (sold > 0) { res.status(409).json({ error: "This service has been sold, so it can't be deleted. Deactivate it instead." }); return; }
    const deleted = await prisma.service.deleteMany({ where: { id: req.params.id, tenantId: tid } });
    if (!deleted.count) { res.status(404).json({ error: "Service not found" }); return; }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
