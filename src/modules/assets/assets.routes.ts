import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { nextAssetNo, nextTransactionNo } from "../../lib/sequence.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { ensureSystemUnits } from "../../lib/systemUnits.js";
import { checkedPaymentReference } from "../../lib/paymentReferences.js";

// Durable, owned equipment (chairs, plates, cutlery) — registering it records ownership only; a purchase is opt-in and is capital invested —
// distinct from Product (never sold/consumed) and from Expense (the owner
// still wants the spend tracked in the Transaction ledger, just not lumped
// in with day-to-day incidental spend). No requireModule gate, matching the
// precedent set by expenses/payment-methods/transactions — none of those map
// onto the older ModuleKey enum either.
export const assetsRouter = Router();

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());
const optionalNumber = (min = 0) => z.preprocess(blankToUndefined, z.coerce.number().min(min).optional());

const createSchema = z.object({
  categoryId: optionalId,
  name: z.string().trim().min(1).max(150),
  description: optionalText(500),
  // Any of the tenant's units; omitted = the built-in "Each".
  unitId: optionalId,
  quantity: z.coerce.number().min(0).default(0),
  unitCost: optionalNumber(0),
  locationId: optionalId,
  roomId: optionalId,
  // Only meaningful when quantity + unitCost together represent a real
  // purchase to log — see the "was there money spent" check in POST /.
  // Registering an asset only records what the property already owns. It is a purchase (money
  // paid out, written to the ledger as capital invested) ONLY when the user says so explicitly.
  purchased: z.boolean().default(false),
  paymentMethodId: optionalId,
  reference: optionalText(120),
  notes: optionalText(500),
  isActive: z.boolean().default(true),
});
const updateSchema = partialNoDefaults(createSchema.omit({ quantity: true, purchased: true, paymentMethodId: true, reference: true }));

const movementSchema = z.object({
  type: z.enum(["RECEIPT", "ADJUSTMENT", "WRITE_OFF"]),
  quantity: z.coerce.number().finite().refine((value) => value !== 0, "Quantity cannot be zero"),
  unitCost: optionalNumber(0),
  purchased: z.boolean().default(false),
  paymentMethodId: optionalId,
  reference: optionalText(120),
  note: optionalText(500),
  occurredAt: z.coerce.date().optional(),
}).superRefine((value, context) => {
  if (value.type === "RECEIPT" && value.quantity < 0) {
    context.addIssue({ code: "custom", message: "Receipt quantity must be positive", path: ["quantity"] });
  }
  if (value.type === "WRITE_OFF" && value.quantity > 0) {
    context.addIssue({ code: "custom", message: "Write-off quantity must be negative", path: ["quantity"] });
  }
});

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const assetInclude = {
  unitRef: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  room: { select: { id: true, number: true, name: true, roomType: { select: { id: true, name: true } } } },
  createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
  updatedByEmployee: { select: { id: true, firstName: true, lastName: true } },
} as const;

/** The API keeps returning `unit` as the unit's name so screens and reports read it as before. */
function withUnit<T extends { unitRef?: { name: string } | null }>(asset: T) {
  return { ...asset, unit: asset.unitRef?.name ?? "" };
}

async function resolveUnitId(tid: string, unitId: string | undefined) {
  await ensureSystemUnits(prisma, tid);
  const unit = unitId
    ? await prisma.unitOfMeasure.findFirst({ where: { id: unitId, tenantId: tid }, select: { id: true } })
    : await prisma.unitOfMeasure.findFirst({ where: { tenantId: tid, systemKey: "EACH" }, select: { id: true } });
  if (!unit) throw Object.assign(new Error("Choose a unit of measure from this property"), { status: 400 });
  return unit.id;
}

async function resolvePaymentMethod(tid: string, paymentMethodId: string, reference: string | undefined) {
  const method = await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, tenantId: tid, isActive: true } });
  if (!method) throw Object.assign(new Error("Choose a valid, active payment method"), { status: 400 });
  const cleanReference = await checkedPaymentReference(prisma, tid, method, reference);
  return { method, reference: cleanReference };
}

