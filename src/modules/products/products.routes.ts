import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { recordStockMovement, InsufficientStockError } from "../../lib/stockLedger.js";

export const productsRouter = Router();
productsRouter.use(requireModule("PRODUCTS"));

// Common units of measure for a hotel store. Kept as a fixed list (rather than
// free text) so stock reports don't end up with "kg"/"Kg"/"KGS" variants.
export const UNITS_OF_MEASURE = [
  "Each", "Pieces", "Kg", "Grams", "Litres", "Millilitres", "Box", "Carton",
  "Pack", "Dozen", "Roll", "Bottle", "Can", "Bag", "Set", "Pair", "Meter",
] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const blankToNull = (v: unknown) => (v == null || (typeof v === "string" && v.trim() === "") ? null : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());
const optionalNumber = (min = 0) => z.preprocess(blankToUndefined, z.coerce.number().min(min).optional());
// Blank clears the field (needed so a product can stop being pack-tracked).
const nullableText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable());
const nullableId = z.preprocess(blankToNull, z.string().trim().nullable());
const nullableNumber = (min = 0) => z.preprocess(blankToNull, z.coerce.number().min(min).nullable());

const productObjectSchema = z.object({
  categoryId: optionalId,
  name: z.string().trim().min(1).max(150),
  sku: optionalText(60),
  barcode: optionalText(60),
  brand: optionalText(80),
  description: optionalText(500),
  photoUrl: optionalText(2000),
  // Free text, not the fixed UNITS_OF_MEASURE list below (that's still used
  // by Assets) — the product form now sources its options from this
  // tenant's own UnitOfMeasure table (the same one packUnitId points at),
  // so a name that table has and this list doesn't must still validate.
  unit: z.string().trim().min(1).max(40).default("Each"),
  isPerishable: z.boolean().default(false),
  shelfLifeDays: optionalNumber(0),
  // Pack / container tracking. packUnitId points at a UnitOfMeasure row
  // (e.g. "ml"); packSize is how much of that unit is in one pack; packLabel
  // is the pack noun. All three or none — when set, this product's stock is
  // held in packUnit and the UI derives "N <packLabel>s" as quantity /
  // packSize.
  packSize: nullableNumber(0.001).optional(),
  packUnitId: nullableId.optional(),
  packLabel: nullableText(40).optional(),
  openingStock: z.coerce.number().min(0).default(0),
  // Where opening stock is received. Optional when the property has exactly
  // one location (auto-resolved, same convenience the old single-store
  // system had) — required otherwise, and only when opening stock is > 0.
  locationId: optionalId,
  reorderLevel: z.coerce.number().min(0).default(0),
  maxStockLevel: optionalNumber(0),
  unitCost: optionalNumber(0),
  // The explicit "also sold as a whole unit via Products POS" flag — see the
  // schema comment on Product.sellsDirectly. sellingPrice is required when
  // this is true (enforced below); nullableNumber (not optionalNumber) so
  // blanking the field on an edit actually clears it.
  sellsDirectly: z.boolean().default(false),
  sellingPrice: nullableNumber(0).optional(),
  taxRate: nullableNumber(0).optional(),
  taxMode: z.enum(["INCLUSIVE", "EXCLUSIVE"]).optional(),
  taxTreatment: z.enum(["STANDARD", "ZERO_RATED", "EXEMPT"]).optional(),
  preferredSupplier: optionalText(120),
  isActive: z.boolean().default(true),
});
// sellsDirectly<->sellingPrice cross-checks, shared by create and update: the
// price is required whenever the flag is on, and (create only, where every
// field is always present) turning the flag off clears any stale price.
function requireSellingPriceWhenDirect<T extends { sellsDirectly?: boolean; sellingPrice?: number | null }>(data: T, ctx: z.RefinementCtx) {
  if (data.sellsDirectly && data.sellingPrice == null) {
    ctx.addIssue({ code: "custom", message: "Selling price is required when sold directly via Products POS", path: ["sellingPrice"] });
  }
}
const createSchema = productObjectSchema
  .superRefine(requireSellingPriceWhenDirect)
  .transform((data) => (data.sellsDirectly ? data : { ...data, sellingPrice: null }));
const updateSchema = partialNoDefaults(productObjectSchema.omit({ openingStock: true, locationId: true })).superRefine(requireSellingPriceWhenDirect);

