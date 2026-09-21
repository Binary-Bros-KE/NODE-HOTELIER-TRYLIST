import type { BusinessType, Currency, Prisma } from "@prisma/client";
import { hashSecret } from "./hash.js";

// Every module a tenant can have enabled. `Module` rows themselves are
// global reference data (keyed by `key`, not tenant-scoped) shared across
// every tenant — upserting them here is safe to repeat for every new tenant.
// (BAR_LOUNGE is a vestigial enum value with no route or nav tied to it —
// deliberately never seeded.)
export const MODULE_KEYS = [
  "PRODUCTS", "STORE", "POS", "KITCHEN", "ROOMS", "RESERVATIONS",
  "HOUSEKEEPING", "HR", "REPORTS", "CUSTOMERS", "SERVICE_CENTER", "ACCOUNTING",
] as const;

// The platform admin only ever offers three toggles when creating or editing
// a tenant — everything else (Products/Store catalog, Team, Reports,
// Customers, Finance) is common infrastructure every property needs
// regardless of which "kind" of business it runs, so it's always on and
// never exposed as a checkbox.
export const MODULE_GROUP_KEYS = {
  rooms: ["ROOMS", "RESERVATIONS", "HOUSEKEEPING"],
  sales: ["POS", "KITCHEN"],
  services: ["SERVICE_CENTER"],
} as const;
export type ModuleGroups = { rooms: boolean; sales: boolean; services: boolean };
const GROUPED_KEYS = new Set<string>([...MODULE_GROUP_KEYS.rooms, ...MODULE_GROUP_KEYS.sales, ...MODULE_GROUP_KEYS.services]);

function isEnabledFor(moduleKey: (typeof MODULE_KEYS)[number], modules: ModuleGroups): boolean {
  if (!GROUPED_KEYS.has(moduleKey)) return true; // common — always on
  if ((MODULE_GROUP_KEYS.rooms as readonly string[]).includes(moduleKey)) return modules.rooms;
  if ((MODULE_GROUP_KEYS.sales as readonly string[]).includes(moduleKey)) return modules.sales;
  return modules.services;
}

export const ALL_SECTIONS = [
  "OVERVIEW", "RECEPTION", "HOUSEKEEPING", "SALES", "KITCHEN",
  "SERVICE_CENTER", "INVENTORY", "TEAM", "FINANCE", "REPORTS", "SYSTEM",
] as const;

// Action-level capabilities (enforced server-side) — separate from the
// sections above, which only hide sidebar/routes client-side. Kept as an
// explicit list, same as roles.routes.ts's own `permissions` array — not
// derived from the Prisma enum — so remember to add a new value here (and
// there) when the enum grows; this one had drifted (missing SHIFT_MANAGE/
// ATTENDANCE_MANAGE/SHIFT_EXEMPT), silently under-granting Super Admin and
// Manager, until fixed 2026-09-13.
export const ALL_PERMISSIONS = [
  "POS_VIEW_ALL_ORDERS", "POS_APPROVE_COUNTER", "POS_APPROVE_CANCELLATION",
  "SHIFT_MANAGE", "ATTENDANCE_MANAGE", "SHIFT_EXEMPT",
  "REQUISITION_CREATE", "REQUISITION_APPROVE",
  "SHIFT_REVIEW", "SALARY_MANAGE", "STORE_DISPATCH",
] as const;

// Who raises a requisition (product + quantity only) vs. who approves it
// (setting cost, then converting to a purchase) is deliberately not fixed
// to one named role — a Storekeeper or a Barman noticing stock is low can
// both raise one; whoever the property trusts to see cost and place the
// order approves it. These are just the sensible starting defaults —
// Roles & Permissions can grant either to any other role too.
const REQUISITION_RAISER_PERMISSIONS = ["REQUISITION_CREATE"] as const;
const REQUISITION_APPROVER_PERMISSIONS = ["REQUISITION_APPROVE"] as const;

