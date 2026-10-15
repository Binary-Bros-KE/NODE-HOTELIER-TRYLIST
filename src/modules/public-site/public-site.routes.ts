import { Router, type Response } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { freeRoomsByType } from "../../lib/roomAvailability.js";
import { nairobiParts } from "../../lib/shifts.js";
import { normaliseHost, requireFeature, requireSite, siteFeatures, tenantIdForHost } from "./site.js";

/**
 * The public website's API — everything a tenant's site (the WEBSITE app)
 * reads. Mounted at /public/site before tenantContext and the staff-app CORS
 * policy: the tenant comes from the visitor's hostname (see site.ts), and any
 * origin may call it since custom domains can't be listed up front.
 *
 * Read-only for now. Every response is an explicit public shape — never a raw
 * row — so costs, stock links and internal notes can't leak.
 */
export const publicSiteRouter = Router();

const money = (value: Prisma.Decimal | null | undefined) => (value == null ? null : Number(value));

/** Short shared caching for content that's fine a minute stale. */
function cacheable(res: Response): void {
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
}

// Caddy's on-demand TLS "ask" endpoint: 200 = issue a certificate for this
// host, anything else = refuse. Answers for any website host a tenant owns,
// published or not (so the cert exists before launch), and nothing else —
// otherwise anyone pointing a domain at the VPS could make us mint certs.
publicSiteRouter.get("/domain-check", async (req, res) => {
  const host = normaliseHost(typeof req.query.domain === "string" ? req.query.domain : undefined);
  const ok = host ? Boolean(await tenantIdForHost(host)) : false;
  res.status(ok ? 200 : 404).end();
});

publicSiteRouter.use(requireSite);

publicSiteRouter.get("/resolve", async (req, res) => {
  const site = req.site!;
  const { website: w, profile: p } = site;
  const pages = await prisma.websitePage.findMany({
    where: { tenantId: site.tenantId, isPublished: true, showInNav: true },
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
    select: { slug: true, title: true, kind: true },
  });
  cacheable(res);
  res.json({
    site: {
      name: w.siteTitle ?? p?.businessName ?? site.name,
      slug: site.slug,
      canonicalHost: site.canonicalHost,
      businessType: p?.businessType ?? null,
      currency: p?.currency ?? "KES",
      theme: { key: w.themeKey },
      branding: {
        primaryColor: w.primaryColor ?? p?.themeBaseColor ?? null,
        accentColor: w.accentColor ?? p?.themeAccentColor ?? null,
        fontFamily: w.fontFamily ?? p?.themeFont ?? null,
        logoUrl: w.logoUrl ?? p?.logoUrl ?? null,
        faviconUrl: w.faviconUrl,
        tagline: w.tagline,
      },
      seo: { title: w.seoTitle, description: w.seoDescription, ogImageUrl: w.ogImageUrl },
      analyticsId: w.analyticsId,
      contact: {
        phone: p?.primaryPhone ?? null,
        alternativePhone: p?.alternativePhone ?? null,
        email: p?.email ?? null,
        whatsapp: w.whatsappNumber,
        address: p?.address ?? null,
        city: p?.city ?? null,
        county: p?.county ?? null,
        country: p?.country ?? null,
        mapEmbedUrl: w.mapEmbedUrl,
        latitude: money(w.latitude),
        longitude: money(w.longitude),
      },
      social: w.socialLinks,
      features: siteFeatures(site),
      nav: pages,
    },
  });
});

publicSiteRouter.get("/pages/:slug", async (req, res) => {
  const page = await prisma.websitePage.findFirst({
    where: { tenantId: req.site!.tenantId, slug: req.params.slug.toLowerCase(), isPublished: true },
    select: { slug: true, title: true, kind: true, sections: true, seoTitle: true, seoDescription: true, ogImageUrl: true },
  });
  if (!page) { res.status(404).json({ error: "Page not found" }); return; }
  cacheable(res);
  res.json({ page });
});

