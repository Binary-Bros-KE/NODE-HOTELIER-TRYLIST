import type { Prisma, PrismaClient } from "@prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

/** How many billing units a stay spans: hours for the built-in HOUR unit,
 * otherwise 24-hour days (NIGHT, DAY). Keyed on the unit's system key — never
 * its name — so a user can't break billing by how they spell things. At least 1. */
export function unitQuantity(systemKey: string | null | undefined, checkIn: Date, checkOut: Date): number {
  const ms = checkOut.getTime() - checkIn.getTime();
  if (systemKey === "HOUR") return Math.max(1, Math.ceil(ms / 3_600_000));
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

export type RoomCharge = {
  amount: number;
  quantity: number;
  /** "Room 101 — Deluxe · Bed & Breakfast" */
  label: string;
  rateId: string | null;
  rateName: string | null;
  unitName: string | null;
};

type RoomLike = { id: string; number: string; nightlyRate: Prisma.Decimal | number; roomTypeId: string };

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
  selection: { rateId?: string | null; mealPlan?: string | null },
  checkIn: Date,
  checkOut: Date,
): Promise<RoomCharge> {
  const type = await client.roomType.findUniqueOrThrow({
    where: { id: room.roomTypeId },
    select: {
      name: true,
      priceUnit: { select: { name: true, systemKey: true } },
      rates: { select: { id: true, name: true, price: true, mealPlan: true, unit: { select: { name: true, systemKey: true } } }, orderBy: { name: "asc" } },
    },
  });
  const base = `Room ${room.number} — ${type.name}`;
  if (type.rates.length === 0) {
    return { amount: Number(room.nightlyRate), quantity: unitQuantity(type.priceUnit?.systemKey, checkIn, checkOut), label: base, rateId: null, rateName: null, unitName: type.priceUnit?.name ?? null };
  }
  const rate =
    (selection.rateId ? type.rates.find((r) => r.id === selection.rateId) : undefined) ??
    (!selection.rateId && selection.mealPlan ? type.rates.find((r) => r.mealPlan === selection.mealPlan) : undefined);
  if (!rate) throw Object.assign(new Error(`Room ${room.number} (${type.name}) is sold by rate — choose one`), { status: 400 });
  return { amount: Number(rate.price), quantity: unitQuantity(rate.unit?.systemKey, checkIn, checkOut), label: `${base} · ${rate.name}`, rateId: rate.id, rateName: rate.name, unitName: rate.unit?.name ?? null };
}
