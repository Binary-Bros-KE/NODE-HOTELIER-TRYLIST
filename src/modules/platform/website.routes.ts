import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { Router, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import multer from "multer";
import { z } from "zod";

import { env } from "../../config/env.js";
import { cloudflareConfigured, customHostnameLive, customHostnameWaiting, ensureCustomHostname, removeCustomHostname } from "../../lib/cloudflare.js";
import { prisma } from "../../lib/prisma.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { createPreviewToken, invalidateSiteCache, normaliseHost } from "../public-site/site.js";

/**
 * Platform admin ▸ tenant ▸ Website. Everything about a tenant's public site:
 * settings & branding, publishing, pages (draft → publish), custom domains,
 * media, and which rooms/menu/services/plans show online. Mounted under
 * /api/platform/tenants/:tenantId/website, behind platformAuth.
 *
 * Every write clears the public-site cache so the change shows immediately.
 */
export const websiteAdminRouter = Router({ mergeParams: true });

const tid = (req: Request): string => String(req.params.tenantId);
const pid = (req: Request, key: string): string => String(req.params[key]);

function invalid(res: Response, label: string, error: z.ZodError) {
  res.status(400).json({ error: `Invalid ${label}`, details: error.flatten() });
}

// Same reserved routes the WEBSITE app owns. "home" is the landing page; the
// others are built-in pages whose WebsitePage row only adds intro/extra blocks.
const SYSTEM_SLUGS = ["rooms", "dining", "services", "memberships", "contact"] as const;
// Paths the WEBSITE app itself uses — never a page slug.
const RESERVED_SLUGS = new Set(["site-preview", "api", "uploads", "_next", "sitemap.xml", "robots.txt", "book", "booking"]);

function kindForSlug(slug: string): "HOME" | "SYSTEM" | "STANDARD" {
  if (slug === "home") return "HOME";
  return (SYSTEM_SLUGS as readonly string[]).includes(slug) ? "SYSTEM" : "STANDARD";
}

/** Where the site lives: primary custom domain, else <slug>.SITE_DOMAIN, else local dev. */
function siteUrlFor(slug: string, primaryDomain: string | null): string | null {
  if (primaryDomain) return `https://${primaryDomain}`;
  if (env.SITE_DOMAIN) return `https://${slug}.${env.SITE_DOMAIN}`;
  return env.NODE_ENV !== "production" ? `http://${slug}.localhost:3000` : null;
}

// ─── Field helpers ────────────────────────────────────────────────────────

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const text = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable());
const hex = z.preprocess(blankToNull, z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a #rrggbb colour").nullable());
/** An absolute http(s) URL or one of our own /uploads/ paths. */
const imageRef = z.preprocess(
  blankToNull,
  z.string().trim().max(1000).refine((v) => /^https?:\/\//i.test(v) || v.startsWith("/uploads/"), "Use a full https:// link or an uploaded image").nullable(),
);
const mapEmbed = z.preprocess(
  blankToNull,
  z.string().trim().url().max(2000).refine((v) => /^https:\/\/(www\.)?google\.com\/maps\/embed/.test(v), "Paste the src of Google Maps' “Embed a map” code").nullable(),
);
const SOCIAL_NETWORKS = ["facebook", "instagram", "tiktok", "x", "youtube", "tripadvisor", "google", "linkedin"] as const;

// Paths only (no //host tricks); "to" may also be a full https URL.
const redirectPath = z.string().trim().max(300).regex(/^\/(?!\/)[^\s?#]*$/, "Start with / — e.g. /accomodation");
const redirectRule = z.object({
  from: redirectPath,
  to: z.union([redirectPath, z.string().trim().url().max(500).refine((v) => v.startsWith("https://"), "Use https://")]),
});

const settingsSchema = z.object({
  themeKey: z.string().trim().min(1).max(40).default("aurora"),
  primaryColor: hex.default(null),
  accentColor: hex.default(null),
  fontFamily: text(40).default(null),
  logoUrl: imageRef.default(null),
  faviconUrl: imageRef.default(null),
  siteTitle: text(120).default(null),
  tagline: text(200).default(null),
  seoTitle: text(120).default(null),
  seoDescription: text(320).default(null),
  ogImageUrl: imageRef.default(null),
  analyticsId: z.preprocess(blankToNull, z.string().trim().regex(/^[A-Z0-9-]{4,40}$/i, "Use the measurement ID, e.g. G-XXXXXXX").nullable()).default(null),
  displayAddress: text(160).default(null),
  whatsappNumber: z.preprocess(blankToNull, z.string().trim().regex(/^\+?[\d\s-]{7,20}$/, "Use an international number, e.g. +254 7…").nullable()).default(null),
  mapEmbedUrl: mapEmbed.default(null),
  latitude: z.preprocess(blankToNull, z.coerce.number().min(-90).max(90).nullable()).default(null),
  longitude: z.preprocess(blankToNull, z.coerce.number().min(-180).max(180).nullable()).default(null),
  socialLinks: z.partialRecord(z.enum(SOCIAL_NETWORKS), z.string().trim().url().max(500)).default({}),
  featureRoomBooking: z.boolean().default(false),
  featureMenu: z.boolean().default(false),
  featureAppointments: z.boolean().default(false),
  featureMemberships: z.boolean().default(false),
  featureInquiries: z.boolean().default(true),
  bookingConfirmation: z.enum(["AUTO", "MANUAL"]).default("MANUAL"),
  requirePayment: z.boolean().default(false),
  depositPercent: z.coerce.number().min(1).max(100).default(100),
  depositMinimum: z.coerce.number().min(0).max(10_000_000).default(0),
  holdMinutes: z.coerce.number().int().min(5).max(24 * 60).default(30),
  bookingLocationId: z.preprocess(blankToNull, z.string().trim().min(1).nullable()).default(null),
  redirects: z.array(redirectRule).max(200).default([]),
});
const settingsUpdateSchema = partialNoDefaults(settingsSchema);

// ─── Overview ─────────────────────────────────────────────────────────────

websiteAdminRouter.get("/", async (req, res) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tid(req) },
    select: {
      id: true, slug: true, name: true,
      website: true,
      tenantModules: { where: { moduleKey: "WEBSITE" }, select: { isEnabled: true } },
      websiteDomains: { orderBy: { createdAt: "asc" } },
      websitePages: {
        orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
        select: { id: true, slug: true, title: true, kind: true, isPublished: true, showInNav: true, sortOrder: true, updatedAt: true, draftSections: true },
      },
      locations: { where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } },
    },
  });
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
  const themes = await prisma.websiteTheme.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
  const primary = tenant.websiteDomains.find((d) => d.isPrimary && d.status === "ACTIVE")?.hostname ?? null;
  const siteUrl = siteUrlFor(tenant.slug, primary);
  res.json({
    website: tenant.website,
    moduleEnabled: tenant.tenantModules[0]?.isEnabled ?? false,
    themes,
    domains: tenant.websiteDomains,
    pages: tenant.websitePages.map(({ draftSections, ...p }) => ({ ...p, hasDraft: draftSections != null })),
    locations: tenant.locations,
    siteUrl,
    // Opens the site as it would look with every draft published.
    previewUrl: siteUrl ? `${siteUrl}/site-preview?token=${encodeURIComponent(createPreviewToken(tenant.id))}` : null,
    systemSlugs: SYSTEM_SLUGS,
    siteDomain: env.SITE_DOMAIN ?? null,
    // Where clients point their own domain (CNAME); null = not set up on this server.
    cnameTarget: env.SITE_CNAME_TARGET ?? null,
  });
});