// Runs the counter in a bar/club: sees every order at the location (not
// just ones they rang up), marks a counter-routed order served, and
// approves/rejects a waiter's cancellation or return request. Deliberately
// no SHIFT_MANAGE/ATTENDANCE_MANAGE — that's a manager/accountant concern.
const BARMAN_PERMISSIONS = ["POS_VIEW_ALL_ORDERS", "POS_APPROVE_COUNTER", "POS_APPROVE_CANCELLATION"] as const;

export const SYSTEM_ROLES = [
  { name: "Super Admin", description: "Full access to every section of the workspace.", allowedSections: ALL_SECTIONS, permissions: ALL_PERMISSIONS },
  { name: "Manager", description: "Oversees daily operations across the property.", allowedSections: ALL_SECTIONS, permissions: ALL_PERMISSIONS },
  { name: "Receptionist", description: "Front desk check-in, reservations, and guest billing.", allowedSections: ["OVERVIEW", "RECEPTION"], permissions: [] },
  { name: "Chef", description: "Kitchen orders, menu, and recipes.", allowedSections: ["OVERVIEW", "KITCHEN"], permissions: [] },
  { name: "Waiter", description: "Point of sale, tables, and orders.", allowedSections: ["OVERVIEW", "SALES"], permissions: [] },
  { name: "Barman", description: "Runs the counter — sees and serves orders waiters send in, approves returns.", allowedSections: ["OVERVIEW", "SALES"], permissions: [...BARMAN_PERMISSIONS, ...REQUISITION_RAISER_PERMISSIONS] },
  { name: "Housekeeping", description: "Room tasks and cleanliness tracking.", allowedSections: ["OVERVIEW", "HOUSEKEEPING"], permissions: [] },
  { name: "Storekeeper", description: "Inventory, stock, and supplier records.", allowedSections: ["OVERVIEW", "INVENTORY"], permissions: [...REQUISITION_RAISER_PERMISSIONS, "STORE_DISPATCH"] },
  { name: "Accountant", description: "Finance, expenses, and reports.", allowedSections: ["OVERVIEW", "FINANCE", "REPORTS"], permissions: [...REQUISITION_APPROVER_PERMISSIONS, "SHIFT_REVIEW", "SALARY_MANAGE"] },
] as const;

const SYSTEM_PAYMENT_METHODS = [
  { name: "Cash", code: "CASH", requiresReference: false, sortOrder: 0 },
  { name: "M-Pesa", code: "MPESA", requiresReference: true, sortOrder: 1 },
  { name: "Card", code: "CARD", requiresReference: true, sortOrder: 2 },
  { name: "Bank Transfer", code: "BANK_TRANSFER", requiresReference: true, sortOrder: 3 },
  { name: "Cheque", code: "CHEQUE", requiresReference: true, sortOrder: 4 },
] as const;

// A starter set of departments every new tenant gets; fully CRUD-able after
// onboarding. "Management" is the fallback the bootstrap admin is filed under.
export const DEFAULT_DEPARTMENTS = [
  "Reception", "Housekeeping", "Kitchen", "Sales", "Service Center",
  "Inventory", "Finance", "Management", "Maintenance", "Security",
] as const;

export type ProvisionTenantInput = {
  tenantId: string;
  businessName: string;
  businessType: BusinessType;
  currency?: Currency;
  /** Seeds BusinessProfile.email so the tenant's own Settings screen shows
   * a real contact address from day one. */
  contactEmail?: string;
  /** PIN for the one-time bootstrap login every tenant gets — defaults to
   * "000000", same as the dev seed always has. Callers (e.g. the platform
   * admin) should return this to the operator exactly once, at creation. */
  bootstrapPin?: string;
  /** Which of the three toggleable module groups this tenant starts with —
   * the platform admin requires at least one. Everything else (Products,
   * Store, HR, Reports, Customers, Accounting) is always enabled. */
  modules: ModuleGroups;
};

export type ProvisionTenantResult = {
  bootstrapEmployeeCode: string;
  bootstrapPin: string;
};

