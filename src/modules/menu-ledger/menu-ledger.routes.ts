import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";

// Read-only view over MenuLedgerEntry — what was actually SOLD at menu level
// (a pizza, a cocktail), the counterpart to the stock ledger's ingredient
// movements. Rows are written by the POS at the moments stock is consumed or
// restored (see lib/menuLedger.ts); nothing writes here.
export const menuLedgerRouter = Router();

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
  type: z.enum(["SALE", "COMPLIMENTARY", "RETURN"]).optional(),
  locationId: optionalId,
  menuItemId: optionalId,
  year: z.preprocess(blankToUndefined, z.coerce.number().int().min(2000).max(2100).optional()),
  from: optionalDate,
  to: optionalDate,
  page: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(1)),
  pageSize: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(200).default(50)),
});

menuLedgerRouter.get("/", async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: "Invalid ledger filters", details: parsed.error.flatten() }); return; }
    const { search, type, locationId, menuItemId, year, from, to, page, pageSize } = parsed.data;
    const tid = tenantId(req);

    // Same date handling as the stock ledger: explicit from/to win, else a bare year.
    let start = from;
    let end = to;
    if (!start && !end && year) {
      start = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
      end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    }
    if (end) end = new Date(end.getTime() + (end.getUTCHours() === 0 && end.getUTCMinutes() === 0 ? 24 * 60 * 60 * 1000 - 1 : 0));

    const where: Prisma.MenuLedgerEntryWhereInput = {
      tenantId: tid,
      ...(type ? { type } : {}),
      ...(locationId ? { locationId } : {}),
      ...(menuItemId ? { menuItemId } : {}),
      ...(start || end ? { occurredAt: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } } : {}),
      ...(search ? { OR: [
        { itemName: { contains: search, mode: "insensitive" } },
        { variantName: { contains: search, mode: "insensitive" } },
        ...(Number.isInteger(Number(search)) ? [{ orderNumber: Number(search) }] : []),
      ] } : {}),
    };

    const [total, rows, sums] = await Promise.all([
      prisma.menuLedgerEntry.count({ where }),
      prisma.menuLedgerEntry.findMany({ where, orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
      prisma.menuLedgerEntry.groupBy({ by: ["type"], where, _sum: { quantity: true, amount: true } }),
    ]);

    // Plain-id columns (no relations), so resolve the display names in bulk.
    const locationIds = [...new Set(rows.flatMap((r) => (r.locationId ? [r.locationId] : [])))];
    const employeeIds = [...new Set(rows.flatMap((r) => (r.performedBy ? [r.performedBy] : [])))];
    const [locations, employees] = await Promise.all([
      locationIds.length ? prisma.location.findMany({ where: { id: { in: locationIds }, tenantId: tid }, select: { id: true, name: true } }) : [],
      employeeIds.length ? prisma.employee.findMany({ where: { id: { in: employeeIds }, tenantId: tid }, select: { id: true, firstName: true, lastName: true } }) : [],
    ]);
    const locationName = new Map(locations.map((l) => [l.id, l.name]));
    const employeeName = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));

    const sumOf = (t: string) => sums.find((s) => s.type === t);
    res.json({
      entries: rows.map((r) => ({
        ...r,
        locationName: r.locationId ? locationName.get(r.locationId) ?? null : null,
        performedByName: r.performedBy ? employeeName.get(r.performedBy) ?? null : null,
      })),
      summary: {
        sold: sumOf("SALE")?._sum.quantity ?? 0,
        soldAmount: Number(sumOf("SALE")?._sum.amount ?? 0),
        complimentary: sumOf("COMPLIMENTARY")?._sum.quantity ?? 0,
        complimentaryAmount: Number(sumOf("COMPLIMENTARY")?._sum.amount ?? 0),
        returned: Math.abs(sumOf("RETURN")?._sum.quantity ?? 0),
        returnedAmount: Math.abs(Number(sumOf("RETURN")?._sum.amount ?? 0)),
      },
      pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (error) {
    next(error);
  }
});