// A hand-entered movement at one location, for when stock changes outside
// the Purchases/Goods-Receipt flow: an opening balance for a product that
// wasn't given one at creation (OPENING_STOCK), stock bought in off-book
// (PURCHASE), stock physically handed back in (RETURN — same direction the
// rest of the codebase already uses it, e.g. the POS return-restore path in
// pos.routes.ts), stock written off as broken/spoiled/lost (DAMAGE_LOSS), or
// a plain count correction (ADJUSTMENT, signed either way). Every one of
// these is a positive add to stock except DAMAGE_LOSS, which the UI always
// asks for as a positive "how much was lost" and this route negates.
// Location-to-location moves use /transfer instead.
const MANUAL_MOVEMENT_TYPES = ["OPENING_STOCK", "PURCHASE", "RETURN", "DAMAGE_LOSS", "ADJUSTMENT"] as const;
const POSITIVE_ONLY_TYPES = ["OPENING_STOCK", "PURCHASE", "RETURN"] as const;
const movementSchema = z.object({
  type: z.enum(MANUAL_MOVEMENT_TYPES),
  locationId: z.string().trim().min(1),
  quantity: z.coerce.number().finite().refine((value) => value !== 0, "Quantity cannot be zero"),
  unitCost: z.coerce.number().min(0).optional(),
  note: z.string().trim().max(500).optional(),
  occurredAt: z.coerce.date().optional(),
}).superRefine((value, context) => {
  if ((POSITIVE_ONLY_TYPES as readonly string[]).includes(value.type) && value.quantity < 0) {
    context.addIssue({ code: "custom", message: "Quantity must be positive for this movement type", path: ["quantity"] });
  }
});

const transferSchema = z.object({
  fromLocationId: z.string().trim().min(1),
  toLocationId: z.string().trim().min(1),
  quantity: z.coerce.number().positive(),
  note: z.string().trim().max(500).optional(),
  occurredAt: z.coerce.date().optional(),
}).refine((v) => v.fromLocationId !== v.toLocationId, { message: "Choose two different locations", path: ["toLocationId"] });

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const productFields = {
  id: true,
  categoryId: true,
  category: { select: { id: true, name: true, level: true } },
  name: true,
  sku: true,
  barcode: true,
  brand: true,
  description: true,
  photoUrl: true,
  unit: true,
  isPerishable: true,
  shelfLifeDays: true,
  packSize: true,
  packLabel: true,
  packUnitId: true,
  packUnit: { select: { id: true, name: true } },
  reorderLevel: true,
  maxStockLevel: true,
  unitCost: true,
  sellsDirectly: true,
  sellingPrice: true,
  taxRate: true,
  taxMode: true,
  taxTreatment: true,
  preferredSupplier: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  menuItems: {
    select: {
      id: true, name: true, price: true,
      variants: { select: { id: true, name: true, price: true, stockProductId: true } },
    },
  },
  variantStocks: { select: { id: true, name: true, price: true, menuItem: { select: { id: true, name: true } } } },
  recipeIngredients: {
    select: {
      recipe: {
        select: {
          menuItems: {
            select: {
              id: true, name: true, price: true,
              variants: { select: { id: true, name: true, price: true, stockProductId: true } },
            },
          },
        },
      },
    },
  },
  stocks: { select: { locationId: true, quantity: true, location: { select: { id: true, name: true } } } },
} as const;

type ProductWithStocks = { stocks: { locationId: string; quantity: Prisma.Decimal; location: { id: string; name: string } }[] };

const totalOf = (p: ProductWithStocks) => p.stocks.reduce((sum, s) => sum + Number(s.quantity), 0);

const withTotal = <T extends ProductWithStocks>(p: T) => {
  const { stocks, ...rest } = p;
  return {
    ...rest,
    stockByLocation: stocks.map((s) => ({ locationId: s.locationId, locationName: s.location.name, quantity: Number(s.quantity).toFixed(3) })),
    totalQuantity: totalOf(p).toFixed(3),
  };
};

async function assertLocationInTenant(locationId: string, tid: string) {
  const location = await prisma.location.findFirst({ where: { id: locationId, tenantId: tid }, select: { id: true, name: true } });
  if (!location) throw Object.assign(new Error("Choose a location from this property"), { status: 400 });
  return location;
}

async function assertPackUnit(packUnitId: string | null | undefined, tid: string) {
  if (!packUnitId) return;
  const unit = await prisma.unitOfMeasure.findFirst({ where: { id: packUnitId, tenantId: tid }, select: { id: true } });
  if (!unit) throw Object.assign(new Error("Choose a pack unit from this property's units of measure"), { status: 400 });
}

