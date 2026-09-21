import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma.js";
import { createDispatchRequest, dispatchRequired, lineNeedsDispatch } from "./dispatch.js";
import { addonStockInclude, computeStockRequirements, variantStockSelect } from "./stockRequirements.js";

/**
 * The store step runs itself: the moment an order (or a round added to one) is
 * posted at a store-dispatch location, its ingredients are requested from the
 * store - no chef step in between. The chef simply sees "waiting for store
 * approval". The chef's manual request stays as the fallback (after a
 * rejection, or if no store was configured when the order was posted).
 */

const stockLineInclude = {
  menuItem: { include: { product: true, recipe: { include: { ingredients: { include: { product: true } } } } } },
  variant: { select: variantStockSelect },
  addons: { include: { addon: { include: addonStockInclude } } },
} satisfies Prisma.PosOrderItemInclude;

/** Queues the store's dispatch slip for whichever device at the store has a printer. */
export async function queueDispatchSlip(
  client: Prisma.TransactionClient | typeof prisma,
  args: { tenantId: string; requestId: string; orderId: string; storeLocationId: string; requestedBy: string | null | undefined },
) {
  return client.printJob.create({
    data: { tenantId: args.tenantId, locationId: args.storeLocationId, orderId: args.orderId, kind: "DISPATCH", dispatchRequestId: args.requestId, requestedBy: args.requestedBy ?? null },
    select: { id: true },
  });
}

/**
 * Requests every not-yet-requested line of the order from the store and, where
 * the location auto-prints, queues the slip. Never throws: posting an order
 * must not fail because the store step could not start.
 */
export async function autoRequestDispatch(tenantId: string, orderId: string, actorId: string | undefined) {
  try {
    const order = await prisma.posOrder.findFirst({
      where: { id: orderId, tenantId },
      include: {
        location: { select: { id: true, serveMode: true, requireStoreDispatch: true, dispatchFromLocationId: true, dispatchAutoPrint: true } },
        items: { include: stockLineInclude },
      },
    });
    if (!order || !dispatchRequired(order.location)) return null;
    if (!order.items.some(lineNeedsDispatch)) return null;
    const request = await createDispatchRequest({ ...order, tenantId }, actorId, "Sent to the store automatically when the order was posted");
    if (order.location?.dispatchAutoPrint) {
      await queueDispatchSlip(prisma, { tenantId, requestId: request.id, orderId, storeLocationId: request.fromLocationId, requestedBy: actorId });
    }
    return request;
  } catch (error) {
    console.error("[dispatch] could not auto-request ingredients for order", orderId, error);
    return null;
  }
}

/**
 * Re-computes a still-waiting request after one of its lines was edited or
 * removed, so the store always sees what the order needs right now. A request
 * whose lines are all gone is withdrawn.
 */
export async function refreshOpenRequest(tx: Prisma.TransactionClient, tenantId: string, requestId: string) {
  const request = await tx.stockDispatchRequest.findFirst({ where: { id: requestId, tenantId, status: "REQUESTED" }, select: { id: true } });
  if (!request) return;
  const lines = await tx.posOrderItem.findMany({ where: { dispatchRequestId: requestId }, include: stockLineInclude });
  const requirements = computeStockRequirements(lines);
  if (requirements.size === 0) {
    await tx.stockDispatchRequest.update({ where: { id: requestId }, data: { status: "CANCELLED", respondedAt: new Date() } });
    await tx.posOrderItem.updateMany({ where: { dispatchRequestId: requestId }, data: { dispatchRequestId: null } });
    return;
  }
  await tx.stockDispatchItem.deleteMany({ where: { requestId } });
  await tx.stockDispatchItem.createMany({ data: [...requirements].map(([productId, r]) => ({ requestId, productId, productName: r.name, requestedQty: r.quantity })) });
}

/** Everything a printer needs to draw the slip, so the printing device needs no permissions of its own. */
export async function dispatchSlipFor(tenantId: string, requestId: string) {
  const request = await prisma.stockDispatchRequest.findFirst({
    where: { id: requestId, tenantId },
    include: {
      items: { include: { product: { select: { unit: true } } } },
      fromLocation: { select: { name: true } },
      toLocation: { select: { name: true } },
      order: { select: { table: { select: { label: true } } } },
    },
  });
  if (!request) return null;
  return {
    requestNo: request.requestNo,
    orderNumber: request.orderNumber,
    table: request.order.table?.label ?? null,
    from: request.fromLocation.name,
    to: request.toLocation.name,
    requestedByName: request.requestedByName,
    requestedAt: request.requestedAt,
    note: request.note,
    items: request.items.map((i) => ({ name: i.productName, quantity: Number(i.requestedQty), unit: i.product.unit })),
  };
}
