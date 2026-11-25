/**
 * Omega — standard contact details from marketing (Oct 2026). Re-running changes nothing.
 *   Location: "Karatina | Nyeri - Nairobi Highway" · Phone 0795106483 (one number)
 *   WhatsApp 0116111170 · info@omegagardenshotelandspa.com · new Facebook and TikTok
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
dotenv.config();

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;

const LOCATION = "Karatina | Nyeri - Nairobi Highway";

await prisma.businessProfile.update({
  where: { tenantId: tid },
  data: { primaryPhone: "0795106483", alternativePhone: null, email: "info@omegagardenshotelandspa.com", address: "Nyeri - Nairobi Highway", city: "Karatina", county: "Nyeri", country: "Kenya" },
});
console.log("  business profile: phone, email, address");

const w = await prisma.tenantWebsite.findUniqueOrThrow({ where: { tenantId: tid } });
await prisma.tenantWebsite.update({
  where: { tenantId: tid },
  data: {
    displayAddress: LOCATION,
    whatsappNumber: "+254116111170",
    socialLinks: {
      ...(w.socialLinks ?? {}),
      facebook: "https://www.facebook.com/share/19bGEsjZh2/",
      tiktok: "https://www.tiktok.com/@omega_hotel_garden_spa",
    },
    tagline: "A garden retreat in Karatina, on the Nyeri - Nairobi Highway",
    seoDescription: "Garden rooms, a refreshing pool, spa and wellness, and all-day dining in Karatina, on the Nyeri - Nairobi Highway.",
  },
});
console.log("  website: address line, WhatsApp, Facebook, TikTok, tagline, description");

// Page copy: the old "Karatina–Nairobi Highway" wording and the hero eyebrow.
const swaps = [
  ["Karatina · Kenya", LOCATION],
  ["just off the Karatina–Nairobi Highway", "just off the Nyeri - Nairobi Highway in Karatina"],
  ["along the Karatina–Nairobi Highway", "along the Nyeri - Nairobi Highway in Karatina"],
  ["Karatina–Nairobi Highway", "Nyeri - Nairobi Highway"],
];
const swap = (v) => {
  if (v == null) return v;
  let s = JSON.stringify(v);
  for (const [a, b] of swaps) s = s.split(a).join(b);
  return JSON.parse(s);
};
for (const p of await prisma.websitePage.findMany({ where: { tenantId: tid } })) {
  const sections = swap(p.sections);
  const draftSections = swap(p.draftSections);
  if (JSON.stringify(sections) === JSON.stringify(p.sections) && JSON.stringify(draftSections) === JSON.stringify(p.draftSections)) continue;
  await prisma.websitePage.update({ where: { id: p.id }, data: { sections, ...(p.draftSections != null ? { draftSections } : {}) } });
  console.log(`  page ${p.slug}: wording updated`);
}
await prisma.$disconnect();
