import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { orderInclude, receiptForOrder, taxSettingsFor } from "../pos/pos.routes.js";

/**
 * Public, unauthenticated receipt lookup by opaque share token. Mounted before
 * tenantContext — the token is globally unique, so it identifies the tenant on
 * its own. Read-only; returns exactly what OrderReceipt needs to render.
 */
export const publicReceiptsRouter = Router();

publicReceiptsRouter.get("/:token", async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!token || token.length < 8 || token.length > 64) {
      res.status(404).json({ error: "Receipt not found" });
      return;
    }

    const order = await prisma.posOrder.findUnique({ where: { shareToken: token }, include: orderInclude });
    if (!order) {
      res.status(404).json({ error: "Receipt not found" });
      return;
    }

    const [tax, profile] = await Promise.all([
      taxSettingsFor(order.tenantId),
      prisma.businessProfile.findUnique({
        where: { tenantId: order.tenantId },
        select: { businessName: true, address: true, city: true, primaryPhone: true, kraPin: true },
      }),
    ]);

    res.status(200).json({ order: await receiptForOrder(order, tax), profile: profile ?? null });
  } catch (error) {
    next(error);
  }
});
