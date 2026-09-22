import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { nextAssetNo, nextTransactionNo } from "../../lib/sequence.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { UNITS_OF_MEASURE } from "../products/products.routes.js";
import { checkedPaymentReference } from "../../lib/paymentReferences.js";

// Durable, owned equipment (chairs, plates, cutlery) bought through Store —
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
  unit: z.enum(UNITS_OF_MEASURE).default("Each"),
  quantity: z.coerce.number().min(0).default(0),
  unitCost: optionalNumber(0),
  locationId: optionalId,
  // Only meaningful when quantity + unitCost together represent a real
  // purchase to log — see the "was there money spent" check in POST /.
  paymentMethodId: optionalId,
  reference: optionalText(120),
  notes: optionalText(500),
  isActive: z.boolean().default(true),
});
const updateSchema = partialNoDefaults(createSchema.omit({ quantity: true, paymentMethodId: true, reference: true }));

const movementSchema = z.object({
  type: z.enum(["RECEIPT", "ADJUSTMENT", "WRITE_OFF"]),
  quantity: z.coerce.number().finite().refine((value) => value !== 0, "Quantity cannot be zero"),
  unitCost: optionalNumber(0),
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
  category: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
  updatedByEmployee: { select: { id: true, firstName: true, lastName: true } },
} as const;

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
    active: z.enum(["true", "false"]).optional(),
  }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid asset filters", details: query.error.flatten() }); return; }
  const { search, categoryId, locationId, active } = query.data;
  const tid = tenantId(req);
  const where: Prisma.AssetWhereInput = {
    tenantId: tid,
    ...(categoryId ? { categoryId } : {}),
    ...(locationId ? { locationId } : {}),
    ...(active ? { isActive: active === "true" } : {}),
    ...(search ? { OR: [
      { name: { contains: search, mode: "insensitive" } },
      { assetNo: { contains: search, mode: "insensitive" } },
    ] } : {}),
  };
  const assets = await prisma.asset.findMany({ where, include: assetInclude, orderBy: { name: "asc" } });
  const totalValue = assets.reduce((sum, a) => sum + Number(a.quantity) * Number(a.unitCost ?? 0), 0);
  res.json({ assets, summary: { total: assets.length, totalValue } });
});

assetsRouter.get("/:id", async (req, res) => {
  const asset = await prisma.asset.findFirst({
    where: { id: req.params.id, tenantId: tenantId(req) },
    include: { ...assetInclude, movements: { include: { paymentMethod: { select: { id: true, name: true } }, employee: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { occurredAt: "desc" } } },
  });
  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }
  res.json({ asset });
});

assetsRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid asset", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const { quantity, paymentMethodId, reference, categoryId, locationId, ...rest } = data.data;
  const hasPurchase = quantity > 0 && rest.unitCost !== undefined && rest.unitCost > 0;
  try {
    if (categoryId) {
      const category = await prisma.category.findFirst({ where: { id: categoryId, tenantId: tid, scope: "ASSETS" } });
      if (!category) { res.status(400).json({ error: "Selected category was not found" }); return; }
    }
    if (locationId) {
      const location = await prisma.location.findFirst({ where: { id: locationId, tenantId: tid } });
      if (!location) { res.status(400).json({ error: "Choose a location from this property" }); return; }
    }
    if (hasPurchase && !paymentMethodId) { res.status(400).json({ error: "Choose a payment method for this purchase" }); return; }
    const resolvedPayment = paymentMethodId ? await resolvePaymentMethod(tid, paymentMethodId, reference) : null;

    const assetNo = await nextAssetNo(tid);
    const transactionNo = hasPurchase ? await nextTransactionNo(tid) : null;
    const asset = await prisma.$transaction(async (tx) => {
      const created = await tx.asset.create({ data: { tenantId: tid, assetNo, categoryId, locationId, quantity, createdBy: req.userId, ...rest } });
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
              description: `Asset purchase — ${quantity} × ${rest.name}`,
              sourceRefId: movement.id,
            },
          });
        }
      }
      return tx.asset.findUniqueOrThrow({ where: { id: created.id }, include: assetInclude });
    });
    res.status(201).json({ asset });
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
    const updated = await prisma.asset.updateMany({ where: { id: req.params.id, tenantId: tid }, data: { ...data.data, updatedBy: req.userId } });
    if (!updated.count) { res.status(404).json({ error: "Asset not found" }); return; }
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: req.params.id }, include: assetInclude });
    res.json({ asset });
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
  res.json({ asset, movements });
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
  const { type, quantity, unitCost, paymentMethodId, reference, note, occurredAt } = data.data;
  const hasPurchase = type === "RECEIPT" && unitCost !== undefined && unitCost > 0;

  if (quantity < 0 && Number(asset.quantity) + quantity < 0) { res.status(400).json({ error: `Not enough ${asset.name} on hand for this` }); return; }
  if (hasPurchase && !paymentMethodId) { res.status(400).json({ error: "Choose a payment method for this purchase" }); return; }

  try {
    const resolvedPayment = paymentMethodId ? await resolvePaymentMethod(tid, paymentMethodId, reference) : null;
    const transactionNo = hasPurchase ? await nextTransactionNo(tid) : null;
    const result = await prisma.$transaction(async (tx) => {
      await tx.asset.update({ where: { id: asset.id }, data: { quantity: { increment: quantity }, ...(hasPurchase ? { unitCost } : {}) } });
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
            description: `Asset purchase — ${quantity} × ${asset.name}`,
            sourceRefId: movement.id,
          },
        });
      }
      return movement;
    });
    const updatedAsset = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id }, include: assetInclude });
    res.status(201).json({ movement: result, asset: updatedAsset });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});
