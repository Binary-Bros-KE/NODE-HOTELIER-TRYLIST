import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAdmin } from "../../middleware/tenantContext.js";
import { logoUpload } from "./logoUpload.js";

// Core tenant/business identity — available regardless of which operational
// modules (POS, HR, etc.) the tenant has enabled, so this router is
// intentionally not gated by requireModule.
export const businessProfileRouter = Router();

const businessTypes = ["RESTAURANT", "CAFE", "HOTEL", "MOTEL", "CLUB"] as const;
const currencies = ["KES", "UGX", "TZS", "USD"] as const;
const taxModes = ["INCLUSIVE", "EXCLUSIVE"] as const;
const taxTreatments = ["STANDARD", "ZERO_RATED", "EXEMPT"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalEmail = z.preprocess(blankToUndefined, z.email().optional());
const optionalRate = z.preprocess(blankToUndefined, z.coerce.number().min(0).max(100).optional());

const profileSchema = z.object({
  logoUrl: optionalText(2000),
  shortName: optionalText(24),
  businessName: z.string().trim().min(1).max(150),
  businessType: z.enum(businessTypes),
  currency: z.enum(currencies),
  registrationNumber: optionalText(60),
  kraPin: optionalText(20),
  taxRate: optionalRate,
  taxMode: z.enum(taxModes).default("INCLUSIVE"),
  taxTreatment: z.enum(taxTreatments).default("STANDARD"),
  primaryPhone: optionalText(30),
  alternativePhone: optionalText(30),
  email: optionalEmail,
  website: optionalText(150),
  country: optionalText(80),
  county: optionalText(80),
  city: optionalText(80),
  address: optionalText(255),
  ownerName: optionalText(120),
  ownerPhone: optionalText(30),
  ownerEmail: optionalEmail,
});

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

businessProfileRouter.get("/", async (req, res) => {
  const profile = await prisma.businessProfile.findUnique({ where: { tenantId: tenantId(req) } });
  res.json({ profile });
});

const hexColor = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #1c74d1");
const fontKeys = ["jost", "inter", "poppins", "manrope", "dm-sans", "space-grotesk", "playfair-display", "space-mono"] as const;
const themeSchema = z.object({
  themeBaseColor: hexColor,
  themeAccentColor: hexColor,
  themeFont: z.enum(fontKeys),
});

businessProfileRouter.patch("/theme", requireAdmin, async (req, res, next) => {
  const data = themeSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid theme", details: data.error.flatten() }); return; }
  try {
    const profile = await prisma.businessProfile.upsert({
      where: { tenantId: tenantId(req) },
      create: { tenantId: tenantId(req), businessName: "My Business", businessType: "HOTEL", currency: "KES", ...data.data },
      update: data.data,
    });
    res.json({ profile });
  } catch (error) {
    next(error);
  }
});

businessProfileRouter.post("/logo", requireAdmin, (req, res, next) => {
  // Invoked inline (not as ordinary route middleware) so a multer/fileFilter
  // failure can be translated into the same { error } JSON shape every other
  // route on this router uses, instead of falling through to the generic
  // error handler as a raw stack trace.
  logoUpload.single("logo")(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "Logo must be under 5MB" });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : "Could not process the uploaded file" });
      return;
    }
    void handleLogoUpload(req, res, next);
  });
});

async function handleLogoUpload(req: Request, res: Response, next: NextFunction) {
  if (!req.file) { res.status(400).json({ error: "No logo file was provided" }); return; }
  const tid = tenantId(req);
  try {
    const existing = await prisma.businessProfile.findUnique({ where: { tenantId: tid }, select: { logoUrl: true } });
    const logoUrl = `/uploads/logos/${req.file.filename}`;
    const profile = await prisma.businessProfile.upsert({
      where: { tenantId: tid },
      create: { tenantId: tid, businessName: "My Business", businessType: "HOTEL", currency: "KES", logoUrl },
      update: { logoUrl },
    });
    res.json({ profile });
    if (existing?.logoUrl?.startsWith("/uploads/logos/")) {
      const previousPath = path.resolve(process.cwd(), existing.logoUrl.slice(1));
      fs.unlink(previousPath, () => {}); // best-effort cleanup, never fail the request over this
    }
  } catch (error) {
    next(error);
  }
}

businessProfileRouter.put("/", async (req, res, next) => {
  const data = profileSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid business profile", details: data.error.flatten() }); return; }
  try {
    const profile = await prisma.businessProfile.upsert({
      where: { tenantId: tenantId(req) },
      create: { tenantId: tenantId(req), ...data.data },
      update: data.data,
    });
    res.json({ profile });
  } catch (error) {
    next(error);
  }
});