/** Creates the site on first save (theme defaults to aurora), updates it after. */
websiteAdminRouter.put("/", async (req, res) => {
  const tenantId = tid(req);
  const existing = await prisma.tenantWebsite.findUnique({ where: { tenantId }, select: { id: true } });
  const parsed = existing ? settingsUpdateSchema.safeParse(req.body) : settingsSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, "website settings", parsed.error); return; }
  const data = parsed.data;

  if (data.themeKey && !(await prisma.websiteTheme.findFirst({ where: { key: data.themeKey, isActive: true }, select: { key: true } }))) {
    res.status(400).json({ error: "That theme isn't available" }); return;
  }
  if (data.bookingLocationId && !(await prisma.location.findFirst({ where: { id: data.bookingLocationId, tenantId }, select: { id: true } }))) {
    res.status(400).json({ error: "That location doesn't belong to this tenant" }); return;
  }

  const website = existing
    ? await prisma.tenantWebsite.update({ where: { tenantId }, data })
    : await prisma.tenantWebsite.create({ data: { ...(data as z.infer<typeof settingsSchema>), tenantId } });
  invalidateSiteCache();
  res.json({ website });
});

const statusSchema = z.object({ status: z.enum(["DRAFT", "PUBLISHED", "SUSPENDED"]) });

