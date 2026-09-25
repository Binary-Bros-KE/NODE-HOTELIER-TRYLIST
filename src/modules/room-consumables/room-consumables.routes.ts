import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { resolveEffectiveLocation } from "../../lib/location.js";
import { nextRoomConsumableUsageNo } from "../../lib/sequence.js";
import { InsufficientStockError, recordStockMovement } from "../../lib/stockLedger.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { HousekeepingError, loadActor } from "../../lib/housekeeping.js";

export const roomConsumablesRouter = Router();
roomConsumablesRouter.use(requireModule("HOUSEKEEPING"));

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());
const optionalDate = z.preprocess(blankToUndefined, z.coerce.date().optional());

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const standardItemSchema = z.object({
  productId: z.string().trim().min(1),
  quantity: z.coerce.number().positive().max(1000000),
  isActive: z.boolean().default(true),
});

const standardsBodySchema = z.object({
  items: z.array(standardItemSchema).default([]),
});

const standardsQuerySchema = z.object({
  roomTypeId: optionalId,
  activeOnly: z.preprocess(blankToUndefined, z.coerce.boolean().optional()),
});

// Housekeeping records what LEFT the room (used by a guest, expired, damaged) and what they put back.
// Replacing is never automatic: only what is recorded here changes the room's count, and the count
// can never go above the room type's maximum. `quantity` is the old name for `replaced`.
const usageItemSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" && "quantity" in raw && !("replaced" in raw) ? { ...(raw as object), replaced: (raw as { quantity: unknown }).quantity } : raw),
  z.object({
    productId: z.string().trim().min(1),
    used: z.coerce.number().min(0).max(1000000).default(0),
    replaced: z.coerce.number().min(0).max(1000000).default(0),
  }).refine((v) => v.used > 0 || v.replaced > 0, { message: "Enter how many were used or replaced", path: ["used"] }),
);

const usageBodySchema = z.object({
  roomId: z.string().trim().min(1),
  taskId: optionalId,
  locationId: optionalId,
  note: optionalText(500),
  items: z.array(usageItemSchema).min(1),
});

const usageQuerySchema = z.object({
  roomId: optionalId,
  taskId: optionalId,
  locationId: optionalId,
  productId: optionalId,
  from: optionalDate,
  to: optionalDate,
  page: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(1)),
  pageSize: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(200).default(50)),
});

const productsQuerySchema = z.object({
  locationId: optionalId,
  search: optionalText(120),
  categoryId: optionalId,
  inStockOnly: z.coerce.boolean().default(true),
  page: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(1)),
  pageSize: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(200).default(50)),
});

const productSelect = {
  id: true,
  name: true,
  sku: true,
  barcode: true,
  unit: true,
  packSize: true,
  packLabel: true,
  unitCost: true,
  category: { select: { id: true, name: true } },
  packUnit: { select: { id: true, name: true, systemKey: true } },
} as const;

const standardInclude = {
  roomType: { select: { id: true, name: true } },
  product: { select: productSelect },
} as const;

const usageInclude = {
  room: { select: { id: true, number: true, name: true, roomType: { select: { id: true, name: true } } } },
  task: { select: { id: true, taskNo: true, status: true } },
  location: { select: { id: true, name: true, type: true } },
  employee: { select: { id: true, firstName: true, lastName: true } },
  items: {
    include: {
      product: { select: productSelect },
      movement: { select: { id: true, quantity: true, balanceBefore: true, balanceAfter: true, value: true, occurredAt: true } },
    },
  },
} as const;

function ensureUniqueProducts(items: { productId: string }[]) {
  const ids = items.map((item) => item.productId);
  return new Set(ids).size === ids.length;
}

async function assertProductsInTenant(tid: string, productIds: string[]) {
  const products = await prisma.product.findMany({
    where: { tenantId: tid, id: { in: productIds }, isActive: true },
    select: { id: true },
  });
  if (products.length !== productIds.length) {
    throw Object.assign(new Error("Choose active products from this property"), { status: 400 });
  }
}

roomConsumablesRouter.get("/standards", async (req, res, next) => {
  try {
    const parsed = standardsQuerySchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: "Invalid filters", details: parsed.error.flatten() }); return; }
    const { roomTypeId, activeOnly } = parsed.data;
    const standards = await prisma.roomConsumableStandard.findMany({
      where: {
        tenantId: tenantId(req),
        ...(roomTypeId ? { roomTypeId } : {}),
        ...(activeOnly ? { isActive: true } : {}),
      },
      include: standardInclude,
      orderBy: [{ roomType: { name: "asc" } }, { product: { name: "asc" } }],
    });
    res.json({ standards });
  } catch (error) {
    next(error);
  }
});

