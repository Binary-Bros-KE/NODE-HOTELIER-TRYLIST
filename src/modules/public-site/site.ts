import { createHmac, timingSafeEqual } from "node:crypto";
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
  /** A platform admin's preview: unpublished site, draft page content, never cached. */
  preview: boolean;
};

// ─── Draft previews ───────────────────────────────────────────────────────
// The platform admin hands out a signed, expiring link; the WEBSITE app turns
// it into a cookie and forwards it as x-site-preview. A valid token for the
// host's own tenant lets that request see an unpublished site and draft pages.

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

function previewSignature(payload: string): Buffer {
  return createHmac("sha256", env.SECRETS_ENCRYPTION_KEY).update(`site-preview:${payload}`).digest();
}

export function createPreviewToken(tenantId: string, now = Date.now()): string {
  const payload = `${tenantId}.${now + PREVIEW_TTL_MS}`;
  return `${Buffer.from(payload).toString("base64url")}.${previewSignature(payload).toString("base64url")}`;
}

/** The tenant a preview token was issued for, or null if it's forged or expired. */
export function previewTenantId(token: string | undefined): string | null {
  if (!token || token.length > 300) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const payload = Buffer.from(encoded, "base64url").toString();
  const expected = previewSignature(payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [tenantId, expires] = payload.split(".");
  return tenantId && Number(expires) > Date.now() ? tenantId : null;
}

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

async function loadSite(host: string, previewFor: string | null = null): Promise<PublicSite | null> {
  const tenantId = await tenantIdForHost(host);
  if (!tenantId) return null;
  const preview = previewFor === tenantId;
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
  if (!tenant?.website || (tenant.website.status !== "PUBLISHED" && !preview)) return null;
  return {
    tenantId: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    canonicalHost: tenant.websiteDomains[0]?.hostname ?? (env.SITE_DOMAIN ? `${tenant.slug}.${env.SITE_DOMAIN}` : null),
    website: tenant.website,
    profile: tenant.businessProfile,
    modules: new Set(tenant.tenantModules.map((m) => m.moduleKey)),
    preview,
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
  // Previews skip the cache entirely — they must show the latest drafts.
  const previewFor = previewTenantId(req.header("x-site-preview"));
  const site = previewFor ? await loadSite(host, previewFor) : await siteForHost(host);
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