websiteAdminRouter.post("/status", async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, "status", parsed.error); return; }
  const tenantId = tid(req);
  const { status } = parsed.data;
  if (status === "PUBLISHED") {
    const module = await prisma.tenantModule.findUnique({ where: { tenantId_moduleKey: { tenantId, moduleKey: "WEBSITE" } }, select: { isEnabled: true } });
    if (!module?.isEnabled) { res.status(409).json({ error: "Enable the Website module for this tenant before publishing" }); return; }
  }
  const updated = await prisma.tenantWebsite.updateMany({
    where: { tenantId },
    data: { status, ...(status === "PUBLISHED" ? { publishedAt: new Date() } : {}) },
  });
  if (!updated.count) { res.status(404).json({ error: "Save the website settings first" }); return; }
  invalidateSiteCache();
  res.json({ website: await prisma.tenantWebsite.findUnique({ where: { tenantId } }) });
});

// ─── Pages ────────────────────────────────────────────────────────────────

const slugSchema = z.string().trim().toLowerCase().min(1).max(60)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Use lowercase letters, numbers and hyphens")
  .refine((s) => !RESERVED_SLUGS.has(s), "That address is reserved");

const pageMetaSchema = z.object({
  slug: slugSchema,
  title: z.string().trim().min(1).max(120),
  seoTitle: text(120).default(null),
  seoDescription: text(320).default(null),
  ogImageUrl: imageRef.default(null),
  showInNav: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  isPublished: z.boolean().default(false),
});
const pageMetaUpdateSchema = partialNoDefaults(pageMetaSchema);

const MAX_SECTIONS_BYTES = 200_000;
const sectionsSchema = z.array(z.object({
  id: z.string().trim().min(1).max(60),
  type: z.string().trim().min(1).max(40),
  props: z.record(z.string(), z.unknown()),
})).max(40);

/** Shape-checks blocks and that the tenant's theme can render each type.
 * Prop-level validation (with defaults) lives in the WEBSITE app's schemas. */
async function validateSections(tenantId: string, raw: unknown): Promise<{ ok: true; sections: z.infer<typeof sectionsSchema> } | { ok: false; error: string }> {
  const parsed = sectionsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Sections must be a list of { id, type, props } blocks (40 at most)" };
  if (JSON.stringify(parsed.data).length > MAX_SECTIONS_BYTES) return { ok: false, error: "This page has too much content — split it into more pages" };
  const website = await prisma.tenantWebsite.findUnique({ where: { tenantId }, select: { theme: { select: { sectionTypes: true, name: true } } } });
  const allowed = new Set(website?.theme.sectionTypes ?? []);
  const unknown = parsed.data.find((s) => !allowed.has(s.type));
  if (unknown) return { ok: false, error: `The ${website?.theme.name ?? "current"} theme has no “${unknown.type}” section` };
  return { ok: true, sections: parsed.data };
}

async function findPage(req: Request) {
  return prisma.websitePage.findFirst({ where: { id: pid(req, "pageId"), tenantId: tid(req) } });
}

websiteAdminRouter.get("/pages/:pageId", async (req, res) => {
  const page = await findPage(req);
  if (!page) { res.status(404).json({ error: "Page not found" }); return; }
  res.json({ page });
});

