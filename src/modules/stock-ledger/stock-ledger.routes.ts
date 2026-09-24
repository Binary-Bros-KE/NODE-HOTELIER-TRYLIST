import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";

// Read-only view over InventoryMovement — the chronological record of every
// change to any product's stock at any location. Nothing writes here; rows
// come from recordStockMovement() (see lib/stockLedger.ts).
export const stockLedgerRouter = Router();

const STOCK_MOVEMENT_TYPES = [
  "OPENING_STOCK", "PURCHASE", "SALE", "TRANSFER_IN", "TRANSFER_OUT", "RETURN",
  "DAMAGE_LOSS", "ADJUSTMENT", "BORROWED_IN", "RETURNED_BORROWED_STOCK", "LENT_OUT", "LOAN_RETURNED", "ROOM_CONSUMPTION",
] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());
const optionalDate = z.preprocess(blankToUndefined, z.coerce.date().optional());

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const querySchema = z.object({
  search: optionalText(120),
  type: z.enum(STOCK_MOVEMENT_TYPES).optional(),
  locationId: optionalId,
  productId: optionalId,
  year: z.preprocess(blankToUndefined, z.coerce.number().int().min(2000).max(2100).optional()),
  from: optionalDate,
  to: optionalDate,
  page: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(1)),
  pageSize: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(200).default(50)),
});

const ledgerInclude = {
  product: { select: { id: true, name: true, sku: true, unit: true, packSize: true, packLabel: true, packUnit: { select: { id: true, name: true } } } },
  location: { select: { id: true, name: true } },
  employee: { select: { id: true, firstName: true, lastName: true } },
} as const;

stockLedgerRouter.get("/", async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: "Invalid ledger filters", details: parsed.error.flatten() }); return; }
    const { search, type, locationId, productId, year, from, to, page, pageSize } = parsed.data;
    const tid = tenantId(req);

    // Explicit from/to win; otherwise a bare `year` bounds the whole year.
    let start = from;
    let end = to;
    if (!start && !end && year) {
      start = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
      end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    }
    // Make `to` inclusive of the whole day when only a date was given.
    if (end) end = new Date(end.getTime() + (end.getUTCHours() === 0 && end.getUTCMinutes() === 0 ? 24 * 60 * 60 * 1000 - 1 : 0));

    const where: Prisma.InventoryMovementWhereInput = {
      tenantId: tid,
      ...(type ? { type } : {}),
      ...(locationId ? { locationId } : {}),
      ...(productId ? { productId } : {}),
      ...(start || end ? { occurredAt: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } } : {}),
      ...(search ? { product: { is: { OR: [
        { name: { contains: search, mode: "insensitive" } },
        { sku: { contains: search, mode: "insensitive" } },
      ] } } } : {}),
    };

    const [total, entries] = await Promise.all([
      prisma.inventoryMovement.count({ where }),
      prisma.inventoryMovement.findMany({
        where,
        include: ledgerInclude,
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({
      entries,
      pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (error) {
    next(error);
  }
});

export { STOCK_MOVEMENT_TYPES };