assetsRouter.get("/", async (req, res) => {
  const query = z.object({
    search: optionalText(120),
    categoryId: optionalId,
    locationId: optionalId,
    roomId: optionalId,
    assignment: z.enum(["all", "rooms", "locations", "unassigned"]).default("all"),
    active: z.enum(["true", "false"]).optional(),
  }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid asset filters", details: query.error.flatten() }); return; }
  const { search, categoryId, locationId, roomId, assignment, active } = query.data;
  const tid = tenantId(req);
  const where: Prisma.AssetWhereInput = {
    tenantId: tid,
    ...(categoryId ? { categoryId } : {}),
    ...(locationId ? { locationId } : {}),
    ...(roomId ? { roomId } : {}),
    ...(assignment === "rooms" ? { roomId: { not: null } } : {}),
    ...(assignment === "locations" ? { roomId: null, locationId: { not: null } } : {}),
    ...(assignment === "unassigned" ? { roomId: null, locationId: null } : {}),
    ...(active ? { isActive: active === "true" } : {}),
    ...(search ? { OR: [
      { name: { contains: search, mode: "insensitive" } },
      { assetNo: { contains: search, mode: "insensitive" } },
      { room: { is: { number: { contains: search, mode: "insensitive" } } } },
    ] } : {}),
  };
  const assets = await prisma.asset.findMany({ where, include: assetInclude, orderBy: { name: "asc" } });
  const totalValue = assets.reduce((sum, a) => sum + Number(a.quantity) * Number(a.unitCost ?? 0), 0);
  res.json({ assets: assets.map(withUnit), summary: { total: assets.length, totalValue, roomAssets: assets.filter((a) => a.roomId).length } });
});

const CONDITIONS = ["WORKING", "NEEDS_REPAIR", "UNDER_REPAIR", "BROKEN", "MISSING"] as const;
const EXPIRING_SOON_DAYS = 7;

/** Everything in one room or location: fixed assets with their condition, and (rooms only) the consumables the
 * room should hold - how many it has against the maximum, when first placed / last replaced, and whether the
 * shelf life (last replaced + Product.shelfLifeDays) has run out. `issues` lists whatever needs attention. */
assetsRouter.get("/contents", async (req, res, next) => {
  try {
    const query = z.object({ roomId: optionalId, locationId: optionalId }).refine((v) => Boolean(v.roomId) !== Boolean(v.locationId), "Choose a room or a location").safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Choose a room or a location" }); return; }
    const tid = tenantId(req);
    const { roomId, locationId } = query.data;
    let target: { kind: "room" | "location"; id: string; label: string; sub: string | null };
    let roomTypeId: string | null = null;
    if (roomId) {
      const room = await prisma.room.findFirst({ where: { id: roomId, tenantId: tid }, select: { id: true, number: true, name: true, roomTypeId: true, roomType: { select: { name: true } } } });
      if (!room) { res.status(404).json({ error: "Room not found" }); return; }
      roomTypeId = room.roomTypeId;
      target = { kind: "room", id: room.id, label: `Room ${room.number}${room.name ? ` - ${room.name}` : ""}`, sub: room.roomType.name };
    } else {
      const location = await prisma.location.findFirst({ where: { id: locationId!, tenantId: tid }, select: { id: true, name: true, type: true } });
      if (!location) { res.status(404).json({ error: "Location not found" }); return; }
      target = { kind: "location", id: location.id, label: location.name, sub: location.type ?? null };
    }

    const assets = await prisma.asset.findMany({
      where: { tenantId: tid, isActive: true, ...(roomId ? { roomId } : { locationId, roomId: null }) },
      include: { unitRef: { select: { name: true } }, category: { select: { name: true } }, conditionUpdatedByEmployee: { select: { firstName: true, lastName: true } } },
      orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
    });
    const fixedAssets = assets.map((a) => ({
      id: a.id, assetNo: a.assetNo, name: a.name, category: a.category?.name ?? null, unit: a.unitRef.name, quantity: Number(a.quantity),
      condition: a.condition, affectedQuantity: a.affectedQuantity == null ? null : Number(a.affectedQuantity), conditionNote: a.conditionNote,
      conditionUpdatedAt: a.conditionUpdatedAt, conditionUpdatedBy: a.conditionUpdatedByEmployee ? `${a.conditionUpdatedByEmployee.firstName} ${a.conditionUpdatedByEmployee.lastName}`.trim() : null,
    }));

    const now = new Date();
    const consumables: {
      productId: string; name: string; unit: string; max: number | null; onHand: number; firstPlacedAt: Date | null; lastReplacedAt: Date | null;
      shelfLifeDays: number | null; expiresAt: Date | null; daysToExpiry: number | null;
      status: "OK" | "EMPTY" | "EXPIRED" | "EXPIRING_SOON" | "OVER_MAX" | "NO_MAX"; needed: number;
    }[] = [];
    if (roomId && roomTypeId) {
      const [standards, stocks] = await Promise.all([
        prisma.roomConsumableStandard.findMany({ where: { tenantId: tid, roomTypeId, isActive: true }, include: { product: { select: { id: true, name: true, unit: true, shelfLifeDays: true } } } }),
        prisma.roomConsumableStock.findMany({ where: { tenantId: tid, roomId }, include: { product: { select: { id: true, name: true, unit: true, shelfLifeDays: true } } } }),
      ]);
      const byProduct = new Map<string, { product: { id: string; name: string; unit: string; shelfLifeDays: number | null }; max: number | null; stock: (typeof stocks)[number] | null }>();
      for (const s of standards) byProduct.set(s.productId, { product: s.product, max: Number(s.quantity), stock: null });
      for (const st of stocks) {
        const existing = byProduct.get(st.productId);
        if (existing) existing.stock = st; else byProduct.set(st.productId, { product: st.product, max: null, stock: st });
      }
      for (const { product, max, stock } of byProduct.values()) {
        const onHand = stock ? Number(stock.quantity) : 0;
        const expiresAt = stock && product.shelfLifeDays && onHand > 0 ? new Date(stock.lastReplacedAt.getTime() + product.shelfLifeDays * 86_400_000) : null;
        const daysToExpiry = expiresAt ? Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000) : null;
        const status = expiresAt && expiresAt < now ? "EXPIRED" : max == null ? "NO_MAX" : onHand > max + 0.0005 ? "OVER_MAX" : expiresAt && (daysToExpiry ?? 99) <= EXPIRING_SOON_DAYS ? "EXPIRING_SOON" : onHand <= 0 ? "EMPTY" : "OK";
        consumables.push({
          productId: product.id, name: product.name, unit: product.unit, max, onHand: Math.round(onHand * 1000) / 1000,
          firstPlacedAt: stock?.firstPlacedAt ?? null, lastReplacedAt: stock?.lastReplacedAt ?? null,
          shelfLifeDays: product.shelfLifeDays, expiresAt, daysToExpiry, status,
          needed: max == null ? 0 : Math.round(Math.max(0, max - onHand) * 1000) / 1000,
        });
      }
      consumables.sort((a, b) => a.name.localeCompare(b.name));
    }

    const issues = [
      ...fixedAssets.filter((a) => a.condition !== "WORKING").map((a) => ({ kind: "ASSET" as const, severity: a.condition === "BROKEN" || a.condition === "MISSING" ? "high" as const : "medium" as const, title: a.name, detail: `${a.condition.replace("_", " ").toLowerCase()}${a.affectedQuantity != null ? ` (${a.affectedQuantity} of ${a.quantity})` : ""}${a.conditionNote ? ` - ${a.conditionNote}` : ""}` })),
      ...consumables.filter((c) => c.status === "EXPIRED").map((c) => ({ kind: "CONSUMABLE" as const, severity: "high" as const, title: c.name, detail: `expired ${c.expiresAt ? c.expiresAt.toISOString().slice(0, 10) : ""} - replace` })),
      ...consumables.filter((c) => c.status === "EXPIRING_SOON").map((c) => ({ kind: "CONSUMABLE" as const, severity: "medium" as const, title: c.name, detail: `expires in ${c.daysToExpiry} day${c.daysToExpiry === 1 ? "" : "s"}` })),
      ...consumables.filter((c) => c.status === "OVER_MAX").map((c) => ({ kind: "CONSUMABLE" as const, severity: "medium" as const, title: c.name, detail: `${c.onHand} in room, maximum is ${c.max}` })),
      ...consumables.filter((c) => c.status === "EMPTY").map((c) => ({ kind: "CONSUMABLE" as const, severity: "medium" as const, title: c.name, detail: "none in the room" })),
    ];
    res.json({
      target, fixedAssets, consumables, issues,
      summary: {
        fixedAssets: fixedAssets.length, notWorking: fixedAssets.filter((a) => a.condition !== "WORKING").length,
        consumableLines: consumables.length, expired: consumables.filter((c) => c.status === "EXPIRED").length, expiringSoon: consumables.filter((c) => c.status === "EXPIRING_SOON").length,
        empty: consumables.filter((c) => c.status === "EMPTY").length, issues: issues.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

const conditionSchema = z.object({
  condition: z.enum(CONDITIONS),
  affectedQuantity: optionalNumber(0.001),
  note: optionalText(300),
});

/** Anyone can report an asset's condition (housekeeping notices a broken TV); every change is logged. */
assetsRouter.patch("/:id/condition", async (req, res, next) => {
  const data = conditionSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid condition", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const asset = await prisma.asset.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
    const { condition, note } = data.data;
    const affected = condition === "WORKING" ? null : data.data.affectedQuantity ?? null;
    if (affected != null && affected > Number(asset.quantity)) { res.status(400).json({ error: `Only ${Number(asset.quantity)} ${asset.name} on record` }); return; }
    await prisma.$transaction(async (tx) => {
      await tx.asset.update({ where: { id: asset.id }, data: { condition, affectedQuantity: affected, conditionNote: condition === "WORKING" ? null : note ?? null, conditionUpdatedAt: new Date(), conditionUpdatedBy: req.userId, updatedBy: req.userId } });
      await tx.assetConditionLog.create({ data: { tenantId: tid, assetId: asset.id, fromCondition: asset.condition, toCondition: condition, affectedQuantity: affected, note, changedBy: req.userId } });
    });
    const updated = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id }, include: assetInclude });
    res.json({ asset: withUnit(updated) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.get("/reports/rooms", async (req, res) => {
  const query = z.object({
    roomId: optionalId,
    active: z.enum(["true", "false"]).default("true"),
  }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid room asset filters", details: query.error.flatten() }); return; }
  const tid = tenantId(req);
  const assets = await prisma.asset.findMany({
    where: {
      tenantId: tid,
      roomId: query.data.roomId ? query.data.roomId : { not: null },
      isActive: query.data.active === "true",
    },
    include: assetInclude,
    orderBy: [{ room: { number: "asc" } }, { name: "asc" }],
  });
  const rooms = Array.from(assets.reduce((map, asset) => {
    if (!asset.room) return map;
    const row = map.get(asset.room.id) ?? {
      room: asset.room,
      assetCount: 0,
      quantity: 0,
      value: 0,
      assets: [] as ReturnType<typeof withUnit<(typeof assets)[number]>>[],
    };
    row.assetCount += 1;
    row.quantity += Number(asset.quantity);
    row.value += Number(asset.quantity) * Number(asset.unitCost ?? 0);
    row.assets.push(withUnit(asset));
    map.set(asset.room.id, row);
    return map;
  }, new Map<string, { room: NonNullable<(typeof assets)[number]["room"]>; assetCount: number; quantity: number; value: number; assets: ReturnType<typeof withUnit<(typeof assets)[number]>>[] }>()).values());
  res.json({
    rooms,
    summary: {
      rooms: rooms.length,
      assets: assets.length,
      quantity: rooms.reduce((sum, room) => sum + room.quantity, 0),
      value: rooms.reduce((sum, room) => sum + room.value, 0),
    },
  });
});

assetsRouter.get("/:id", async (req, res) => {
  const asset = await prisma.asset.findFirst({
    where: { id: req.params.id, tenantId: tenantId(req) },
    include: { ...assetInclude, movements: { include: { paymentMethod: { select: { id: true, name: true } }, employee: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { occurredAt: "desc" } } },
  });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
  res.json({ asset: withUnit(asset) });
});

assetsRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid asset", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const { quantity, purchased, paymentMethodId, reference, categoryId, locationId, roomId, unitId: requestedUnitId, ...rest } = data.data;
  // Unit cost alone is just the book value of something already owned. Money only moves when `purchased` is set.
  const hasPurchase = purchased && quantity > 0 && rest.unitCost !== undefined && rest.unitCost > 0;
  if (purchased && !hasPurchase) { res.status(400).json({ error: "Enter a quantity and unit cost to record a purchase" }); return; }
  try {
    if (categoryId) {
      const category = await prisma.category.findFirst({ where: { id: categoryId, tenantId: tid, scope: "ASSETS" } });
      if (!category) { res.status(400).json({ error: "Selected category was not found" }); return; }
    }
    if (locationId) {
      const location = await prisma.location.findFirst({ where: { id: locationId, tenantId: tid } });
      if (!location) { res.status(400).json({ error: "Choose a location from this property" }); return; }
    }
    if (roomId) {
      const room = await prisma.room.findFirst({ where: { id: roomId, tenantId: tid } });
      if (!room) { res.status(400).json({ error: "Choose a room from this property" }); return; }
    }
    const unitId = await resolveUnitId(tid, requestedUnitId);
    if (hasPurchase && !paymentMethodId) { res.status(400).json({ error: "Choose a payment method for this purchase" }); return; }
    const resolvedPayment = paymentMethodId ? await resolvePaymentMethod(tid, paymentMethodId, reference) : null;

    const assetNo = await nextAssetNo(tid);
    const transactionNo = hasPurchase ? await nextTransactionNo(tid) : null;
    const asset = await prisma.$transaction(async (tx) => {
      const created = await tx.asset.create({ data: { tenantId: tid, assetNo, categoryId, locationId, roomId, unitId, quantity, createdBy: req.userId, ...rest } });
      if (quantity > 0) {
        const movement = await tx.assetMovement.create({
          data: { tenantId: tid, assetId: created.id, type: "RECEIPT", quantity, unitCost: rest.unitCost, paymentMethodId: hasPurchase ? paymentMethodId : undefined, reference: hasPurchase ? resolvedPayment?.reference : undefined, note: "Opening quantity", performedBy: req.userId },
        });
        if (hasPurchase) {
          await tx.transaction.create({
            data: {
              tenantId: tid,
              transactionNo: transactionNo!,
              direction: "OUT",
              source: "ASSET_PURCHASE",
              amount: quantity * rest.unitCost!,
              paymentMethodId: paymentMethodId!,
              reference: resolvedPayment?.reference,
              locationId,
              employeeId: req.userId,
              description: `Capital purchase (asset, not an expense) — ${quantity} × ${rest.name}`,
              sourceRefId: movement.id,
            },
          });
        }
      }
      return tx.asset.findUniqueOrThrow({ where: { id: created.id }, include: assetInclude });
    });
    res.status(201).json({ asset: withUnit(asset) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "An asset with this number already exists — try again" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

assetsRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid asset", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    if (data.data.categoryId) {
      const category = await prisma.category.findFirst({ where: { id: data.data.categoryId, tenantId: tid, scope: "ASSETS" } });
      if (!category) { res.status(400).json({ error: "Selected category was not found" }); return; }
    }
    if (data.data.locationId) {
      const location = await prisma.location.findFirst({ where: { id: data.data.locationId, tenantId: tid } });
      if (!location) { res.status(400).json({ error: "Choose a location from this property" }); return; }
    }
    if (data.data.roomId) {
      const room = await prisma.room.findFirst({ where: { id: data.data.roomId, tenantId: tid } });
      if (!room) { res.status(400).json({ error: "Choose a room from this property" }); return; }
    }
    if (data.data.unitId) data.data.unitId = await resolveUnitId(tid, data.data.unitId);
    const updated = await prisma.asset.updateMany({ where: { id: req.params.id, tenantId: tid }, data: { ...data.data, updatedBy: req.userId } });
    if (!updated.count) { res.status(404).json({ error: "Asset not found" }); return; }
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: req.params.id }, include: assetInclude });
    res.json({ asset: withUnit(asset) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.delete("/:id", async (req, res) => {
  const tid = tenantId(req);
  const asset = await prisma.asset.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { _count: { select: { movements: true } } } });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
  if (asset._count.movements > 0) { res.status(409).json({ error: "This asset has recorded movements and can't be deleted — deactivate it instead" }); return; }
  await prisma.asset.delete({ where: { id: asset.id } });
  res.status(204).send();
});

assetsRouter.get("/:id/movements", async (req, res) => {
  const tid = tenantId(req);
  const asset = await prisma.asset.findFirst({ where: { id: req.params.id, tenantId: tid }, include: assetInclude });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
  const movements = await prisma.assetMovement.findMany({
    where: { assetId: asset.id, tenantId: tid },
    include: { paymentMethod: { select: { id: true, name: true } }, employee: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: { occurredAt: "desc" },
  });
  res.json({ asset: withUnit(asset), movements });
});

/** Records more received (RECEIPT — optionally with a real cost + payment
 * method, writing a matching ledger Transaction), a plain count correction
 * (ADJUSTMENT), or breakage/loss/disposal (WRITE_OFF) — the only ways an
 * asset's quantity ever changes after creation. */
assetsRouter.post("/:id/movements", async (req, res) => {
  const data = movementSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid asset movement", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const asset = await prisma.asset.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
  const { type, quantity, unitCost, purchased, paymentMethodId, reference, note, occurredAt } = data.data;
  // A receipt is a purchase only when explicitly marked; otherwise it just records units already owned.
  const hasPurchase = type === "RECEIPT" && purchased && unitCost !== undefined && unitCost > 0;
  if (purchased && type === "RECEIPT" && !hasPurchase) { res.status(400).json({ error: "Enter a unit cost to record a purchase" }); return; }

  if (quantity < 0 && Number(asset.quantity) + quantity < 0) { res.status(400).json({ error: `Not enough ${asset.name} on hand for this` }); return; }
  if (hasPurchase && !paymentMethodId) { res.status(400).json({ error: "Choose a payment method for this purchase" }); return; }

  try {
    const resolvedPayment = paymentMethodId ? await resolvePaymentMethod(tid, paymentMethodId, reference) : null;
    const transactionNo = hasPurchase ? await nextTransactionNo(tid) : null;
    const result = await prisma.$transaction(async (tx) => {
      await tx.asset.update({ where: { id: asset.id }, data: { quantity: { increment: quantity }, ...(type === "RECEIPT" && unitCost !== undefined && unitCost > 0 ? { unitCost } : {}) } });
      const movement = await tx.assetMovement.create({
        data: { tenantId: tid, assetId: asset.id, type, quantity, unitCost, paymentMethodId: hasPurchase ? paymentMethodId : undefined, reference: hasPurchase ? resolvedPayment?.reference : undefined, note, occurredAt, performedBy: req.userId },
        include: { paymentMethod: { select: { id: true, name: true } }, employee: { select: { id: true, firstName: true, lastName: true } } },
      });
      if (hasPurchase) {
        await tx.transaction.create({
          data: {
            tenantId: tid,
            transactionNo: transactionNo!,
            direction: "OUT",
            source: "ASSET_PURCHASE",
            amount: quantity * unitCost!,
            paymentMethodId: paymentMethodId!,
            reference: resolvedPayment?.reference,
            locationId: asset.locationId,
            employeeId: req.userId,
            description: `Capital purchase (asset, not an expense) — ${quantity} × ${asset.name}`,
            sourceRefId: movement.id,
          },
        });
      }
      return movement;
    });
    const updatedAsset = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id }, include: assetInclude });
    res.status(201).json({ movement: result, asset: withUnit(updatedAsset) });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});