productsRouter.get("/", async (req, res) => {
  const query = z.object({
    search: z.string().trim().max(100).optional(),
    categoryId: z.string().trim().optional(),
    lowStock: z.enum(["true", "false"]).optional(),
    active: z.enum(["true", "false"]).optional(),
  }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid product filters", details: query.error.flatten() }); return; }
  const { search, categoryId, lowStock, active } = query.data;
  const tid = tenantId(req);
  const where: Prisma.ProductWhereInput = {
    tenantId: tid,
    ...(categoryId ? { categoryId } : {}),
    ...(active ? { isActive: active === "true" } : {}),
    ...(search ? { OR: [
      { name: { contains: search, mode: "insensitive" } },
      { sku: { contains: search, mode: "insensitive" } },
      { barcode: { contains: search, mode: "insensitive" } },
      { brand: { contains: search, mode: "insensitive" } },
    ] } : {}),
  };
  const products = await prisma.product.findMany({ where, select: productFields, orderBy: { name: "asc" } });
  const withTotals = products.map(withTotal);
  const visible = lowStock === "true" ? withTotals.filter((p) => Number(p.totalQuantity) <= Number(p.reorderLevel)) : withTotals;
  const [total, active_, lowStockCount] = await Promise.all([
    prisma.product.count({ where: { tenantId: tid } }),
    prisma.product.count({ where: { tenantId: tid, isActive: true } }),
    prisma.product.findMany({ where: { tenantId: tid }, select: { reorderLevel: true, stocks: { select: { quantity: true } } } })
      .then((all) => all.filter((p) => p.stocks.reduce((s, x) => s + Number(x.quantity), 0) <= Number(p.reorderLevel)).length),
  ]);
  res.json({ products: visible, summary: { total, active: active_, inactive: total - active_, lowStock: lowStockCount } });
});

productsRouter.get("/:id", async (req, res) => {
  const product = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: productFields });
  if (!product) { res.status(404).json({ error: "Product not found" }); return; }
  res.json({ product: withTotal(product) });
});

productsRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid product", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const { openingStock, locationId, categoryId, ...rest } = data.data;
  try {
    let receivingLocationId = locationId;
    if (openingStock > 0 && !receivingLocationId) {
      const locations = await prisma.location.findMany({ where: { tenantId: tid }, select: { id: true } });
      if (locations.length === 1) receivingLocationId = locations[0].id;
      else { res.status(400).json({ error: "Choose a location to receive the opening stock at" }); return; }
    }
    if (receivingLocationId) await assertLocationInTenant(receivingLocationId, tid);
    await assertPackUnit(rest.packUnitId, tid);
    if (categoryId) {
      const category = await prisma.category.findFirst({ where: { id: categoryId, tenantId: tid, scope: "STORE" } });
      if (!category) { res.status(400).json({ error: "Selected category was not found" }); return; }
    }
    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({ data: { tenantId: tid, categoryId, ...rest } });
      if (openingStock > 0 && receivingLocationId) {
        await recordStockMovement(tx, {
          tenantId: tid, productId: created.id, locationId: receivingLocationId,
          type: "OPENING_STOCK", quantity: openingStock, unitCost: rest.unitCost ?? null,
          note: "Opening stock", sourceType: "PRODUCT_OPENING", sourceRefId: created.id,
          performedBy: req.userId ?? null,
        });
      }
      return tx.product.findUniqueOrThrow({ where: { id: created.id }, select: productFields });
    });
    res.status(201).json({ product: withTotal(product) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A product with this SKU or barcode already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

productsRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid product", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    if (data.data.categoryId) {
      const category = await prisma.category.findFirst({ where: { id: data.data.categoryId, tenantId: tid } });
      if (!category) { res.status(400).json({ error: "Selected category was not found" }); return; }
    }
    if (data.data.packUnitId) await assertPackUnit(data.data.packUnitId, tid);
    const updated = await prisma.product.updateMany({ where: { id: req.params.id, tenantId: tid }, data: data.data });
    if (!updated.count) { res.status(404).json({ error: "Product not found" }); return; }
    const product = await prisma.product.findUniqueOrThrow({ where: { id: req.params.id }, select: productFields });
    res.json({ product: withTotal(product) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A product with this SKU or barcode already exists" }); return; }
    next(error);
  }
});

productsRouter.delete("/:id", async (req, res, next) => {
  try {
    const deleted = await prisma.product.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } });
    if (!deleted.count) { res.status(404).json({ error: "Product not found" }); return; }
    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") { res.status(409).json({ error: "This product is used in a recipe and can't be deleted — deactivate it instead" }); return; }
    next(error);
  }
});

