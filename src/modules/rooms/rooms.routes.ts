import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";

// Room inventory is shared with Reception: a room created here is immediately
// selectable for reservations, check-in, and check-out.
export const roomsRouter = Router();
roomsRouter.use(requireModule("ROOMS"));

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

// A room type is sold either at one price (baseRate + priceUnitId) or by
// rate variants, each with its own name, price and unit of measure. With
// variants the single price is meaningless and is stored as 0.
const rateSchema = z.object({ name: z.string().trim().min(1).max(60), price: z.coerce.number().nonnegative(), unitId: z.string().trim().min(1) });
const ratesSchema = z
  .array(rateSchema)
  .max(30)
  .refine((rates) => new Set(rates.map((r) => r.name.toLowerCase())).size === rates.length, "Each rate needs a different name");

// NOTE: fields with .default() must NOT also go through .partial() for
// updates — Zod re-applies the default whenever the key is simply absent
// from the input (not just when explicitly undefined), so a partial schema
// built from a defaults-bearing object silently resets every omitted
// default-bearing field on every PATCH. Create and update get separate
// schemas instead: defaults only apply on create, updates leave omitted
// fields untouched.
const roomSchema = z.object({
  number: z.string().trim().min(1).max(20),
  name: z.string().trim().max(80).optional(),
  roomTypeId: z.string().cuid(),
  floor: optionalText(30),
  wing: optionalText(30),
  notes: optionalText(500),
  capacity: z.coerce.number().int().min(1).default(2),
  // Omitted for room types sold by rate variant (their variants carry the price).
  nightlyRate: z.coerce.number().nonnegative().optional(),
  status: z.enum(["VACANT", "OCCUPIED", "OUT_OF_SERVICE"]).default("VACANT"),
  cleanliness: z.enum(["CLEAN", "DIRTY", "INSPECTING"]).default("CLEAN"),
});
const roomUpdateSchema = z.object({
  number: z.string().trim().min(1).max(20).optional(),
  name: optionalText(80),
  roomTypeId: z.string().cuid().optional(),
  floor: optionalText(30),
  wing: optionalText(30),
  notes: optionalText(500),
  capacity: z.coerce.number().int().min(1).optional(),
  nightlyRate: z.coerce.number().nonnegative().optional(),
  status: z.enum(["VACANT", "OCCUPIED", "OUT_OF_SERVICE"]).optional(),
  cleanliness: z.enum(["CLEAN", "DIRTY", "INSPECTING"]).optional(),
});
const roomTypeSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(240).optional(),
  capacity: z.coerce.number().int().min(1),
  baseRate: z.coerce.number().nonnegative().optional(),
  priceUnitId: z.string().trim().min(1).optional(),
  amenities: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  isActive: z.boolean().default(true),
  rates: ratesSchema.optional(),
});
const roomTypeUpdateSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  description: z.string().trim().max(240).optional(),
  capacity: z.coerce.number().int().min(1).optional(),
  baseRate: z.coerce.number().nonnegative().optional(),
  priceUnitId: z.string().trim().min(1).nullable().optional(),
  amenities: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  isActive: z.boolean().optional(),
  rates: ratesSchema.optional(),
});

function tenantId(req: { tenantId?: string }): string {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
}

async function assertActiveRoomType(roomTypeId: string, tid: string) {
  const type = await prisma.roomType.findFirst({ where: { id: roomTypeId, tenantId: tid, isActive: true }, select: { id: true } });
  if (!type) throw Object.assign(new Error("Choose an active room type from the property catalog"), { status: 400 });
}

const roomTypeFields = {
  id: true,
  name: true,
  description: true,
  capacity: true,
  baseRate: true,
  priceUnitId: true,
  priceUnit: { select: { id: true, name: true } },
  amenities: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
  updatedByEmployee: { select: { id: true, firstName: true, lastName: true } },
  rates: { select: { id: true, name: true, price: true, unitId: true, unit: { select: { id: true, name: true } } }, orderBy: { name: "asc" as const } },
} satisfies Prisma.RoomTypeSelect;