websiteAdminRouter.post("/pages", async (req, res) => {
  const tenantId = tid(req);
  const parsed = pageMetaSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, "page", parsed.error); return; }
  if (!(await prisma.tenantWebsite.findUnique({ where: { tenantId }, select: { id: true } }))) {
    res.status(409).json({ error: "Save the website settings first" }); return;
  }
  const page = await prisma.websitePage.create({
    data: { ...parsed.data, tenantId, kind: kindForSlug(parsed.data.slug), sections: [], draftSections: [] },
  });
  invalidateSiteCache();
  res.status(201).json({ page });
});

websiteAdminRouter.patch("/pages/:pageId", async (req, res) => {
  const parsed = pageMetaUpdateSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, "page", parsed.error); return; }
  const page = await findPage(req);
  if (!page) { res.status(404).json({ error: "Page not found" }); return; }
  const data = parsed.data;
  const updated = await prisma.websitePage.update({
    where: { id: page.id },
    data: { ...data, ...(data.slug ? { kind: kindForSlug(data.slug) } : {}) },
  });
  invalidateSiteCache();
  res.json({ page: updated });
});

/** Saves the working copy only — the live page is untouched until publish. */
websiteAdminRouter.put("/pages/:pageId/draft", async (req, res) => {
  const page = await findPage(req);
  if (!page) { res.status(404).json({ error: "Page not found" }); return; }
  const result = await validateSections(page.tenantId, (req.body as { sections?: unknown })?.sections);
  if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  const updated = await prisma.websitePage.update({ where: { id: page.id }, data: { draftSections: result.sections as Prisma.InputJsonValue } });
  res.json({ page: updated });
});

websiteAdminRouter.post("/pages/:pageId/publish", async (req, res) => {
  const page = await findPage(req);
  if (!page) { res.status(404).json({ error: "Page not found" }); return; }
  const content = page.draftSections ?? page.sections;
  const result = await validateSections(page.tenantId, content);
  if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  const updated = await prisma.websitePage.update({
    where: { id: page.id },
    data: { sections: result.sections as Prisma.InputJsonValue, draftSections: Prisma.DbNull, isPublished: true },
  });
  invalidateSiteCache();
  res.json({ page: updated });
});

websiteAdminRouter.post("/pages/:pageId/discard-draft", async (req, res) => {
  const page = await findPage(req);
  if (!page) { res.status(404).json({ error: "Page not found" }); return; }
  const updated = await prisma.websitePage.update({ where: { id: page.id }, data: { draftSections: Prisma.DbNull } });
  res.json({ page: updated });
});

websiteAdminRouter.delete("/pages/:pageId", async (req, res) => {
  const deleted = await prisma.websitePage.deleteMany({ where: { id: pid(req, "pageId"), tenantId: tid(req) } });
  if (!deleted.count) { res.status(404).json({ error: "Page not found" }); return; }
  invalidateSiteCache();
  res.status(204).send();
});

// ─── Custom domains ───────────────────────────────────────────────────────

