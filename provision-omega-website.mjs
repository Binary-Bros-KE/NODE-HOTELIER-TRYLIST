/**
 * Omega Gardens Hotel & Spa — public website (Phase 9 launch).
 *
 * Copy and photos come from the client's current site (omegagardenshotelandspa.com);
 * room descriptions are written for the launch and should be confirmed with the client.
 * Photos are downloaded into Omega's own media library (uploads/website/<tenant>) so the
 * site doesn't depend on the old one staying up.
 *
 * Idempotent: re-running updates the same rows (media reused by file name, pages by slug).
 * Leaves the site as DRAFT unless run with --publish.
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const PUBLISH = process.argv.includes("--publish");
const OLD_SITE = "https://omegagardenshotelandspa.com";

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;
console.log(`Tenant: ${tenant.name} (${tid})`);

// ─── 1. Module ────────────────────────────────────────────────────────────
await prisma.tenantModule.upsert({
  where: { tenantId_moduleKey: { tenantId: tid, moduleKey: "WEBSITE" } },
  update: { isEnabled: true },
  create: { tenantId: tid, moduleKey: "WEBSITE", isEnabled: true },
});
console.log("Website module enabled");

// ─── 2. Photos → media library ────────────────────────────────────────────
const PHOTOS = {
  // Transparent version of the logo — the business profile's is a square on white.
  logo: ["/logo.png", "Omega Gardens Hotel & Spa"],
  accommodations: ["/home/accomodations.jpg", "A guest room at Omega Gardens"],
  swimming: ["/home/swimming.jpg", "The swimming pool"],
  backyard: ["/bar-menu/backyard/backyard.jpg", "The backyard garden"],
  backyard2: ["/bar-menu/backyard/backyard-2.jpg", "Dining in the backyard"],
  breakfast: ["/menu/breakfast.jpg", "Breakfast at Omega Gardens"],
  wedding: ["/home/wedding.png", "A wedding set-up in the gardens"],
  bar: ["/bar-menu/indoor-bar/omega-bar-indoor-1.jpg", "The indoor bar"],
  conference: ["/home/conference.jpg", "The conference hall"],
  boardroom: ["/home/boardroom.jpg", "The boardroom"],
  gym: ["/gym/gym-1.webp", "The fitness centre"],
  gymHome: ["/home/gym.jpeg", "Training at the gym"],
  playground: ["/kids/playground.jpg", "The children's playground"],
  barbershop: ["/home/barbershop.jpg", "The barbershop"],
  teamBuilding: ["/gym/teambulding.jpg", "A team building session"],
  room1: ["/accomodations/room-1.jpg", "A Standard room"],
  room2: ["/accomodations/room-2.jpg", "A Superior room"],
  room3: ["/accomodations/room-3.jpg", "A Deluxe room"],
  room4: ["/accomodations/room-4.jpg", "A Superior room"],
  room5: ["/accomodations/room-5.jpg", "A Deluxe room"],
  room6: ["/accomodations/room-6.jpg", "A Standard room"],
};
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const mediaDir = path.resolve(process.cwd(), "uploads", "website", tid);
fs.mkdirSync(mediaDir, { recursive: true });

const url = {};
for (const [key, [remote, alt]] of Object.entries(PHOTOS)) {
  const fileName = `omega-${key}${path.extname(remote).toLowerCase()}`;
  const existing = await prisma.websiteMedia.findFirst({ where: { tenantId: tid, fileName } });
  if (existing && fs.existsSync(path.join(mediaDir, fileName))) { url[key] = existing.url; continue; }
  const res = await fetch(`${OLD_SITE}${remote}`);
  if (!res.ok) throw new Error(`Could not download ${remote}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(mediaDir, fileName), bytes);
  const mediaUrl = `/uploads/website/${tid}/${fileName}`;
  const data = { tenantId: tid, url: mediaUrl, fileName, mimeType: MIME[path.extname(fileName)] ?? "image/jpeg", sizeBytes: bytes.length, altText: alt, tags: ["launch"] };
  if (existing) await prisma.websiteMedia.update({ where: { id: existing.id }, data });
  else await prisma.websiteMedia.create({ data });
  url[key] = mediaUrl;
  console.log(`  photo ${fileName} (${Math.round(bytes.length / 1024)} KB)`);
}
console.log(`Media library: ${Object.keys(url).length} photos`);
const img = (key) => ({ url: url[key], alt: PHOTOS[key][1] });

// ─── 3. Website settings ──────────────────────────────────────────────────
const reception = await prisma.location.findFirstOrThrow({ where: { tenantId: tid, type: "RECEPTION", isActive: true } });
const settings = {
  themeKey: "aurora",
  // The profile's #1c9b5e reads loud; a deep garden green, softened further by the theme.
  primaryColor: "#2F4A3E",
  accentColor: "#B4935A",
  siteTitle: "Omega Gardens Hotel & Spa",
  logoUrl: url.logo,
  tagline: "A garden retreat on the Karatina–Nairobi Highway",
  seoTitle: "Omega Gardens Hotel & Spa — Karatina",
  seoDescription: "Garden rooms, a refreshing pool, spa and wellness, and all-day dining along the Karatina–Nairobi Highway.",
  ogImageUrl: url.accommodations,
  whatsappNumber: "+254795106483",
  mapEmbedUrl: "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3989.6754390408682!2d37.131234574041116!3d-0.48489763527337687!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x182887fbbe128361%3A0x83db3009f7951c38!2sOmega%20Gardens%20Hotel!5e0!3m2!1sen!2ske!4v1754922637639!5m2!1sen!2ske",
  latitude: -0.484898,
  longitude: 37.133809,
  socialLinks: {
    facebook: "https://www.facebook.com/theomegaleisuregardens",
    instagram: "https://www.instagram.com/omegagardens_/",
    tiktok: "https://www.tiktok.com/tag/omegagardenhotelkaratina",
  },
  featureRoomBooking: true,
  featureMenu: true,
  featureInquiries: true,
  featureAppointments: false,
  featureMemberships: false,
  bookingConfirmation: "MANUAL",
  requirePayment: false,
  bookingLocationId: reception.id,
};
await prisma.tenantWebsite.upsert({
  where: { tenantId: tid },
  update: settings,
  create: { ...settings, tenantId: tid, status: "DRAFT" },
});
console.log("Website settings saved");

// ─── 4. What shows online ─────────────────────────────────────────────────
const ROOMS = {
  Standard: ["A calm, well-appointed room for a restful night — everything you need, nothing you don't.", ["room1", "room6"]],
  Superior: ["More space to settle in, with a comfortable seating corner and soft garden light.", ["room2", "room4"]],
  Deluxe: ["Our most generous rooms, finished for longer stays and slower mornings.", ["room3", "room5"]],
};
const roomTypeIds = {};
for (const [name, [description, photos]] of Object.entries(ROOMS)) {
  const rt = await prisma.roomType.findFirstOrThrow({ where: { tenantId: tid, name } });
  await prisma.roomType.update({ where: { id: rt.id }, data: { showOnWebsite: true, websiteDescription: description, imageUrls: photos.map((k) => url[k]) } });
  roomTypeIds[name] = rt.id;
}
await prisma.roomType.updateMany({ where: { tenantId: tid, name: { notIn: Object.keys(ROOMS) } }, data: { showOnWebsite: false } });
console.log("Rooms online: " + Object.keys(ROOMS).join(", "));

// Food and soft drinks; the bar list (alcohol), cigarettes and add-ons stay hidden.
const MENU = [
  "Breakfast", "Omega Specials", "Snacks & Pastries", "Salads", "Soups", "Starters & Bitings", "Sandwiches",
  "Burgers", "Pizza Corner", "Pasta & Noodles", "Indian Dishes", "Beef", "Chicken", "Mutton", "Pork", "Fish",
  "Platters", "Vegetables & Sides", "Kids Menu", "Desserts", "Hot Beverages", "Cold Beverages", "Soft Drinks",
];
const shown = await prisma.menuCategory.updateMany({ where: { tenantId: tid, name: { in: MENU } }, data: { showOnWebsite: true } });
await prisma.menuCategory.updateMany({ where: { tenantId: tid, name: { notIn: MENU } }, data: { showOnWebsite: false } });
console.log(`Menu categories online: ${shown.count}`);

// ─── 5. Pages ─────────────────────────────────────────────────────────────
const sec = (id, type, props) => ({ id, type, props });
const PAGES = [
  {
    slug: "home", title: "Home", kind: "HOME", showInNav: false, sortOrder: 0,
    sections: [
      sec("hero", "hero", {
        eyebrow: "Karatina · Kenya",
        title: "Where the garden slows the day",
        subtitle: "Quiet rooms, a sunlit pool and unhurried dining — just off the Karatina–Nairobi Highway.",
        images: [img("accommodations"), img("swimming"), img("backyard")],
        primaryCta: { label: "Explore rooms", href: "/rooms" },
        secondaryCta: { label: "Discover dining", href: "/dining" },
        showBookingBar: true, height: "full",
      }),
      sec("welcome", "rich-text", {
        eyebrow: "Welcome",
        title: "Quiet luxury, rooted in the garden",
        body: "Omega Gardens Hotel & Spa is a place to arrive and exhale. Set in leafy grounds along the Karatina–Nairobi Highway, it brings together restful rooms, a refreshing pool, wellness and grooming, and a kitchen that runs from the first coffee to the last cocktail.\n\nWhether you are passing through, gathering your team or celebrating the day of your life, we take care of every detail — so you can simply be here.",
        align: "center",
        signature: "Open daily · 6:00 AM – 11:00 PM",
      }),
      sec("rooms", "rooms-showcase", {
        eyebrow: "Stay", title: "Rooms & Suites",
        intro: "Three categories of room, each for one or two guests, with bed & breakfast, half board or full board.",
        roomTypeIds: [roomTypeIds.Standard, roomTypeIds.Superior, roomTypeIds.Deluxe], limit: 3,
        cta: { label: "View all rooms", href: "/rooms" },
      }),
      sec("dining", "image-text", {
        eyebrow: "Dine", title: "Our culinary experience",
        body: "Start your day with carefully crafted breakfast selections and artisanal coffee, linger over a long lunch, or gather for golden-hour grills in the backyard. From hearty morning meals to afternoon pick-me-ups, there is something for every moment.",
        image: img("breakfast"), imageSide: "left",
        bullets: ["Breakfast served from 6:00 AM", "Omega breakfast buffet", "Backyard BBQ & steaks", "Kids' menu"],
        cta: { label: "View the menu", href: "/dining" }, tone: "light",
      }),
      sec("amenities", "amenities", {
        eyebrow: "The grounds", title: "Everything within the garden walls", tone: "sand",
        items: [
          { icon: "pool", title: "Swimming Pool", text: "A refreshing pool, with a shallow pool just for children." },
          { icon: "spa", title: "Spa & Wellness", text: "Complete mind, body and soul rejuvenation." },
          { icon: "gym", title: "Fitness Centre", text: "Modern equipment and certified trainers." },
          { icon: "conference", title: "Conference & Boardrooms", text: "Professional spaces for meetings of every size." },
          { icon: "bar", title: "Bar & Cellar", text: "Premium spirits, signature cocktails and a curated wine list." },
          { icon: "kids", title: "Kids' Garden", text: "Playgrounds, trampolines and skating, safely supervised." },
          { icon: "grooming", title: "Barbershop", text: "Traditional craft, modern comfort." },
          { icon: "events", title: "Weddings & Events", text: "From intimate ceremonies to grand receptions." },
        ],
      }),
      sec("menu", "menu-highlights", {
        eyebrow: "From the kitchen", title: "A taste of the menu",
        categories: ["Breakfast", "Beef", "Fish", "Platters"], itemsPerCategory: 4,
        cta: { label: "See the full menu", href: "/dining" },
      }),
      sec("weddings", "image-text", {
        eyebrow: "Celebrate", title: "Weddings & events in the garden",
        body: "From intimate ceremonies to grand receptions, our team brings your vision to life with elegance and attention to every detail. Conferences, team building and private dinners are planned with the same care.",
        image: img("wedding"), imageSide: "right", cta: { label: "Plan your event", href: "/events" }, tone: "sand",
      }),
      sec("gallery", "gallery", {
        eyebrow: "Moments", title: "Life at Omega Gardens",
        images: [
          { ...img("swimming"), caption: "The pool" },
          { ...img("bar"), caption: "The bar" },
          { ...img("conference"), caption: "Conference hall" },
          { ...img("backyard2"), caption: "The backyard" },
          { ...img("gym"), caption: "Fitness" },
          { ...img("playground"), caption: "Kids' garden" },
        ],
      }),
      sec("cta", "cta", {
        eyebrow: "Plan your stay", title: "We would love to welcome you",
        intro: "Call us, send a message on WhatsApp, or check availability online.",
        image: { url: url.swimming, alt: "" },
        primaryCta: { label: "Check availability", href: "/rooms" },
        secondaryCta: { label: "Call 0795 106 483", href: "tel:+254795106483" },
      }),
      sec("contact", "contact-map", { eyebrow: "Visit", title: "Find us", hours: "Monday – Sunday · 6:00 AM – 11:00 PM", showMap: true }),
    ],
  },
  { slug: "rooms", title: "Rooms & Suites", kind: "SYSTEM", showInNav: true, sortOrder: 10, sections: [] },
  { slug: "dining", title: "Dining", kind: "SYSTEM", showInNav: true, sortOrder: 20, sections: [] },
  {
    slug: "wellness", title: "Spa & Wellness", kind: "STANDARD", showInNav: true, sortOrder: 30,
    seoDescription: "Fitness, spa and professional grooming at Omega Gardens, Karatina.",
    sections: [
      sec("intro", "rich-text", {
        eyebrow: "Your wellness journey starts here", title: "Body, mind and a little time for yourself",
        body: "Whether you are looking to maintain your fitness routine or unwind with a relaxing spa treatment, our wellness centre offers everything you need for a balanced stay.",
        align: "center",
      }),
      sec("fitness", "image-text", {
        eyebrow: "Fitness", title: "Train with expert guidance",
        body: "Modern equipment and certified trainers to guide your fitness journey — goal-oriented, results-driven, and never rushed.",
        image: img("gym"), imageSide: "left", bullets: ["Certified trainers", "Modern equipment", "Personal programmes", "Holistic wellness"], tone: "light",
      }),
      sec("grooming", "image-text", {
        eyebrow: "The gentleman's experience", title: "Professional grooming",
        body: "Step into our classic barbershop where traditional craftsmanship meets contemporary style. Our master barbers provide personalised grooming in a relaxing, refined setting.",
        image: img("barbershop"), imageSide: "right", tone: "sand",
      }),
      sec("cta", "cta", {
        title: "Book a session", intro: "Call or message us and we will reserve your time.",
        image: { url: url.gymHome, alt: "" }, primaryCta: { label: "Call 0795 106 483", href: "tel:+254795106483" },
      }),
    ],
  },
  {
    slug: "events", title: "Weddings & Events", kind: "STANDARD", showInNav: true, sortOrder: 40,
    seoDescription: "Weddings, conferences and team building in the gardens at Omega Gardens, Karatina.",
    sections: [
      sec("hero", "hero", {
        eyebrow: "Weddings · Conferences · Team building", title: "Moments worth gathering for",
        subtitle: "From intimate ceremonies to grand receptions and productive offsites.",
        images: [img("wedding")], showBookingBar: false, height: "tall",
      }),
      sec("weddings", "image-text", {
        eyebrow: "Weddings", title: "Your perfect day, in the garden",
        body: "At Omega Gardens Hotel & Spa, we transform your special day into an unforgettable celebration. From intimate ceremonies to grand receptions, our expert team brings your vision to life with elegance and attention to every detail.\n\nWe take care of every detail so you can focus on what matters most — celebrating your love.",
        image: img("wedding"), imageSide: "left", tone: "light",
      }),
      sec("meetings", "image-text", {
        eyebrow: "Meetings", title: "Conferences & boardrooms",
        body: "Professional meeting spaces for every size of gathering, from an executive boardroom to a full conference hall — with half-day, full-day and residential packages.",
        image: img("conference"), imageSide: "right", tone: "sand",
      }),
      sec("teams", "image-text", {
        eyebrow: "Team building", title: "Build stronger teams",
        body: "Strengthen bonds, improve communication and boost morale with expertly designed team building programmes. Our facilitators create engaging experiences that bring teams together and drive results.",
        image: img("teamBuilding"), imageSide: "left", tone: "light",
      }),
      sec("cta", "cta", {
        eyebrow: "Ready to start planning?", title: "Let us host your next occasion",
        intro: "Our events team will help you shape the day — tell us what you have in mind.",
        image: { url: url.boardroom, alt: "" },
        primaryCta: { label: "Send an enquiry", href: "/contact" },
        secondaryCta: { label: "Call 0795 106 483", href: "tel:+254795106483" },
      }),
    ],
  },
  { slug: "contact", title: "Contact", kind: "SYSTEM", showInNav: true, sortOrder: 50, sections: [] },
];

for (const p of PAGES) {
  const data = { title: p.title, kind: p.kind, showInNav: p.showInNav, sortOrder: p.sortOrder, sections: p.sections, draftSections: Prisma.DbNull, isPublished: true, seoDescription: p.seoDescription ?? null };
  await prisma.websitePage.upsert({ where: { tenantId_slug: { tenantId: tid, slug: p.slug } }, update: data, create: { ...data, tenantId: tid, slug: p.slug } });
}
console.log("Pages: " + PAGES.map((p) => p.slug).join(", "));

// ─── 6. Publish ───────────────────────────────────────────────────────────
if (PUBLISH) {
  await prisma.tenantWebsite.update({ where: { tenantId: tid }, data: { status: "PUBLISHED", publishedAt: new Date() } });
  console.log("PUBLISHED");
} else {
  console.log("Left as DRAFT — run again with --publish to go live.");
}
await prisma.$disconnect();
