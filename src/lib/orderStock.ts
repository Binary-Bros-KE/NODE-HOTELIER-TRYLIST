import type { Prisma } from "@prisma/client";

import { DispatchError, dispatchRequired, orderDispatchInfo } from "./dispatch.js";
import { recordStockMovement, InsufficientStockError } from "./stockLedger.js";
import { computeStockRequirements, type OrderItemForStock } from "./stockRequirements.js";

/** Decrements ProductStock for each requirement and logs a matching SALE
 * movement — the actual moment ingredients leave the building. Throws (never
 * responds directly) so callers can shape their own error response. */
export async function deductStockForOrder(
  tx: Prisma.TransactionClient,
  tid: string,
  requirements: Map<string, { quantity: number; name: string }>,
  locationId: string,
  orderNumber: number,
  req: { userId?: string },
) {
  for (const [productId, requirement] of requirements) {
    try {
      await recordStockMovement(tx, {
        tenantId: tid, productId, locationId, type: "SALE", quantity: -requirement.quantity,
        note: `Used for POS order #${orderNumber}`, sourceType: "POS_ORDER", sourceRefId: String(orderNumber),
        performedBy: req.userId ?? null, label: requirement.name,
      });
    } catch (error) {
      if (error instanceof InsufficientStockError) throw new Error(`Not enough ${requirement.name} at this location — transfer more stock in`);
      throw error;
    }
  }
}

/**
 * At a store-dispatch location, lines added after an order was already SERVED
 * are not deducted when they're added (the kitchen shelf holds nothing until
 * the store dispatches). They stay flagged (`addedAfterSend`) until the kitchen
 * marks them prepared, and only then does their stock leave the kitchen. So a
 * flagged line on a served order at such a location has NOT been deducted yet.
 */
export const isUndeductedAddition = (
  order: { servedAt: Date | null; location: { serveMode: string; requireStoreDispatch: boolean } | null },
  item: { addedAfterSend: boolean },
) => Boolean(order.servedAt) && item.addedAfterSend && dispatchRequired(order.location);

type SettleOrder = {
  status: string;
  orderNumber: number;
  locationId: string | null;
  servedAt: Date | null;
  location: { serveMode: string; requireStoreDispatch: boolean } | null;
  items: (OrderItemForStock & { addedAfterSend: boolean; dispatchRequestId: string | null; dispatchRequest?: { status: string } | null })[];
};

/**
 * Called when the kitchen (or bar) marks the added lines of a SERVED order
 * prepared: requires the store to have dispatched them, then takes their
 * ingredients off the kitchen's shelf. A no-op everywhere else.
 */
export async function settleServedAdditions(tx: Prisma.TransactionClient, tid: string, order: SettleOrder, req: { userId?: string }) {
  if (order.status !== "SERVED" || !isUndeductedAdditionOrder(order)) return;
  const flagged = order.items.filter((item) => item.addedAfterSend);
  if (flagged.length === 0) return;
  const info = orderDispatchInfo({ location: order.location, items: order.items });
  if (!info.clear) {
    throw new DispatchError(info.state === "WAITING" ? "Waiting for the store to dispatch the added items" : "Request the added items from the store first", 409, "DISPATCH_REQUIRED");
  }
  if (!order.locationId) return;
  await deductStockForOrder(tx, tid, computeStockRequirements(flagged), order.locationId, order.orderNumber, req);
}

const isUndeductedAdditionOrder = (order: SettleOrder) => Boolean(order.servedAt) && dispatchRequired(order.location);

/** Payment / completion must wait until added lines on a served order have been handed over. */
export const hasPendingAdditions = (order: SettleOrder) => isUndeductedAdditionOrder(order) && order.items.some((item) => item.addedAfterSend);
