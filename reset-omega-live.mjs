/**
 * Omega Gardens Hotel and Spa — full reset for go-live (2026-09-22).
 *
 * The client onboarded and tested for two weeks under this same tenant
 * (slug "omega"): 7 obviously-placeholder employees (Hotel_Waiter,
 * Barman, House_Sup, ...), 4 test reservations, 17 POS orders, a full
 * test menu/product catalog. He now wants to go live on this SAME
 * subdomain with a clean slate.
 *
 * Every tenant-scoped table in this schema cascades from Tenant
 * (onDelete: Cascade, verified against all 67 direct tenant relations
 * before running this) — so deleting the Tenant row and recreating it
 * fresh with the same slug is a complete, atomic reset. The one thing
 * that would be wrongly destroyed by that alone is BusinessProfile: it
 * holds the client's REAL registration/contact/branding info (KRA PIN,
 * registration number, owner contact, uploaded logo, theme colours) —
 * captured below and restored onto the fresh tenant after re-bootstrapping,
 * so only the operational/test data is actually lost.
 *
 * Plan/subscription snapshot is kept exactly as it was (client's choice):
 * TEST-INIT, TRIAL, same next due date.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

// Captured from the live tenant via _capture-omega-profile.mjs immediately
// before this script ran — see the conversation for the raw dump.
const OLD_TENANT = {
  name: "Omega Gardens Hotel and Spa",
  slug: "omega",
  planId: "cmtu3h4my00017rkspivj1m5p",
  licenseStatus: "TRIAL",
  subscriptionPlan: "TEST-INIT",
  subscriptionStart: "2026-09-09T12:51:38.507Z",
  nextDueDate: "2026-10-09T12:51:38.501Z",
  maxBranches: 5,
  maxUsers: 10,
  maxDevices: 10,
};
const OLD_BUSINESS_PROFILE = {
  logoUrl: "/uploads/logos/cmtu3kxhn000w7rksy5flb85s-1788958594437.png",
  shortName: "Omega Gardens",
  themeBaseColor: "#1c9b5e",
  themeAccentColor: "#43a047",
  themeFont: "space-grotesk",
  businessName: "Omega Gardens Hotel & Spa",
  businessType: "HOTEL",
  currency: "KES",
  registrationNumber: "BN-2026-3749739G",
  kraPin: "A83794Y49394E",
  taxRate: 16,
  taxMode: "INCLUSIVE",
  taxTreatment: "EXEMPT",
  businessDayStartHour: 0,
  primaryPhone: "0791880412",
  alternativePhone: "0742503840",
  email: "omegagardenshotelandspa@gmail.com",
  website: "omegagardenshotelandspa.com",
  country: "Kenya",
  county: "Nyeri",
  city: "Karatina",
  address: "Alone Nairobi - Karatina Highway.",
  ownerName: "Patrick Kuria",
  ownerPhone: "0791880412",
  ownerEmail: "patrickkuria@gmail.com",
};

const { provisionTenantBootstrap } = await import("./dist/lib/tenantBootstrap.js");

// ------------------------------------------------------------------ verify + delete
const existing = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const eid = existing.id;
console.log(`Deleting tenant ${existing.name} (${eid})...`);

// This schema deliberately Restricts ~30 relations against catalog/reference
// tables (a live order line can't be orphaned by an accidental product/menu
// delete, etc.) — all intra-tenant, but a single tenant.delete() cascade can
// still hit a Restrict-guarded table before it's cleared whatever still
// points at it, since Postgres doesn't guarantee cascade traversal order
// across independent branches of the graph. Clearing leaves-to-root first
// (each of these deleteMany calls cascades its own children) means the
// final tenant.delete() only has to sweep up plain Cascade relations.
await prisma.recipeIngredient.deleteMany({ where: { recipe: { tenantId: eid } } });
await prisma.recipe.deleteMany({ where: { tenantId: eid } });
await prisma.serviceVariant.deleteMany({ where: { tenantId: eid } });
await prisma.menuItemVariant.deleteMany({ where: { tenantId: eid } });

await prisma.posOrder.deleteMany({ where: { tenantId: eid } });
await prisma.goodsReceipt.deleteMany({ where: { tenantId: eid } }); // before Purchase (Restrict on purchaseId)
await prisma.purchase.deleteMany({ where: { tenantId: eid } });
await prisma.purchaseRequisition.deleteMany({ where: { tenantId: eid } });
await prisma.stockTransfer.deleteMany({ where: { tenantId: eid } });
await prisma.stockReceipt.deleteMany({ where: { tenantId: eid } });
await prisma.stockDispatchRequest.deleteMany({ where: { tenantId: eid } });

await prisma.appointment.deleteMany({ where: { tenantId: eid } });
await prisma.membership.deleteMany({ where: { tenantId: eid } });
await prisma.folio.deleteMany({ where: { tenantId: eid } });
await prisma.reservation.deleteMany({ where: { tenantId: eid } });
await prisma.reservationGroup.deleteMany({ where: { tenantId: eid } });

await prisma.employeeSalary.deleteMany({ where: { tenantId: eid } });
await prisma.employeeShiftRotation.deleteMany({ where: { tenantId: eid } });
await prisma.expense.deleteMany({ where: { tenantId: eid } });
await prisma.employee.deleteMany({ where: { tenantId: eid } });

await prisma.menuItem.deleteMany({ where: { tenantId: eid } });
await prisma.service.deleteMany({ where: { tenantId: eid } });
await prisma.room.deleteMany({ where: { tenantId: eid } });
await prisma.product.deleteMany({ where: { tenantId: eid } });

await prisma.tenant.delete({ where: { id: eid } }); // cascades everything else
console.log("Deleted. Recreating fresh...");

// ------------------------------------------------------------------ recreate + bootstrap
const { tenant, bootstrap } = await prisma.$transaction(async (tx) => {
  const created = await tx.tenant.create({
    data: {
      name: OLD_TENANT.name,
      slug: OLD_TENANT.slug,
      licenseStatus: OLD_TENANT.licenseStatus,
      planId: OLD_TENANT.planId,
      subscriptionPlan: OLD_TENANT.subscriptionPlan,
      subscriptionStart: new Date(OLD_TENANT.subscriptionStart),
      nextDueDate: new Date(OLD_TENANT.nextDueDate),
      maxBranches: OLD_TENANT.maxBranches,
      maxUsers: OLD_TENANT.maxUsers,
      maxDevices: OLD_TENANT.maxDevices,
    },
  });
  const bootstrapResult = await provisionTenantBootstrap(tx, {
    tenantId: created.id,
    businessName: OLD_BUSINESS_PROFILE.businessName,
    businessType: OLD_BUSINESS_PROFILE.businessType,
    currency: OLD_BUSINESS_PROFILE.currency,
    contactEmail: OLD_BUSINESS_PROFILE.email,
    bootstrapPin: "1234",
    modules: { rooms: true, sales: true, services: true },
  });
  return { tenant: created, bootstrap: bootstrapResult };
});
console.log(`Recreated tenant ${tenant.name} (${tenant.id}), bootstrap login ${bootstrap.bootstrapEmployeeCode}/${bootstrap.bootstrapPin}`);

// ------------------------------------------------------------------ restore the real business profile fields
await prisma.businessProfile.update({
  where: { tenantId: tenant.id },
  data: {
    logoUrl: OLD_BUSINESS_PROFILE.logoUrl,
    shortName: OLD_BUSINESS_PROFILE.shortName,
    themeBaseColor: OLD_BUSINESS_PROFILE.themeBaseColor,
    themeAccentColor: OLD_BUSINESS_PROFILE.themeAccentColor,
    themeFont: OLD_BUSINESS_PROFILE.themeFont,
    registrationNumber: OLD_BUSINESS_PROFILE.registrationNumber,
    kraPin: OLD_BUSINESS_PROFILE.kraPin,
    taxRate: OLD_BUSINESS_PROFILE.taxRate,
    taxMode: OLD_BUSINESS_PROFILE.taxMode,
    taxTreatment: OLD_BUSINESS_PROFILE.taxTreatment,
    businessDayStartHour: OLD_BUSINESS_PROFILE.businessDayStartHour,
    primaryPhone: OLD_BUSINESS_PROFILE.primaryPhone,
    alternativePhone: OLD_BUSINESS_PROFILE.alternativePhone,
    website: OLD_BUSINESS_PROFILE.website,
    country: OLD_BUSINESS_PROFILE.country,
    county: OLD_BUSINESS_PROFILE.county,
    city: OLD_BUSINESS_PROFILE.city,
    address: OLD_BUSINESS_PROFILE.address,
    ownerName: OLD_BUSINESS_PROFILE.ownerName,
    ownerPhone: OLD_BUSINESS_PROFILE.ownerPhone,
    ownerEmail: OLD_BUSINESS_PROFILE.ownerEmail,
  },
});
console.log("Business profile (branding, KRA PIN, registration, owner contact, logo) restored.");

// ------------------------------------------------------------------ verify
const counts = await Promise.all([
  prisma.employee.count({ where: { tenantId: tenant.id } }),
  prisma.location.count({ where: { tenantId: tenant.id } }),
  prisma.reservation.count({ where: { tenantId: tenant.id } }),
  prisma.menuItem.count({ where: { tenantId: tenant.id } }),
  prisma.product.count({ where: { tenantId: tenant.id } }),
  prisma.paymentMethod.count({ where: { tenantId: tenant.id } }),
  prisma.department.count({ where: { tenantId: tenant.id } }),
  prisma.role.count({ where: { tenantId: tenant.id } }),
]);
console.log(`\nFresh tenant state: employees=${counts[0]} locations=${counts[1]} reservations=${counts[2]} menuItems=${counts[3]} products=${counts[4]} paymentMethods=${counts[5]} departments=${counts[6]} roles=${counts[7]}`);
console.log(`\nLogin: employee code "${bootstrap.bootstrapEmployeeCode}", PIN "${bootstrap.bootstrapPin}", at https://omega.hoteliermanagement.app`);
await prisma.$disconnect();