const VERIFY_PREFIX = "_hotelier-verify";
const hostnameSchema = z.string().trim().transform((v, ctx) => {
  const host = normaliseHost(v.replace(/^https?:\/\//i, "").replace(/\/.*$/, ""));
  if (!host || !host.includes(".") || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
    ctx.addIssue({ code: "custom", message: "Enter a domain like www.example.com" });
    return z.NEVER;
  }
  const platform = [env.APP_DOMAIN, env.SITE_DOMAIN].filter(Boolean) as string[];
  if (platform.some((d) => host === d || host.endsWith(`.${d}`))) {
    ctx.addIssue({ code: "custom", message: "Platform addresses are added automatically — enter the client's own domain" });
    return z.NEVER;
  }
  return host;
});

websiteAdminRouter.post("/domains", async (req, res) => {
  const parsed = z.object({ hostname: hostnameSchema }).safeParse(req.body);
  if (!parsed.success) { invalid(res, "domain", parsed.error); return; }
  const taken = await prisma.tenantDomain.findUnique({ where: { hostname: parsed.data.hostname }, select: { tenantId: true } });
  if (taken) { res.status(409).json({ error: taken.tenantId === tid(req) ? "This domain is already added" : "This domain belongs to another tenant" }); return; }
  const domain = await prisma.tenantDomain.create({ data: { tenantId: tid(req), hostname: parsed.data.hostname } });
  res.status(201).json({ domain, txtRecord: { name: `${VERIFY_PREFIX}.${domain.hostname}`, value: domain.verificationToken } });
});

/**
 * Step 1: the TXT record proves the client controls the domain.
 * Step 2 (when Cloudflare for SaaS is configured): the domain is registered
 * with Cloudflare, which needs the client's CNAME and then issues the
 * certificate. Only then is it ACTIVE (until then VERIFYING, with the reason
 * in lastError). The first ACTIVE domain becomes primary. Press again to
 * re-check — each call is idempotent.
 */
websiteAdminRouter.post("/domains/:domainId/verify", async (req, res) => {
  const domain = await prisma.tenantDomain.findFirst({ where: { id: pid(req, "domainId"), tenantId: tid(req) } });
  if (!domain) { res.status(404).json({ error: "Domain not found" }); return; }
  let owned = false;
  let lastError: string | null = null;
  try {
    const records = await resolveTxt(`${VERIFY_PREFIX}.${domain.hostname}`);
    owned = records.some((chunks) => chunks.join("").trim() === domain.verificationToken);
    if (!owned) lastError = "TXT record found, but its value doesn't match";
  } catch (error) {
    const code = (error as { code?: string }).code;
    lastError = code === "ENOTFOUND" || code === "ENODATA" ? "TXT record not found yet — DNS changes can take up to an hour" : `DNS lookup failed (${code ?? "unknown error"})`;
  }

  let live = owned;
  if (owned && cloudflareConfigured()) {
    try {
      const hostname = await ensureCustomHostname(domain.hostname);
      live = customHostnameLive(hostname);
      if (!live) lastError = customHostnameWaiting(hostname);
    } catch (error) {
      live = false;
      lastError = `Couldn't register the domain with Cloudflare: ${error instanceof Error ? error.message : "unknown error"}`;
    }
  }

  const hasPrimary = live && (await prisma.tenantDomain.count({ where: { tenantId: domain.tenantId, isPrimary: true, status: "ACTIVE" } })) > 0;
  const updated = await prisma.tenantDomain.update({
    where: { id: domain.id },
    data: live
      ? { status: "ACTIVE", verifiedAt: domain.verifiedAt ?? new Date(), lastCheckedAt: new Date(), lastError: null, ...(hasPrimary ? {} : { isPrimary: true }) }
      : { status: domain.status === "ACTIVE" ? "ACTIVE" : owned ? "VERIFYING" : "FAILED", lastCheckedAt: new Date(), lastError },
  });
  invalidateSiteCache();
  res.json({ domain: updated, verified: live });
});

websiteAdminRouter.post("/domains/:domainId/primary", async (req, res) => {
  const domain = await prisma.tenantDomain.findFirst({ where: { id: pid(req, "domainId"), tenantId: tid(req) } });
  if (!domain) { res.status(404).json({ error: "Domain not found" }); return; }
  if (domain.status !== "ACTIVE") { res.status(409).json({ error: "Verify the domain before making it primary" }); return; }
  await prisma.$transaction([
    prisma.tenantDomain.updateMany({ where: { tenantId: domain.tenantId }, data: { isPrimary: false } }),
    prisma.tenantDomain.update({ where: { id: domain.id }, data: { isPrimary: true } }),
  ]);
  invalidateSiteCache();
  res.json({ domains: await prisma.tenantDomain.findMany({ where: { tenantId: domain.tenantId }, orderBy: { createdAt: "asc" } }) });
});

websiteAdminRouter.delete("/domains/:domainId", async (req, res) => {
  const domain = await prisma.tenantDomain.findFirst({ where: { id: pid(req, "domainId"), tenantId: tid(req) } });
  if (!domain) { res.status(404).json({ error: "Domain not found" }); return; }
  if (cloudflareConfigured()) {
    try {
      await removeCustomHostname(domain.hostname);
    } catch (error) {
      res.status(502).json({ error: `Couldn't remove the domain from Cloudflare: ${error instanceof Error ? error.message : "unknown error"}` });
      return;
    }
  }
  await prisma.tenantDomain.delete({ where: { id: domain.id } });
  invalidateSiteCache();
  res.status(204).send();
});

// ─── Media library ────────────────────────────────────────────────────────

const MEDIA_ROOT = path.resolve(process.cwd(), "uploads", "website");
// Raster only — SVG can carry script (same reasoning as logoUpload.ts).
const MEDIA_TYPES: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif" };

const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      // Tenant ids are cuids; refuse anything else before it touches a path.
      const tenantId = String(req.params.tenantId);
      if (!/^[a-z0-9]+$/i.test(tenantId)) { cb(new Error("Invalid tenant"), ""); return; }
      const dir = path.join(MEDIA_ROOT, tenantId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${randomBytes(6).toString("hex")}${MEDIA_TYPES[file.mimetype] ?? ""}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (!MEDIA_TYPES[file.mimetype]) { cb(new Error("Only PNG, JPG, WEBP, AVIF or GIF images are accepted")); return; }
    cb(null, true);
  },
});

