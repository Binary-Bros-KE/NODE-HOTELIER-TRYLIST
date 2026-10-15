import type { NextFunction, Request, Response } from "express";
import type { BusinessProfile, ModuleKey, TenantWebsite } from "@prisma/client";

import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";

// Resolves which tenant's public website a request is for, from the hostname
// the visitor typed — never from x-tenant-id. The WEBSITE app forwards that
// hostname as the x-site-host header (or ?host=), since the API's own Host
// header is always the API's.
//
//   <slug>.SITE_DOMAIN      → tenant by slug (one wildcard cert covers all)
//   <slug>.localhost        → same, outside production only (local dev)
//   anything else           → an ACTIVE TenantDomain (custom domain)

export type PublicSite = {
  tenantId: string;
  slug: string;
  name: string;
  /** Host search engines should index — the primary custom domain if any. */
  canonicalHost: string | null;
  website: TenantWebsite;
  profile: BusinessProfile | null;
  modules: Set<ModuleKey>;
};

/** Lowercase, no port, no trailing dot; null for anything that isn't a plausible hostname. */
export function normaliseHost(raw: string | undefined): string | null {
  if (!raw) return null;
  const host = raw.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (host.length < 3 || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

/** The tenant slug a platform-owned website host names, or null if the host isn't one. */
function slugFromSiteHost(host: string): string | null {
  const parents = [env.SITE_DOMAIN, env.NODE_ENV !== "production" ? "localhost" : undefined].filter(Boolean) as string[];
  for (const parent of parents) {
    if (!host.endsWith(`.${parent}`)) continue;
    const label = host.slice(0, -(parent.length + 1));
    return label.includes(".") ? null : label;
  }
  return null;
}

/** Tenant id for a website host, whether or not the site is published —
 * also what decides if Caddy may issue a certificate for it. */
export async function tenantIdForHost(host: string): Promise<string | null> {
  const slug = slugFromSiteHost(host);
  if (slug) {
    const tenant = await prisma.tenant.findFirst({
      where: { slug, isActive: true, tenantModules: { some: { moduleKey: "WEBSITE", isEnabled: true } } },
      select: { id: true },
    });
    return tenant?.id ?? null;
  }
  const domain = await prisma.tenantDomain.findFirst({
    where: { hostname: host, status: "ACTIVE", tenant: { isActive: true, tenantModules: { some: { moduleKey: "WEBSITE", isEnabled: true } } } },
    select: { tenantId: true },
  });
  return domain?.tenantId ?? null;
}

async function loadSite(host: string): Promise<PublicSite | null> {
  const tenantId = await tenantIdForHost(host);
  if (!tenantId) return null;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true, slug: true, name: true,
      website: true,
      businessProfile: true,
      tenantModules: { where: { isEnabled: true }, select: { moduleKey: true } },
      websiteDomains: { where: { status: "ACTIVE", isPrimary: true }, select: { hostname: true }, take: 1 },
    },
  });
  if (!tenant?.website || tenant.website.status !== "PUBLISHED") return null;
  return {
    tenantId: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    canonicalHost: tenant.websiteDomains[0]?.hostname ?? (env.SITE_DOMAIN ? `${tenant.slug}.${env.SITE_DOMAIN}` : null),
    website: tenant.website,
    profile: tenant.businessProfile,
    modules: new Set(tenant.tenantModules.map((m) => m.moduleKey)),
  };
}

// Short-lived per-host cache: every page render hits /resolve plus a content
// endpoint, and the site config rarely changes. Misses are cached too, so a
// bot hammering unknown hosts can't turn each request into DB queries.
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 1000;
const cache = new Map<string, { at: number; site: PublicSite | null }>();

export async function siteForHost(host: string): Promise<PublicSite | null> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.site;
  const site = await loadSite(host);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(host, { at: Date.now(), site });
  return site;
}

/** Call after the platform admin changes a site, so the change shows at once. */
export function invalidateSiteCache(): void {
  cache.clear();
}

/** Attaches req.site, or 404s — an unknown, unpublished or switched-off site
 * looks exactly the same from outside. */
export async function requireSite(req: Request, res: Response, next: NextFunction): Promise<void> {
  const host = normaliseHost(req.header("x-site-host") ?? (typeof req.query.host === "string" ? req.query.host : undefined));
  if (!host) { res.status(400).json({ error: "Missing site host" }); return; }
  const site = await siteForHost(host);
  if (!site) { res.status(404).json({ error: "Site not found" }); return; }
  req.site = site;
  next();
}

/** What a published site offers, from its feature flags AND the modules
 * behind them — a flag left on after its module is switched off stays dark. */
export function siteFeatures(site: PublicSite) {
  const w = site.website;
  const rooms = site.modules.has("ROOMS");
  const sales = site.modules.has("POS");
  const services = site.modules.has("SERVICE_CENTER");
  return {
    rooms,
    roomBooking: rooms && site.modules.has("RESERVATIONS") && w.featureRoomBooking,
    menu: sales && w.featureMenu,
    services,
    appointments: services && w.featureAppointments,
    memberships: services && w.featureMemberships,
    inquiries: w.featureInquiries,
  };
}
export type SiteFeature = keyof ReturnType<typeof siteFeatures>;

export function requireFeature(feature: SiteFeature) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.site || !siteFeatures(req.site)[feature]) { res.status(404).json({ error: "Not available on this site" }); return; }
    next();
  };
}
