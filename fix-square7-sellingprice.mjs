/**
 * Square 7 Lounge — un-break Products POS eligibility.
 *
 * Product.sellingPrice IS NOT NULL is the existing, already-enforced flag for
 * "sellable directly via Products POS" (see pos.routes.ts's /product-items
 * listing AND its order-create route — both filter on it). Every product
 * this tenant has exists purely as stock backing for a MenuItem/Variant
 * (alcohol/soft drinks sold through the bar Menu, never bypassed as a raw
 * "Product") — none of them should ever be directly sellable that way.
 *
 * The earlier price-reset step wrongly set sellingPrice: 0 instead of
 * leaving it null — 0 still satisfies "not null", so it accidentally opted
 * every bottle into Products POS. This sets it back to null tenant-wide.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "square7" } });
const tid = tenant.id;

const before = await prisma.product.count({ where: { tenantId: tid, sellingPrice: { not: null } } });
console.log(`Products currently sellable via Products POS: ${before}`);

const result = await prisma.product.updateMany({ where: { tenantId: tid }, data: { sellingPrice: null } });
console.log(`Set sellingPrice = null on ${result.count} products.`);

const after = await prisma.product.count({ where: { tenantId: tid, sellingPrice: { not: null } } });
console.log(`Products still sellable via Products POS (should be 0): ${after}`);

await prisma.$disconnect();