websiteAdminRouter.get("/media", async (req, res) => {
  res.json({ media: await prisma.websiteMedia.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: "desc" }, take: 500 }) });
});

websiteAdminRouter.post("/media", async (req, res) => {
  // Run multer inline (as business-profile does) so a rejected file is a clear
  // 400, not a generic server error.
  const uploadError = await new Promise<unknown>((resolve) => mediaUpload.array("files", 10)(req, res, resolve));
  if (uploadError) {
    const message = uploadError instanceof multer.MulterError
      ? uploadError.code === "LIMIT_FILE_SIZE" ? "Each image must be 8 MB or smaller" : uploadError.code === "LIMIT_FILE_COUNT" ? "Upload at most 10 images at a time" : uploadError.message
      : uploadError instanceof Error ? uploadError.message : "Upload failed";
    res.status(400).json({ error: message });
    return;
  }
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) { res.status(400).json({ error: "Choose at least one image" }); return; }
  const tenantId = tid(req);
  const media = await prisma.$transaction(files.map((file) => prisma.websiteMedia.create({
    data: {
      tenantId,
      url: `/uploads/website/${tenantId}/${file.filename}`,
      fileName: file.originalname.slice(0, 200),
      mimeType: file.mimetype,
      sizeBytes: file.size,
    },
  })));
  res.status(201).json({ media });
});

websiteAdminRouter.patch("/media/:mediaId", async (req, res) => {
  const parsed = z.object({ altText: text(200) }).safeParse(req.body);
  if (!parsed.success) { invalid(res, "media", parsed.error); return; }
  const updated = await prisma.websiteMedia.updateMany({ where: { id: pid(req, "mediaId"), tenantId: tid(req) }, data: parsed.data });
  if (!updated.count) { res.status(404).json({ error: "Image not found" }); return; }
  res.json({ media: await prisma.websiteMedia.findUnique({ where: { id: pid(req, "mediaId") } }) });
});

