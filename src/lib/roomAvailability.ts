import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma.js";

// One source of truth for "is this room taken?" — shared by Reception and the
// public website, so an online booking can never disagree with the front desk.

/** Reservation statuses that hold a room. */
export const OPEN_RESERVATION_STATUSES = ["PENDING", "CONFIRMED", "CHECKED_IN"] as const;

type StayScope = { tenantId: string; checkIn: Date; checkOut: Date; now?: Date };

/** Reservations that occupy a room for any part of [checkIn, checkOut): open,
 * overlapping, and — for an unpaid online hold — not yet expired. */
export function blockingReservationWhere(scope: StayScope): Prisma.ReservationWhereInput {
  return {
    tenantId: scope.tenantId,
    status: { in: [...OPEN_RESERVATION_STATUSES] },
    checkIn: { lt: scope.checkOut },
    checkOut: { gt: scope.checkIn },
    OR: [{ holdExpiresAt: null }, { holdExpiresAt: { gt: scope.now ?? new Date() } }],
  };
}

export async function roomIsAvailable(scope: StayScope & { roomId: string; excludeId?: string }): Promise<boolean> {
  return !(await prisma.reservation.findFirst({
    where: { ...blockingReservationWhere(scope), roomId: scope.roomId, ...(scope.excludeId ? { id: { not: scope.excludeId } } : {}) },
    select: { id: true },
  }));
}

/** How many rooms of each (active) room type are free for the whole stay.
 * Out-of-service rooms never count. Types with nothing free are absent. */
export async function freeRoomsByType(scope: StayScope & { roomTypeIds?: string[] }): Promise<Map<string, number>> {
  const [rooms, busy] = await Promise.all([
    prisma.room.findMany({
      where: {
        tenantId: scope.tenantId,
        status: { not: "OUT_OF_SERVICE" },
        roomType: { isActive: true },
        ...(scope.roomTypeIds ? { roomTypeId: { in: scope.roomTypeIds } } : {}),
      },
      select: { id: true, roomTypeId: true },
    }),
    prisma.reservation.findMany({ where: blockingReservationWhere(scope), select: { roomId: true }, distinct: ["roomId"] }),
  ]);
  const busyIds = new Set(busy.map((r) => r.roomId));
  const free = new Map<string, number>();
  for (const room of rooms) {
    if (!busyIds.has(room.id)) free.set(room.roomTypeId, (free.get(room.roomTypeId) ?? 0) + 1);
  }
  return free;
}
