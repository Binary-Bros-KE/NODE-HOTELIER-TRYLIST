/**
 * Square 7 Lounge — correcting Jack Daniels prices after discovering a
 * row-shift error (see conversation, 2026-09-15): two identical "6000"
 * values on the counter sheet (Hamptons and Jack Daniels 1L, adjacent rows)
 * were misread as one, shifting every subsequent row's price up by one
 * position. Values below are the client's own direct read of the physical
 * page, not a re-derivation from the photo.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "square7" } });
const tid = tenant.id;

async function setVariantPrice(name, variantLabel, price) {
  const mi = await prisma.menuItem.findFirst({ where: { tenantId: tid, name }, include: { variants: true } });
  const variant = mi.variants.find((v) => v.name === variantLabel);
  if (!variant) { console.log(`! no variant "${variantLabel}" on ${name}`); return; }
  await prisma.menuItemVariant.update({ where: { id: variant.id }, data: { price } });
  console.log(`${name} [${variantLabel}] = KES ${price}`);
}
async function setDirectPrice(name, price) {
  const mi = await prisma.menuItem.findFirstOrThrow({ where: { tenantId: tid, name } });
  await prisma.menuItem.update({ where: { id: mi.id }, data: { price } });
  console.log(`${name} = KES ${price}`);
}

await setVariantPrice("Jack Daniels", "1 Litre", 6000);
await setVariantPrice("Jack Daniels", "700ml", 0); // confirmed empty on the sheet
await setVariantPrice("Jack Daniels", "350ml", 2500);
await setDirectPrice("Jack Daniels Honey", 600);
await setDirectPrice("Jack Daniels Fire", 7000);

await prisma.$disconnect();
