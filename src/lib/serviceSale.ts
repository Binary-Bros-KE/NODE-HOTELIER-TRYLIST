import type { Prisma } from "@prisma/client";
import { z } from "zod";

/**
 * One service line the way any till (the Services POS "pay now", a running
 * service tab, or a completed appointment) sends it: the service, its chosen
 * option, add-ons, and an optional price override with a reason. Shared so
 * every path that turns "a service was sold" into an order line agrees on the
 * same shape and the same rules.
 */
export const serviceLineSchema = z.object({
  serviceId: z.string().trim().min(1),
  variantId: z.string().trim().min(1).optional(),
  quantity: z.coerce.number().int().min(1).max(999),
  addons: z.array(z.object({ addonId: z.string().trim().min(1), quantity: z.coerce.number().int().min(1).max(20).default(1) })).default([]),
  // Price override at the till: the price to charge instead of the list price, with why.
  unitPrice: z.coerce.number().min(0).max(9_999_999).optional(),
  overrideReason: z.string().trim().max(200).optional(),
});
export type ServiceLineInput = z.infer<typeof serviceLineSchema>;

export type TaxFallback = { taxRate: Prisma.Decimal | number | null; taxMode: "INCLUSIVE" | "EXCLUSIVE" | null; taxTreatment: "STANDARD" | "ZERO_RATED" | "EXEMPT" | null };

/** Validates service lines against the live catalogue (option required once a service has options, add-ons only from
 * the service's own category, location allocation, price override needs a reason) and returns the order-item rows,
 * each carrying the tax, cost and price snapshot it is sold under. Shared by "Pay now" sales, started tabs, lines
 * added to a running tab, and a completed appointment. Throws { status } on the first problem. */
export async function resolveServiceLines(
  tx: Prisma.TransactionClient,
  tid: string,
  inputs: ServiceLineInput[],
  effectiveLocationId: string | null,
  userId: string | undefined,
  retailFallbackTax: TaxFallback,
  // The customer's current membership discount: applied as a price change on
  // every line that wasn't already given an explicit price at the till.
  memberDiscount?: { percent: number; label: string } | null,
): Promise<Prisma.PosOrderItemUncheckedCreateWithoutOrderInput[]> {
  const serviceIds = [...new Set(inputs.map((item) => item.serviceId))];
  const addonIds = [...new Set(inputs.flatMap((item) => item.addons.map((a) => a.addonId)))];
  const [services, serviceAddons] = await Promise.all([
    tx.service.findMany({ where: { id: { in: serviceIds }, tenantId: tid, isActive: true }, include: { locations: { select: { id: true } }, variants: { where: { isActive: true } } } }),
    addonIds.length ? tx.addon.findMany({ where: { id: { in: addonIds }, tenantId: tid, isActive: true, scope: "SERVICE" }, select: { id: true, name: true, price: true, serviceCategoryId: true } }) : Promise.resolve([]),
  ]);
  if (services.length !== serviceIds.length) throw Object.assign(new Error("Every item must be an active service from this property"), { status: 400 });
  if (serviceAddons.length !== addonIds.length) throw Object.assign(new Error("Every add-on must be an active service add-on from this property"), { status: 400 });
  // A service allocated to specific locations may only be sold there (empty = everywhere).
  const notHere = services.find((s) => s.locations.length > 0 && (!effectiveLocationId || !s.locations.some((l) => l.id === effectiveLocationId)));
  if (notHere) throw Object.assign(new Error(`"${notHere.name}" isn't sold at this location`), { status: 409 });
  const byId = new Map(services.map((s) => [s.id, s]));
  const addonById = new Map(serviceAddons.map((a) => [a.id, a]));
  return inputs.map((rawItem) => {
    const item = rawItem;
    const service = byId.get(item.serviceId)!;
    // Sizes/options: required once a service has any active ones.
    if (service.variants.length > 0 && !item.variantId) throw Object.assign(new Error(`Choose an option for "${service.name}"`), { status: 400 });
    const variant = item.variantId ? service.variants.find((v) => v.id === item.variantId) : undefined;
    if (item.variantId && !variant) throw Object.assign(new Error(`That option isn't available for "${service.name}"`), { status: 400 });
    const addonIdsOnLine = item.addons.map((a) => a.addonId);
    if (new Set(addonIdsOnLine).size !== addonIdsOnLine.length) throw Object.assign(new Error("Each add-on can only appear once per line"), { status: 400 });
    for (const line of item.addons) {
      const addon = addonById.get(line.addonId)!;
      if (addon.serviceCategoryId && addon.serviceCategoryId !== service.categoryId) throw Object.assign(new Error(`"${addon.name}" isn't offered with "${service.name}"`), { status: 400 });
    }
    const listPrice = variant?.price ?? service.price;
    if (memberDiscount && memberDiscount.percent > 0 && item.unitPrice === undefined) {
      item.unitPrice = Math.round(Number(listPrice) * (1 - memberDiscount.percent / 100) * 100) / 100;
      item.overrideReason = memberDiscount.label;
    }
    // Override: charge another price, but keep the list price and the reason on the line.
    const overridden = item.unitPrice !== undefined && Math.abs(item.unitPrice - Number(listPrice)) > 0.004;
    if (overridden && !(item.overrideReason && item.overrideReason.length >= 3)) throw Object.assign(new Error(`Give a reason for changing the price of "${service.name}"`), { status: 400 });
    return {
      serviceId: item.serviceId,
      serviceVariantId: variant?.id,
      quantity: item.quantity,
      unitPrice: overridden ? item.unitPrice! : listPrice,
      ...(overridden ? { listPrice, priceOverrideReason: item.overrideReason, priceOverriddenBy: userId } : {}),
      // The service's own tax (else the property default), frozen on the line like a menu item.
      taxRate: service.taxRate ?? retailFallbackTax.taxRate,
      taxMode: service.taxMode ?? retailFallbackTax.taxMode,
      taxTreatment: service.taxTreatment ?? retailFallbackTax.taxTreatment,
      unitCost: variant?.cost ?? service.cost,
      addons: { create: item.addons.map((line) => ({ addonId: line.addonId, quantity: line.quantity, unitPrice: addonById.get(line.addonId)!.price })) },
    };
  });
}