roomConsumablesRouter.get("/standards/for-room/:roomId", async (req, res, next) => {
  try {
    const tid = tenantId(req);
    const room = await prisma.room.findFirst({
      where: { id: req.params.roomId, tenantId: tid },
      select: { id: true, number: true, name: true, roomTypeId: true, roomType: { select: { id: true, name: true } } },
    });
    if (!room) { res.status(404).json({ error: "Room not found" }); return; }
    const standards = await prisma.roomConsumableStandard.findMany({
      where: { tenantId: tid, roomTypeId: room.roomTypeId, isActive: true },
      include: standardInclude,
      orderBy: { product: { name: "asc" } },
    });
    res.json({ room, standards });
  } catch (error) {
    next(error);
  }
});

roomConsumablesRouter.put("/standards/:roomTypeId", async (req, res, next) => {
  try {
    // The maximum a room may hold is a supervisor decision - housekeepers can not raise it to get around the cap.
    const actor = await loadActor(req.tenantId, req.userId);
    if (!actor.isManager) { res.status(403).json({ error: "Only a supervisor can set the maximum per room" }); return; }
    const parsed = standardsBodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid room consumables", details: parsed.error.flatten() }); return; }
    if (!ensureUniqueProducts(parsed.data.items)) { res.status(400).json({ error: "Each product can only appear once" }); return; }

    const tid = tenantId(req);
    const roomType = await prisma.roomType.findFirst({ where: { id: req.params.roomTypeId, tenantId: tid }, select: { id: true } });
    if (!roomType) { res.status(404).json({ error: "Room type not found" }); return; }

    const productIds = parsed.data.items.map((item) => item.productId);
    if (productIds.length) await assertProductsInTenant(tid, productIds);

    await prisma.$transaction(async (tx) => {
      await tx.roomConsumableStandard.deleteMany({
        where: { tenantId: tid, roomTypeId: roomType.id, productId: { notIn: productIds } },
      });
      for (const item of parsed.data.items) {
        await tx.roomConsumableStandard.upsert({
          where: { tenantId_roomTypeId_productId: { tenantId: tid, roomTypeId: roomType.id, productId: item.productId } },
          create: { tenantId: tid, roomTypeId: roomType.id, productId: item.productId, quantity: item.quantity, isActive: item.isActive },
          update: { quantity: item.quantity, isActive: item.isActive },
        });
      }
    });

    const standards = await prisma.roomConsumableStandard.findMany({
      where: { tenantId: tid, roomTypeId: roomType.id },
      include: standardInclude,
      orderBy: { product: { name: "asc" } },
    });
    res.json({ standards });
  } catch (error) {
    if (error instanceof HousekeepingError) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  }
});