websiteAdminRouter.delete("/media/:mediaId", async (req, res) => {
  const media = await prisma.websiteMedia.findFirst({ where: { id: pid(req, "mediaId"), tenantId: tid(req) } });
  if (!media) { res.status(404).json({ error: "Image not found" }); return; }
  await prisma.websiteMedia.delete({ where: { id: media.id } });
  const file = path.resolve(process.cwd(), media.url.replace(/^\//, ""));
  if (file.startsWith(MEDIA_ROOT + path.sep)) await fs.promises.rm(file, { force: true });
  res.status(204).send();
});

// ─── Enquiries ────────────────────────────────────────────────────────────
// Read here until hotel staff get their own inbox (see the plan's
// communications item).

websiteAdminRouter.get("/inquiries", async (req, res) => {
  const status = z.enum(["NEW", "CONTACTED", "CLOSED", "SPAM"]).optional().safeParse(req.query.status || undefined);
  res.json({
    inquiries: await prisma.websiteInquiry.findMany({
      where: { tenantId: tid(req), ...(status.success && status.data ? { status: status.data } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  });
});

websiteAdminRouter.patch("/inquiries/:inquiryId", async (req, res) => {
  const parsed = z.object({ status: z.enum(["NEW", "CONTACTED", "CLOSED", "SPAM"]) }).safeParse(req.body);
  if (!parsed.success) { invalid(res, "status", parsed.error); return; }
  const updated = await prisma.websiteInquiry.updateMany({ where: { id: pid(req, "inquiryId"), tenantId: tid(req) }, data: parsed.data });
  if (!updated.count) { res.status(404).json({ error: "Enquiry not found" }); return; }
  res.status(204).send();
});

// ─── What shows online ────────────────────────────────────────────────────

websiteAdminRouter.get("/catalog", async (req, res) => {
  const tenantId = tid(req);
  const [roomTypes, menuCategories, services, membershipPlans] = await Promise.all([
    prisma.roomType.findMany({
      where: { tenantId, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, description: true, showOnWebsite: true, websiteDescription: true, imageUrls: true, capacity: true },
    }),
    prisma.menuCategory.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true, name: true, showOnWebsite: true,
        menuItems: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, price: true, hideFromWebsite: true } },
      },
    }),
    prisma.service.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
      select: { id: true, name: true, description: true, showOnWebsite: true, bookableOnline: true, websiteDescription: true, imageUrl: true, durationMinutes: true, category: { select: { name: true } } },
    }),
    prisma.membershipPlan.findMany({
      where: { tenantId, isActive: true },
      orderBy: { price: "asc" },
      select: { id: true, name: true, price: true, showOnWebsite: true, highlights: true },
    }),
  ]);
  res.json({ roomTypes, menuCategories, services, membershipPlans });
});

const roomTypeVisibility = z.object({
  showOnWebsite: z.boolean(),
  websiteDescription: text(2000),
  imageUrls: z.array(z.string().trim().max(1000).refine((v) => /^https?:\/\//i.test(v) || v.startsWith("/uploads/"))).max(12),
}).partial();
const menuCategoryVisibility = z.object({ showOnWebsite: z.boolean() }).partial();
const menuItemVisibility = z.object({ hideFromWebsite: z.boolean() }).partial();
const serviceVisibility = z.object({ showOnWebsite: z.boolean(), bookableOnline: z.boolean(), websiteDescription: text(2000), imageUrl: imageRef }).partial();
const planVisibility = z.object({ showOnWebsite: z.boolean(), highlights: z.array(z.string().trim().min(1).max(120)).max(12) }).partial();

/** One PATCH per catalog type; each only touches the tenant's own rows. */
function catalogPatch<T extends z.ZodTypeAny>(
  schema: T,
  update: (tenantId: string, id: string, data: z.infer<T>) => Promise<{ count: number }>,
) {
  return async (req: Request, res: Response) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { invalid(res, "change", parsed.error as z.ZodError); return; }
    const { count } = await update(tid(req), pid(req, "id"), parsed.data);
    if (!count) { res.status(404).json({ error: "Not found" }); return; }
    invalidateSiteCache();
    res.status(204).send();
  };
}

websiteAdminRouter.patch("/catalog/room-types/:id", catalogPatch(roomTypeVisibility, (tenantId, id, data) => prisma.roomType.updateMany({ where: { id, tenantId }, data })));
websiteAdminRouter.patch("/catalog/menu-categories/:id", catalogPatch(menuCategoryVisibility, (tenantId, id, data) => prisma.menuCategory.updateMany({ where: { id, tenantId }, data })));
websiteAdminRouter.patch("/catalog/menu-items/:id", catalogPatch(menuItemVisibility, (tenantId, id, data) => prisma.menuItem.updateMany({ where: { id, tenantId }, data })));
websiteAdminRouter.patch("/catalog/services/:id", catalogPatch(serviceVisibility, (tenantId, id, data) => prisma.service.updateMany({ where: { id, tenantId }, data })));
websiteAdminRouter.patch("/catalog/membership-plans/:id", catalogPatch(planVisibility, (tenantId, id, data) => prisma.membershipPlan.updateMany({ where: { id, tenantId }, data })));