async function assertUnits(tid: string, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return;
  const found = await prisma.unitOfMeasure.count({ where: { tenantId: tid, id: { in: wanted } } });
  if (found !== wanted.length) throw Object.assign(new Error("Choose a unit of measure from your list"), { status: 400 });
}

roomsRouter.get("/types", async (req, res) => res.json({ types: await prisma.roomType.findMany({ where: { tenantId: tenantId(req) }, select: roomTypeFields, orderBy: [{ isActive: "desc" }, { name: "asc" }] }) }));

roomsRouter.post("/types", async (req, res, next) => {
  const parsed = roomTypeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid room type", details: parsed.error.flatten() }); return; }
  const { rates, baseRate, priceUnitId, ...data } = parsed.data;
  const tid = tenantId(req);
  try {
    const hasRates = Boolean(rates?.length);
    if (!hasRates && (baseRate === undefined || !priceUnitId)) { res.status(400).json({ error: "Set a price and unit of measure, or add at least one rate variant" }); return; }
    await assertUnits(tid, [priceUnitId, ...(rates ?? []).map((r) => r.unitId)]);
    const type = await prisma.$transaction(async (tx) => {
      const created = await tx.roomType.create({ data: { tenantId: tid, createdBy: req.userId, ...data, baseRate: hasRates ? 0 : baseRate ?? 0, priceUnitId: hasRates ? null : priceUnitId ?? null } });
      if (rates?.length) await tx.roomRate.createMany({ data: rates.map((r) => ({ tenantId: tid, roomTypeId: created.id, name: r.name, price: r.price, unitId: r.unitId, createdBy: req.userId })) });
      return tx.roomType.findUniqueOrThrow({ where: { id: created.id }, select: roomTypeFields });
    });
    res.status(201).json({ type });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "This room type already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

roomsRouter.patch("/types/:id", async (req, res, next) => {
  const parsed = roomTypeUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid room type", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const { rates, baseRate, priceUnitId, ...data } = parsed.data;
  const existing = await prisma.roomType.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { _count: { select: { rates: true } } } });
  if (!existing) { res.status(404).json({ error: "Room type not found" }); return; }
  try {
    const willHaveRates = rates !== undefined ? rates.length > 0 : existing._count.rates > 0;
    if (!willHaveRates && rates !== undefined && (baseRate === undefined || !priceUnitId)) { res.status(400).json({ error: "Set a price and unit of measure, or keep at least one rate variant" }); return; }
    await assertUnits(tid, [priceUnitId, ...(rates ?? []).map((r) => r.unitId)]);
    const type = await prisma.$transaction(async (tx) => {
      await tx.roomType.update({
        where: { id: existing.id },
        data: {
          ...data,
          updatedBy: req.userId,
          ...(willHaveRates ? { baseRate: 0, priceUnitId: null } : { ...(baseRate !== undefined ? { baseRate } : {}), ...(priceUnitId !== undefined ? { priceUnitId } : {}) }),
        },
      });
      if (rates !== undefined) {
        // Rates are matched by name so a rename keeps history only if the name is unchanged; removed variants are dropped (reservations keep their rateName snapshot).
        const keep = rates.map((r) => r.name);
        await tx.roomRate.deleteMany({ where: { roomTypeId: existing.id, ...(keep.length ? { name: { notIn: keep } } : {}) } });
        for (const r of rates) {
          await tx.roomRate.upsert({
            where: { roomTypeId_name: { roomTypeId: existing.id, name: r.name } },
            create: { tenantId: tid, roomTypeId: existing.id, name: r.name, price: r.price, unitId: r.unitId, createdBy: req.userId },
            update: { price: r.price, unitId: r.unitId, updatedBy: req.userId },
          });
        }
      }
      return tx.roomType.findUniqueOrThrow({ where: { id: existing.id }, select: roomTypeFields });
    });
    res.json({ type });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "This room type already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

roomsRouter.delete("/types/:id", async (req, res) => {
  const tid = tenantId(req);
  const existing = await prisma.roomType.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!existing) { res.status(404).json({ error: "Room type not found" }); return; }
  const used = await prisma.room.count({ where: { tenantId: tid, roomTypeId: existing.id } });
  if (used) { res.status(409).json({ error: "This room type is assigned to rooms; deactivate it instead" }); return; }
  await prisma.roomType.delete({ where: { id: existing.id } });
  res.status(204).send();
});

roomsRouter.get("/rooms", async (req, res) => {
  const rooms = await prisma.room.findMany({
    where: { tenantId: tenantId(req) },
    include: {
      roomType: { include: { priceUnit: { select: { id: true, name: true } }, rates: { select: { id: true, name: true, price: true, unit: { select: { id: true, name: true } } }, orderBy: { name: "asc" } } } },
      createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
      updatedByEmployee: { select: { id: true, firstName: true, lastName: true } },
      _count: { select: { reservations: true } },
      reservations: {
        where: { status: "CHECKED_IN" },
        include: { customer: true, folio: { include: { lineItems: true, payments: true } } },
      },
    },
    orderBy: { number: "asc" },
  });
  const summary = { total: rooms.length, vacant: rooms.filter((room) => room.status === "VACANT").length, occupied: rooms.filter((room) => room.status === "OCCUPIED").length, outOfService: rooms.filter((room) => room.status === "OUT_OF_SERVICE").length, dirty: rooms.filter((room) => room.cleanliness === "DIRTY").length };
  res.status(200).json({ rooms, summary });
});

roomsRouter.get("/rooms/:id", async (req, res) => {
  const room = await prisma.room.findFirst({
    where: { id: req.params.id, tenantId: tenantId(req) },
    include: {
      roomType: true,
      createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
      updatedByEmployee: { select: { id: true, firstName: true, lastName: true } },
      reservations: { include: { customer: true, posOrders: { include: { items: { include: { menuItem: true, addons: { include: { addon: true } } } } } } }, orderBy: { checkIn: "desc" }, take: 10 },
    },
  });
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }
  res.status(200).json({ room });
});

roomsRouter.post("/rooms", async (req, res, next) => {
  const parsed = roomSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid room", details: parsed.error.flatten() });
    return;
  }
  const tid = tenantId(req);
  try {
    await assertActiveRoomType(parsed.data.roomTypeId, tid);
    const rateCount = await prisma.roomRate.count({ where: { roomTypeId: parsed.data.roomTypeId } });
    if (rateCount === 0 && parsed.data.nightlyRate === undefined) { res.status(400).json({ error: "Set a price for this room" }); return; }
    const room = await prisma.room.create({ data: { tenantId: tid, createdBy: req.userId, ...parsed.data, nightlyRate: rateCount > 0 ? 0 : parsed.data.nightlyRate ?? 0 }, include: { roomType: true } });
    res.status(201).json({ room });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "This room number already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

roomsRouter.patch("/rooms/:id", async (req, res, next) => {
  const parsed = roomUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid room", details: parsed.error.flatten() });
    return;
  }
  const tid = tenantId(req);
  try {
    if (parsed.data.roomTypeId) await assertActiveRoomType(parsed.data.roomTypeId, tid);
    const updated = await prisma.room.updateMany({
      where: { id: req.params.id, tenantId: tid },
      data: { ...parsed.data, updatedBy: req.userId },
    });
    if (!updated.count) {
      res.status(404).json({ error: "Room not found" });
      return;
    }
    res.status(200).json({
      room: await prisma.room.findUniqueOrThrow({
        where: { id: req.params.id },
        include: {
          roomType: true,
          createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
          updatedByEmployee: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
    });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

roomsRouter.delete("/rooms/:id", async (req, res, next) => {
  try { const deleted = await prisma.room.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } }); if (!deleted.count) { res.status(404).json({ error: "Room not found" }); return; } res.status(204).send(); }
  catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") { res.status(409).json({ error: "Rooms with reservation history cannot be deleted; mark it out of service instead" }); return; } next(error); }
});