// ─── Rooms ────────────────────────────────────────────────────────────────

const roomTypeSelect = {
  id: true, name: true, description: true, websiteDescription: true, capacity: true,
  amenities: true, imageUrls: true, baseRate: true, taxMode: true,
  priceUnit: { select: { name: true } },
  rates: { orderBy: { price: "asc" }, select: { id: true, name: true, mealPlan: true, price: true, unit: { select: { name: true } } } },
} satisfies Prisma.RoomTypeSelect;

function publicRoomType(t: Prisma.RoomTypeGetPayload<{ select: typeof roomTypeSelect }>, defaultTaxMode: string | undefined) {
  const rates = t.rates.map((r) => ({ id: r.id, name: r.name, mealPlan: r.mealPlan, price: Number(r.price), unit: r.unit?.name ?? t.priceUnit?.name ?? null }));
  return {
    id: t.id,
    name: t.name,
    description: t.websiteDescription ?? t.description,
    capacity: t.capacity,
    amenities: t.amenities,
    imageUrls: t.imageUrls,
    // A type with rate variants is priced by them; baseRate only applies when it has none.
    priceFrom: rates.length > 0 ? rates[0].price : Number(t.baseRate),
    priceUnit: rates[0]?.unit ?? t.priceUnit?.name ?? null,
    pricesIncludeTax: (t.taxMode ?? defaultTaxMode ?? "INCLUSIVE") === "INCLUSIVE",
    rates,
  };
}

const shownRoomTypes = (tenantId: string): Prisma.RoomTypeWhereInput => ({ tenantId, isActive: true, showOnWebsite: true });

publicSiteRouter.get("/rooms", requireFeature("rooms"), async (req, res) => {
  const site = req.site!;
  const types = await prisma.roomType.findMany({ where: shownRoomTypes(site.tenantId), orderBy: { baseRate: "asc" }, select: roomTypeSelect });
  cacheable(res);
  res.json({ roomTypes: types.map((t) => publicRoomType(t, site.profile?.taxMode)) });
});

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").transform((s) => new Date(`${s}T00:00:00.000Z`)).refine((d) => !Number.isNaN(d.getTime()), "Invalid date");
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NIGHTS = 60;
const MAX_DAYS_AHEAD = 365;

const availabilitySchema = z.object({
  checkIn: ymd,
  checkOut: ymd,
  guests: z.coerce.number().int().min(1).max(50).default(1),
}).superRefine((v, ctx) => {
  const today = nairobiParts(new Date());
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  const nights = (v.checkOut.getTime() - v.checkIn.getTime()) / DAY_MS;
  if (v.checkIn.getTime() < todayUtc) ctx.addIssue({ code: "custom", path: ["checkIn"], message: "Check-in can't be in the past" });
  if (v.checkIn.getTime() > todayUtc + MAX_DAYS_AHEAD * DAY_MS) ctx.addIssue({ code: "custom", path: ["checkIn"], message: `Bookings open up to ${MAX_DAYS_AHEAD} days ahead` });
  if (nights < 1) ctx.addIssue({ code: "custom", path: ["checkOut"], message: "Check-out must be after check-in" });
  if (nights > MAX_NIGHTS) ctx.addIssue({ code: "custom", path: ["checkOut"], message: `Stays are limited to ${MAX_NIGHTS} nights online` });
});

// Registered before /rooms/:id so "availability" isn't read as an id.
publicSiteRouter.get("/rooms/availability", requireFeature("roomBooking"), async (req, res) => {
  const parsed = availabilitySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid dates", details: parsed.error.flatten() }); return; }
  const site = req.site!;
  const { checkIn, checkOut, guests } = parsed.data;
  const types = await prisma.roomType.findMany({ where: shownRoomTypes(site.tenantId), select: { id: true, capacity: true } });
  const free = await freeRoomsByType({ tenantId: site.tenantId, checkIn, checkOut, roomTypeIds: types.map((t) => t.id) });
  res.setHeader("Cache-Control", "no-store");
  res.json({
    nights: Math.round((checkOut.getTime() - checkIn.getTime()) / DAY_MS),
    availability: types.map((t) => {
      const left = free.get(t.id) ?? 0;
      const fits = t.capacity >= guests;
      // Exact counts only when scarce — enough for "only 2 left" without
      // publishing the property's occupancy.
      return { roomTypeId: t.id, available: fits && left > 0, fitsGuests: fits, roomsLeft: left > 0 && left <= 3 ? left : null };
    }),
  });
});

