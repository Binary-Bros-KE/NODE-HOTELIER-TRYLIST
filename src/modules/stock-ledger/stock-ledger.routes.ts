import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { businessDayWindowForDateOnly } from "../../lib/businessDay.js";
import { nairobiWallClockToUtc } from "../../lib/shifts.js";

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
// from/to are Nairobi wall-clock: a plain date (YYYY-MM-DD) or a date and time (YYYY-MM-DDTHH:mm).
// A plain `to` date means the end of that day; a date+time is used exactly as given.
const localStamp = z.preprocess(blankToUndefined, z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, "Use YYYY-MM-DD or YYYY-MM-DDTHH:mm").optional());
const dateOnlyStamp = z.preprocess(blankToUndefined, z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional());

function parseLocalStamp(value: string, endOfDay: boolean): Date {
  const [datePart, timePart] = value.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  if (timePart) {
    const [hh, mm] = timePart.split(":").map(Number);
    // A date+time "to" is inclusive of that whole minute.
    const at = nairobiWallClockToUtc(y, m, d, hh, mm);
    return endOfDay ? new Date(at.getTime() + 60_000 - 1) : at;
  }
  const at = nairobiWallClockToUtc(y, m, d, 0, 0);
  return endOfDay ? new Date(at.getTime() + 24 * 60 * 60 * 1000 - 1) : at;
}

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
  from: localStamp,
  to: localStamp,
  // A business day (e.g. 09:00 to 09:00 next day, per Business Information): the day that STARTS on this date.
  shiftDate: dateOnlyStamp,
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
    const { search, type, locationId, productId, year, from, to, shiftDate, page, pageSize } = parsed.data;
    const tid = tenantId(req);

    // Explicit from/to win; otherwise a bare `year` bounds the whole year.
    let start: Date | undefined;
    let end: Date | undefined;
    if (shiftDate) {
      const profile = await prisma.businessProfile.findUnique({ where: { tenantId: tid }, select: { businessDayStartHour: true } });
      ({ start, end } = businessDayWindowForDateOnly(profile?.businessDayStartHour ?? 0, new Date(`${shiftDate}T00:00:00.000Z`)));
    } else {
      start = from ? parseLocalStamp(from, false) : undefined;
      end = to ? parseLocalStamp(to, true) : undefined;
    }
    if (!start && !end && year) {
      start = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
      end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    }

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
      range: start || end ? { start: start?.toISOString() ?? null, end: end?.toISOString() ?? null } : null,
      pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (error) {
    next(error);
  }
});

export { STOCK_MOVEMENT_TYPES };
