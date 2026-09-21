import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma.js";
import { nextSequenceNo } from "./sequence.js";
import { computeStockRequirements, type OrderItemForStock } from "./stockRequirements.js";

/**
 * Store dispatch: at a KITCHEN-mode location with `requireStoreDispatch`, the
 * chef must request the recipe's ingredients from the store, and the
 * storekeeper's dispatch (a real stock transfer store -> kitchen location) must
 * land before a ticket can be started. Order lines point at the request that
 * covers them (PosOrderItem.dispatchRequestId), so a round added later simply
 * has uncovered lines and needs its own request. There is no new order status.
 */

export class DispatchError extends Error {
  constructor(message: string, public status = 400, public code?: string) {
    super(message);
  }
}

export const dispatchRequired = (location: { serveMode: string; requireStoreDispatch: boolean } | null | undefined) =>
  Boolean(location && location.serveMode === "KITCHEN" && location.requireStoreDispatch);

export type DispatchState = "NOT_REQUIRED" | "NOTHING_NEEDED" | "NEEDS_REQUEST" | "WAITING" | "DISPATCHED";

type DispatchOrder = {
  location: { serveMode: string; requireStoreDispatch: boolean } | null;
  items: (OrderItemForStock & { dispatchRequestId: string | null; dispatchRequest?: { status: string } | null })[];
  dispatchRequests?: { status: string; rejectReason: string | null; requestNo: string }[];
};

const needsStock = (item: OrderItemForStock) => computeStockRequirements([item]).size > 0;

/** A line that consumes stock and hasn't been covered by any store request yet. */
export const lineNeedsDispatch = (item: OrderItemForStock & { dispatchRequestId: string | null }) => !item.dispatchRequestId && needsStock(item);

/** Where this order's ingredients stand with the store. `clear` = the chef may start/finish it. */
export function orderDispatchInfo(order: DispatchOrder) {
  if (!dispatchRequired(order.location)) return { required: false, state: "NOT_REQUIRED" as DispatchState, clear: true, uncovered: 0, rejectReason: null as string | null };
  const needing = order.items.filter(needsStock);
  if (needing.length === 0) return { required: true, state: "NOTHING_NEEDED" as DispatchState, clear: true, uncovered: 0, rejectReason: null };
  const uncovered = needing.filter((item) => !item.dispatchRequestId);
  const waiting = needing.some((item) => item.dispatchRequest?.status === "REQUESTED");
  const latest = order.dispatchRequests?.[0];
  if (uncovered.length > 0) {
    return { required: true, state: "NEEDS_REQUEST" as DispatchState, clear: false, uncovered: uncovered.length, waiting, rejectReason: latest?.status === "REJECTED" ? latest.rejectReason : null };
  }
  return { required: true, state: (waiting ? "WAITING" : "DISPATCHED") as DispatchState, clear: !waiting, uncovered: 0, rejectReason: null };
}

/** The Store that supplies a kitchen: the location's chosen one, else the first STORE location. */
export async function supplyingStoreId(tenantId: string, location: { id: string; dispatchFromLocationId: string | null }): Promise<string | null> {
  if (location.dispatchFromLocationId) {
    const chosen = await prisma.location.findFirst({ where: { id: location.dispatchFromLocationId, tenantId, isActive: true }, select: { id: true } });
    if (chosen) return chosen.id;
  }
  const store = await prisma.location.findFirst({ where: { tenantId, type: "STORE", isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return store?.id ?? null;
}

export async function employeeName(tx: Prisma.TransactionClient | typeof prisma, tenantId: string, employeeId: string | undefined | null): Promise<string | null> {
  if (!employeeId) return null;
  const e = await tx.employee.findFirst({ where: { id: employeeId, tenantId }, select: { firstName: true, lastName: true } });
  return e ? `${e.firstName} ${e.lastName}`.trim() : null;
}

type RequestableOrder = {
  id: string;
  tenantId: string;
  orderNumber: number;
  status: string;
  locationId: string | null;
  location: { id: string; serveMode: string; requireStoreDispatch: boolean; dispatchFromLocationId: string | null } | null;
  items: (OrderItemForStock & { id: string; dispatchRequestId: string | null })[];
};

/** Opens a request for every not-yet-covered line that needs stock. */
export async function createDispatchRequest(order: RequestableOrder, actorId: string | undefined, note?: string) {
  const location = order.location;
  if (!location || !dispatchRequired(location)) throw new DispatchError("This location doesn't use store dispatch", 409);
  if (!["OPEN", "PREPARING", "READY", "SERVED"].includes(order.status)) throw new DispatchError("This order can't request ingredients any more", 409);
  const lines = order.items.filter((item) => !item.dispatchRequestId && needsStock(item));
  if (lines.length === 0) throw new DispatchError("Everything on this order has already been requested", 409);
  const fromLocationId = await supplyingStoreId(order.tenantId, location);
  if (!fromLocationId) throw new DispatchError("No store is set up to supply this kitchen. Choose one in Locations.", 409);
  if (fromLocationId === location.id) throw new DispatchError("The supplying store can't be the kitchen itself", 409);

  const requirements = computeStockRequirements(lines);
  const requestNo = await nextSequenceNo(order.tenantId, "dispatch", "DSP", 6);
  const requesterName = await employeeName(prisma, order.tenantId, actorId);

  return prisma.$transaction(async (tx) => {
    const request = await tx.stockDispatchRequest.create({
      data: {
        tenantId: order.tenantId, requestNo, orderId: order.id, orderNumber: order.orderNumber,
        fromLocationId, toLocationId: location.id, note: note ?? null,
        requestedBy: actorId ?? null, requestedByName: requesterName,
        items: { create: [...requirements].map(([productId, r]) => ({ productId, productName: r.name, requestedQty: r.quantity })) },
      },
      include: { items: true },
    });
    // Claim the lines conditionally: a second tap (or another chef) finds them taken and aborts.
    const claimed = await tx.posOrderItem.updateMany({ where: { orderId: order.id, id: { in: lines.map((l) => l.id) }, dispatchRequestId: null }, data: { dispatchRequestId: request.id } });
    if (claimed.count !== lines.length) throw new DispatchError("Ingredients for this order were just requested by someone else", 409);
    return request;
  });
}