publicSiteRouter.get("/rooms/:id", requireFeature("rooms"), async (req, res) => {
  const site = req.site!;
  const type = await prisma.roomType.findFirst({ where: { ...shownRoomTypes(site.tenantId), id: String(req.params.id) }, select: roomTypeSelect });
  if (!type) { res.status(404).json({ error: "Room not found" }); return; }
  cacheable(res);
  res.json({ roomType: publicRoomType(type, site.profile?.taxMode) });
});

// ─── Menu ─────────────────────────────────────────────────────────────────

publicSiteRouter.get("/menu", requireFeature("menu"), async (req, res) => {
  const categories = await prisma.menuCategory.findMany({
    where: { tenantId: req.site!.tenantId, isActive: true, showOnWebsite: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true, name: true, description: true, imageUrl: true,
      menuItems: {
        where: { isActive: true, hideFromWebsite: false },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: {
          id: true, name: true, description: true, photoUrl: true, price: true, isVegetarian: true, isAvailable: true,
          variants: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }], select: { id: true, name: true, price: true } },
        },
      },
    },
  });
  cacheable(res);
  res.json({
    categories: categories
      .filter((c) => c.menuItems.length > 0)
      .map((c) => ({
        ...c,
        menuItems: c.menuItems.map((i) => ({ ...i, price: Number(i.price), variants: i.variants.map((v) => ({ ...v, price: Number(v.price) })) })),
      })),
  });
});

// ─── Services & memberships ───────────────────────────────────────────────

publicSiteRouter.get("/services", requireFeature("services"), async (req, res) => {
  const site = req.site!;
  const canBook = siteFeatures(site).appointments;
  const services = await prisma.service.findMany({
    where: { tenantId: site.tenantId, isActive: true, showOnWebsite: true, category: { isActive: true } },
    orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
    select: {
      id: true, name: true, description: true, websiteDescription: true, imageUrl: true, price: true, durationMinutes: true, bookableOnline: true,
      category: { select: { id: true, name: true } },
      variants: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }], select: { id: true, name: true, price: true, durationMinutes: true } },
    },
  });
  // Grouped by category, in the order services came back (category name).
  const groups = new Map<string, { id: string; name: string; services: unknown[] }>();
  for (const s of services) {
    const group = groups.get(s.category.id) ?? { ...s.category, services: [] };
    group.services.push({
      id: s.id,
      name: s.name,
      description: s.websiteDescription ?? s.description,
      imageUrl: s.imageUrl,
      price: Number(s.price),
      durationMinutes: s.durationMinutes,
      bookableOnline: canBook && s.bookableOnline,
      variants: s.variants.map((v) => ({ ...v, price: Number(v.price) })),
    });
    groups.set(s.category.id, group);
  }
  cacheable(res);
  res.json({ categories: [...groups.values()] });
});

publicSiteRouter.get("/memberships", requireFeature("memberships"), async (req, res) => {
  const plans = await prisma.membershipPlan.findMany({
    where: { tenantId: req.site!.tenantId, isActive: true, showOnWebsite: true },
    orderBy: { price: "asc" },
    select: { id: true, name: true, description: true, highlights: true, price: true, durationDays: true, discountPercent: true, visitLimit: true },
  });
  cacheable(res);
  res.json({ plans: plans.map((p) => ({ ...p, price: Number(p.price), discountPercent: Number(p.discountPercent) })) });
});