productsRouter.get("/:id/movements", async (req, res) => {
  const product = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: productFields });
  if (!product) { res.status(404).json({ error: "Product not found" }); return; }
  const movements = await prisma.inventoryMovement.findMany({
    where: { productId: product.id, tenantId: tenantId(req) },
    include: {
      location: { select: { id: true, name: true } },
      employee: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { occurredAt: "desc" },
  });
  res.json({ product: withTotal(product), movements });
});

/** Hand-entered stock movement at a single location — the Products tab's
 * "Adjust stock" action, for anything outside the Purchases/Goods-Receipt
 * flow: OPENING_STOCK, PURCHASE, RETURN, a write-off for breakage/spoilage/
 * loss (DAMAGE_LOSS), or a plain count correction (ADJUSTMENT). To move
 * stock between two locations, use /transfer. Every path here goes through
 * the stock ledger. */
productsRouter.post("/:id/movements", async (req, res, next) => {
  const data = movementSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid stock movement", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const product = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!product) { res.status(404).json({ error: "Product not found" }); return; }
  const location = await assertLocationInTenant(data.data.locationId, tid).catch(() => null);
  if (!location) { res.status(400).json({ error: "Choose a location from this property" }); return; }
  const { type, locationId, unitCost, note, occurredAt } = data.data;
  const signedQuantity = type === "DAMAGE_LOSS" ? -Math.abs(data.data.quantity) : data.data.quantity;

  try {
    const movement = await prisma.$transaction((tx) => recordStockMovement(tx, {
      tenantId: tid, productId: product.id, locationId, type, quantity: signedQuantity,
      unitCost: unitCost ?? null, note: note ?? null, occurredAt,
      sourceType: "MANUAL", performedBy: req.userId ?? null, label: product.name,
    }));
    const updatedProduct = await prisma.product.findUniqueOrThrow({ where: { id: product.id }, select: productFields });
    res.status(201).json({ movement, product: withTotal(updatedProduct) });
  } catch (error) {
    if (error instanceof InsufficientStockError) { res.status(error.status).json({ error: `Not enough ${product.name} at ${location.name} for this` }); return; }
    next(error);
  }
});

/** Moves stock between any two locations. Recorded as a matched pair of
 * movements (one per location) so each location's audit trail fully
 * explains its own balance. */
productsRouter.post("/:id/transfer", async (req, res, next) => {
  const data = transferSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid transfer", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const product = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!product) { res.status(404).json({ error: "Product not found" }); return; }
  const { fromLocationId, toLocationId, quantity, note, occurredAt } = data.data;
  const [fromLocation, toLocation] = await Promise.all([
    assertLocationInTenant(fromLocationId, tid).catch(() => null),
    assertLocationInTenant(toLocationId, tid).catch(() => null),
  ]);
  if (!fromLocation || !toLocation) { res.status(400).json({ error: "Choose two locations from this property" }); return; }
  const transferNote = note ?? `Transfer ${fromLocation.name} → ${toLocation.name}`;

  try {
    await prisma.$transaction(async (tx) => {
      // OUT first — it's the guarded side, so an insufficient balance fails
      // before anything is credited to the destination.
      await recordStockMovement(tx, {
        tenantId: tid, productId: product.id, locationId: fromLocationId, type: "TRANSFER_OUT",
        quantity: -quantity, note: transferNote, occurredAt, sourceType: "TRANSFER",
        performedBy: req.userId ?? null, label: product.name,
      });
      await recordStockMovement(tx, {
        tenantId: tid, productId: product.id, locationId: toLocationId, type: "TRANSFER_IN",
        quantity, note: transferNote, occurredAt, sourceType: "TRANSFER", performedBy: req.userId ?? null,
      });
    });
  } catch (error) {
    if (error instanceof InsufficientStockError) { res.status(400).json({ error: `Not enough ${product.name} at ${fromLocation.name} to transfer` }); return; }
    next(error);
    return;
  }
  const updatedProduct = await prisma.product.findUniqueOrThrow({ where: { id: product.id }, select: productFields });
  res.status(201).json({ product: withTotal(updatedProduct) });
});

// Batch distribution (warehouse -> selling point, several products at once)
// moved to its own module — see stock-transfers.routes.ts — which also
// records a printable receipt with the frozen before/after balance at both
// ends of every line. POST /distribute is gone; the single-product
// /:id/transfer above is unrelated and stays as-is.