/**
 * Everything a brand-new tenant needs before anyone can log in and start
 * configuring it — modules, system roles, one bootstrap login, a default
 * stock location, café settings, a business profile, and the standard
 * payment methods. Deliberately excludes any demo/sample catalog data
 * (room types, rooms, services, menu items, tables) — that's specific to
 * the local dev seed, not something a real client should ever see.
 *
 * Every step is an upsert exactly as the original dev seed script used,
 * just run against the caller's transaction client so the whole thing
 * either fully commits or fully rolls back alongside the Tenant row itself.
 */
export async function provisionTenantBootstrap(
  tx: Prisma.TransactionClient,
  input: ProvisionTenantInput,
): Promise<ProvisionTenantResult> {
  const { tenantId, modules } = input;

  for (const moduleKey of MODULE_KEYS) {
    await tx.module.upsert({
      where: { key: moduleKey },
      update: {},
      create: { key: moduleKey, name: moduleKey.replace("_", " ") },
    });
    const isEnabled = isEnabledFor(moduleKey, modules);
    await tx.tenantModule.upsert({
      where: { tenantId_moduleKey: { tenantId, moduleKey } },
      update: { isEnabled },
      create: { tenantId, moduleKey, isEnabled },
    });
  }

  for (const role of SYSTEM_ROLES) {
    await tx.role.upsert({
      where: { tenantId_name: { tenantId, name: role.name } },
      update: { description: role.description, allowedSections: [...role.allowedSections], permissions: [...role.permissions], isSystemRole: true },
      create: { tenantId, name: role.name, description: role.description, allowedSections: [...role.allowedSections], permissions: [...role.permissions], isSystemRole: true },
    });
  }

  for (const name of DEFAULT_DEPARTMENTS) {
    await tx.department.upsert({
      where: { tenantId_name: { tenantId, name } },
      update: {},
      create: { tenantId, name },
    });
  }

  // Bootstrap login: every tenant gets a default SYSTEM employee with the
  // Super Admin role, so a freshly onboarded tenant can always sign in and
  // set up its real staff.
  const superAdminRole = await tx.role.findUniqueOrThrow({
    where: { tenantId_name: { tenantId, name: "Super Admin" } },
  });
  const managementDept = await tx.department.findUniqueOrThrow({
    where: { tenantId_name: { tenantId, name: "Management" } },
  });
  const bootstrapPin = input.bootstrapPin ?? "000000";
  await tx.employee.upsert({
    where: { tenantId_employeeCode: { tenantId, employeeCode: "SYSTEM" } },
    update: {},
    create: {
      tenantId,
      employeeCode: "SYSTEM",
      pin: hashSecret(bootstrapPin),
      firstName: "System",
      lastName: "Administrator",
      phone: "0000000000",
      departmentId: managementDept.id,
      jobTitle: "System Administrator",
      dateHired: new Date(),
      salaryAmount: 0,
      roleId: superAdminRole.id,
      status: "ACTIVE",
    },
  });

  // A warehouse is just a Location of type STORE — no separate store model.
  // canSell* all false since it doesn't run its own POS.
  await tx.location.upsert({
    where: { tenantId_name: { tenantId, name: "Main Store" } },
    update: {},
    create: {
      tenantId, name: "Main Store", type: "STORE", isActive: true,
      canSellRooms: false, canSellMenu: false, canSellServices: false, canSellProducts: false,
    },
  });

  await tx.cafeSettings.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId, cafeName: input.businessName, currency: input.currency ?? "KES" },
  });

  // Real onboarding fills this in immediately (unlike the dev seed, which
  // never bothered) — /tenant/resolve and Settings both read it, and a
  // freshly onboarded tenant should see its own name, not a placeholder.
  await tx.businessProfile.upsert({
    where: { tenantId },
    update: {},
    create: {
      tenantId,
      businessName: input.businessName,
      businessType: input.businessType,
      currency: input.currency ?? "KES",
      ...(input.contactEmail ? { email: input.contactEmail } : {}),
    },
  });

  for (const method of SYSTEM_PAYMENT_METHODS) {
    await tx.paymentMethod.upsert({
      where: { tenantId_code: { tenantId, code: method.code } },
      update: {},
      create: { tenantId, ...method, isSystem: true },
    });
  }

  return { bootstrapEmployeeCode: "SYSTEM", bootstrapPin };
}
