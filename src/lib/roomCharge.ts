import type { Prisma, PrismaClient } from "@prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;
type TaxMode = "INCLUSIVE" | "EXCLUSIVE";
type TaxTreatment = "STANDARD" | "ZERO_RATED" | "EXEMPT";

/** The tenant's BusinessProfile tax defaults, or whatever else a caller wants
 * a room type's own null fields to fall back to. */
export type TaxFallback = { taxRate: Prisma.Decimal | number | null; taxMode: TaxMode | null; taxTreatment: TaxTreatment | null } | null;

/** The starting SUGGESTION for how many billing units a stay spans — never
 * the final word. HOURS/MINUTES return the raw elapsed value uncapped (a
 * 4.3-hour stay is a legitimate quantity on its own; rounding it is a
 * decision for whoever is billing it, via quantityOverride below, not
 * something this function should bake in). DAYS keeps the old hotel
 * convention that any part of a day is a full night. HEADCOUNT reports
 * however many people the caller passed in (typically a reservation's
 * adults + children). EACH is always exactly 1 — a flat package, no
 * multiplier. Keyed on the unit's measurementKind — never its name — so a
 * user can't break billing by how they spell or rename things. */
export function unitQuantity(kind: string | null | undefined, checkIn: Date, checkOut: Date, headcount?: number | null): number {
  const ms = checkOut.getTime() - checkIn.getTime();
  switch (kind) {
    case "HOURS":
      return Math.max(0.01, ms / 3_600_000);
    case "MINUTES":
      return Math.max(1, ms / 60_000);
    case "HEADCOUNT":
      return Math.max(1, headcount ?? 1);
    case "EACH":
      return 1;
    case "DAYS":
    default:
      return Math.max(1, Math.ceil(ms / 86_400_000));
  }
}

export type RoomCharge = {
  amount: number;
  quantity: number;
  /** "Room 101 — Deluxe · Bed & Breakfast" */
  label: string;
  rateId: string | null;
  rateName: string | null;
  unitName: string | null;
  /** Resolved (room type override ?? fallback ?? null) at charge time — a
   * later tax settings change never re-taxes a line already on a folio. */
  taxRate: number | null;
  taxMode: TaxMode | null;
  taxTreatment: TaxTreatment | null;
};

type RoomLike = { id: string; number: string; nightlyRate: Prisma.Decimal | number; roomTypeId: string };

export type RoomChargeSelection = {
  rateId?: string | null;
  mealPlan?: string | null;
  /** How many people this charge is for — only consulted for a HEADCOUNT
   * unit; ignored otherwise. Typically the reservation's adults + children. */
  headcount?: number | null;
  /** Skips the auto-calculation entirely and charges exactly this quantity
   * instead — the "user can override the multiplier" escape hatch every
   * caller should expose once it has a quantity field to show one in. */
  quantityOverride?: number | null;
};

/**
 * Prices one room for a stay. A room type with rate variants must be sold
 * under one of them (that variant's price × its unit's quantity is the
 * charge); a type without variants just uses the room's own price. Legacy
 * reservations that only carry the old meal-plan enum are matched to the
 * migrated variant of the same meal plan.
 */
export async function resolveRoomCharge(
  client: Client,
  room: RoomLike,
  selection: RoomChargeSelection,
  checkIn: Date,
  checkOut: Date,
  fallbackTax?: TaxFallback,
): Promise<RoomCharge> {
  const type = await client.roomType.findUniqueOrThrow({
    where: { id: room.roomTypeId },
    select: {
      name: true,
      priceUnit: { select: { name: true, measurementKind: true } },
      taxRate: true,
      taxMode: true,
      taxTreatment: true,
      rates: { select: { id: true, name: true, price: true, mealPlan: true, unit: { select: { name: true, measurementKind: true } } }, orderBy: { name: "asc" } },
    },
  });
  const tax = {
    taxRate: type.taxRate != null ? Number(type.taxRate) : fallbackTax?.taxRate != null ? Number(fallbackTax.taxRate) : null,
    taxMode: type.taxMode ?? fallbackTax?.taxMode ?? null,
    taxTreatment: type.taxTreatment ?? fallbackTax?.taxTreatment ?? null,
  };
  const base = `Room ${room.number} — ${type.name}`;
  const quantityFor = (kind: string | null | undefined) =>
    selection.quantityOverride != null ? Math.max(0.01, selection.quantityOverride) : unitQuantity(kind, checkIn, checkOut, selection.headcount);
  if (type.rates.length === 0) {
    return { amount: Number(room.nightlyRate), quantity: quantityFor(type.priceUnit?.measurementKind), label: base, rateId: null, rateName: null, unitName: type.priceUnit?.name ?? null, ...tax };
  }
  const rate =
    (selection.rateId ? type.rates.find((r) => r.id === selection.rateId) : undefined) ??
    (!selection.rateId && selection.mealPlan ? type.rates.find((r) => r.mealPlan === selection.mealPlan) : undefined);
  if (!rate) throw Object.assign(new Error(`Room ${room.number} (${type.name}) is sold by rate — choose one`), { status: 400 });
  return { amount: Number(rate.price), quantity: quantityFor(rate.unit?.measurementKind), label: `${base} · ${rate.name}`, rateId: rate.id, rateName: rate.name, unitName: rate.unit?.name ?? null, ...tax };
}
