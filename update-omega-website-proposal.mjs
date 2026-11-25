/**
 * Omega website — follow-ups from the Arita proposal (Oct 2026):
 *   - "Stay · Celebrate · Meet · Dine" pathways on the home page (after the welcome)
 *   - an event gallery on Weddings & Events (before its call to action)
 *   - 301s from the old site's addresses to the new pages
 * Inserts into the live pages instead of replacing them, so edits made in the admin
 * survive; re-running changes nothing.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
dotenv.config();

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;
const media = Object.fromEntries((await prisma.websiteMedia.findMany({ where: { tenantId: tid } })).map((m) => [m.fileName, m]));
const img = (file) => {
  const m = media[file];
  if (!m) throw new Error(`Missing media ${file} — run provision-omega-website.mjs first`);
  return { url: m.url, alt: m.altText ?? "" };
};

async function insertSection(slug, block, { after, before }) {
  const page = await prisma.websitePage.findUniqueOrThrow({ where: { tenantId_slug: { tenantId: tid, slug } } });
  const sections = Array.isArray(page.sections) ? [...page.sections] : [];
  if (sections.some((s) => s.id === block.id)) { console.log(`  ${slug}: ${block.id} already there`); return; }
  let at = sections.length;
  if (after) { const i = sections.findIndex((s) => s.id === after); if (i >= 0) at = i + 1; }
  if (before) { const i = sections.findIndex((s) => s.id === before); if (i >= 0) at = i; }
  sections.splice(at, 0, block);
  await prisma.websitePage.update({ where: { id: page.id }, data: { sections, ...(page.draftSections ? {} : { draftSections: Prisma.DbNull }) } });
  console.log(`  ${slug}: added ${block.id} at position ${at + 1}`);
}

await insertSection("home", {
  id: "pathways",
  type: "pathways",
  props: {
    eyebrow: "Plan your visit",
    title: "How can we host you?",
    items: [
      { title: "Stay", text: "Restful rooms with breakfast, half board or full board.", image: img("omega-room3.jpg"), link: { label: "Explore rooms", href: "/rooms" } },
      { title: "Celebrate", text: "Weddings and celebrations in the garden.", image: img("omega-wedding.png"), link: { label: "Weddings & events", href: "/events" } },
      { title: "Meet", text: "Conferences, boardrooms and team building.", image: img("omega-conference.jpg"), link: { label: "Meetings & conferences", href: "/events" } },
      { title: "Dine", text: "From the first coffee to backyard grills.", image: img("omega-breakfast.jpg"), link: { label: "See the menu", href: "/dining" } },
    ],
  },
}, { after: "welcome" });

await insertSection("events", {
  id: "gallery",
  type: "gallery",
  props: {
    eyebrow: "Moments",
    title: "Celebrations & gatherings",
    images: [
      { ...img("omega-wedding.png"), caption: "Garden weddings" },
      { ...img("omega-conference.jpg"), caption: "Conference hall" },
      { ...img("omega-boardroom.jpg"), caption: "Boardroom" },
      { ...img("omega-backyard.jpg"), caption: "The backyard" },
      { ...img("omega-teamBuilding.jpg"), caption: "Team building" },
      { ...img("omega-backyard2.jpg"), caption: "Garden dining" },
    ],
  },
}, { before: "cta" });

// The old site's routes (from its code) → the new pages.
const redirects = [
  { from: "/accomodation", to: "/rooms" },
  { from: "/restaurant-menu/*", to: "/dining" },
  { from: "/bar-menu", to: "/dining" },
  { from: "/bar", to: "/dining" },
  { from: "/gym-and-spa", to: "/wellness" },
  { from: "/wedding-grounds", to: "/events" },
  { from: "/children-activities", to: "/" },
];
await prisma.tenantWebsite.update({ where: { tenantId: tid }, data: { redirects } });
console.log(`  redirects: ${redirects.length}`);
await prisma.$disconnect();