roomConsumablesRouter.get("/products", async (req, res, next) => {
  try {
    const parsed = productsQuerySchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: "Invalid filters", details: parsed.error.flatten() }); return; }
    const { locationId, search, categoryId, inStockOnly, page, pageSize } = parsed.data;
    const tid = tenantId(req);
    const resolved = await resolveEffectiveLocation(tid, req.userId, locationId);
    if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
    if (!resolved.location) { res.status(400).json({ error: "Choose which location these room supplies come from" }); return; }

    const where: Prisma.ProductWhereInput = {
      tenantId: tid,
      isActive: true,
      ...(inStockOnly ? { stocks: { some: { tenantId: tid, locationId: resolved.location.id, quantity: { gt: 0 } } } } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(search
        ? { OR: [
            { name: { contains: search, mode: "insensitive" } },
            { sku: { contains: search, mode: "insensitive" } },
            { barcode: { contains: search, mode: "insensitive" } },
          ] }
        : {}),
    };

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        select: {
          ...productSelect,
          stocks: { where: { tenantId: tid, locationId: resolved.location.id }, select: { quantity: true } },
        },
        orderBy: { name: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({
      location: resolved.location,
      products: products.map((product) => ({
        ...product,
        stockOnHand: product.stocks[0]?.quantity ?? 0,
        stocks: undefined,
      })),
      pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (error) {
    next(error);
  }
});

roomConsumablesRouter.post("/usages", async (req, res, next) => {
  try {
    const parsed = usageBodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid room consumable usage", details: parsed.error.flatten() }); return; }
    if (!ensureUniqueProducts(parsed.data.items)) { res.status(400).json({ error: "Each product can only appear once" }); return; }

    const tid = tenantId(req);
    const { roomId, taskId, locationId, note, items } = parsed.data;
    const resolved = await resolveEffectiveLocation(tid, req.userId, locationId);
    if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
    if (!resolved.location) { res.status(400).json({ error: "Choose which location these room supplies come from" }); return; }
    const location = resolved.location;

    const room = await prisma.room.findFirst({ where: { id: roomId, tenantId: tid }, select: { id: true, number: true } });
    if (!room) { res.status(404).json({ error: "Room not found" }); return; }
    if (taskId) {
      const task = await prisma.housekeepingTask.findFirst({ where: { id: taskId, tenantId: tid }, select: { id: true, roomId: true } });
      if (!task) { res.status(404).json({ error: "Housekeeping task not found" }); return; }
      if (task.roomId && task.roomId !== room.id) { res.status(400).json({ error: "This housekeeping task belongs to a different room" }); return; }
    }

    const productIds = items.map((item) => item.productId);
    await assertProductsInTenant(tid, productIds);
    const productLabels = new Map(
      (await prisma.product.findMany({ where: { tenantId: tid, id: { in: productIds } }, select: { id: true, name: true } }))
        .map((product) => [product.id, product.name]),
    );
    const usageNo = await nextRoomConsumableUsageNo(tid);

    const usage = await prisma.$transaction(async (tx) => {
      const roomFull = await tx.room.findUniqueOrThrow({ where: { id: room.id }, select: { roomTypeId: true } });
      const [standards, stocks] = await Promise.all([
        tx.roomConsumableStandard.findMany({ where: { tenantId: tid, roomTypeId: roomFull.roomTypeId, isActive: true, productId: { in: productIds } } }),
        tx.roomConsumableStock.findMany({ where: { tenantId: tid, roomId: room.id, productId: { in: productIds } } }),
      ]);
      const maxBy = new Map(standards.map((s) => [s.productId, Number(s.quantity)]));
      const stockBy = new Map(stocks.map((s) => [s.productId, Number(s.quantity)]));
      const fail = (message: string) => Object.assign(new Error(message), { status: 400 });
      const round3 = (n: number) => Math.round(n * 1000) / 1000;

      // Check every line against what the room holds and its maximum BEFORE anything is written.
      const plans = items.map((item) => {
        const name = productLabels.get(item.productId) ?? "item";
        const onHand = stockBy.get(item.productId) ?? 0;
        if (item.used > onHand + 0.0005) throw fail(`Room ${room.number} has only ${round3(onHand)} ${name} on record, so ${item.used} can't have been used`);
        const afterUse = round3(onHand - item.used);
        const after = round3(afterUse + item.replaced);
        if (item.replaced > 0) {
          const max = maxBy.get(item.productId);
          if (max === undefined) throw fail(`No maximum is set for ${name} in this room type - ask a supervisor to set it before it can be stocked`);
          if (after > max + 0.0005) throw fail(`Room ${room.number} can hold at most ${max} ${name}: it will have ${afterUse} after use, so you can replace at most ${round3(Math.max(0, max - afterUse))}`);
        }
        return { item, name, after };
      });

      const created = await tx.roomConsumableUsage.create({
        data: { tenantId: tid, usageNo, roomId: room.id, taskId: taskId ?? undefined, locationId: location.id, note, createdBy: req.userId },
      });
      const now = new Date();
      for (const { item, name, after } of plans) {
        let movementId: string | undefined;
        if (item.replaced > 0) {
          const movement = await recordStockMovement(tx, {
            tenantId: tid, productId: item.productId, locationId: location.id, type: "ROOM_CONSUMPTION", quantity: -item.replaced,
            note: note ?? `Room ${room.number} replenishment`, sourceType: "ROOM_CONSUMPTION", sourceRefId: created.id, performedBy: req.userId, label: name,
          });
          movementId = movement.id;
        }
        await tx.roomConsumableUsageItem.create({ data: { usageId: created.id, productId: item.productId, quantity: item.replaced, usedQuantity: item.used, movementId } });
        await tx.roomConsumableStock.upsert({
          where: { tenantId_roomId_productId: { tenantId: tid, roomId: room.id, productId: item.productId } },
          create: { tenantId: tid, roomId: room.id, productId: item.productId, quantity: after, firstPlacedAt: now, lastReplacedAt: now },
          update: { quantity: after, ...(item.replaced > 0 ? { lastReplacedAt: now } : {}) },
        });
      }
      return tx.roomConsumableUsage.findUniqueOrThrow({ where: { id: created.id }, include: usageInclude });
    });

    res.status(201).json({ usage });
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

roomConsumablesRouter.get("/usages", async (req, res, next) => {
  try {
    const parsed = usageQuerySchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: "Invalid filters", details: parsed.error.flatten() }); return; }
    const { roomId, taskId, locationId, productId, from, to, page, pageSize } = parsed.data;
    const tid = tenantId(req);
    let end = to;
    if (end) end = new Date(end.getTime() + (end.getUTCHours() === 0 && end.getUTCMinutes() === 0 ? 24 * 60 * 60 * 1000 - 1 : 0));

    const where: Prisma.RoomConsumableUsageWhereInput = {
      tenantId: tid,
      ...(roomId ? { roomId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(locationId ? { locationId } : {}),
      ...(from || end ? { createdAt: { ...(from ? { gte: from } : {}), ...(end ? { lte: end } : {}) } } : {}),
      ...(productId ? { items: { some: { productId } } } : {}),
    };

    const [total, usages] = await Promise.all([
      prisma.roomConsumableUsage.count({ where }),
      prisma.roomConsumableUsage.findMany({
        where,
        include: usageInclude,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    res.json({ usages, pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } });
  } catch (error) {
    next(error);
  }
});
