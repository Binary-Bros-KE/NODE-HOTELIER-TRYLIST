import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { hashSecret } from "../../lib/hash.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { partialNoDefaults } from "../../lib/zod.js";

export const employeesRouter = Router();
employeesRouter.use(requireModule("HR"));

const genders = ["MALE", "FEMALE", "OTHER"] as const;
const employmentTypes = ["FULL_TIME", "PART_TIME", "CASUAL", "CONTRACT", "INTERN"] as const;
const statuses = ["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"] as const;
const salaryTypes = ["MONTHLY", "DAILY", "HOURLY"] as const;
const paymentMethods = ["BANK_TRANSFER", "MPESA", "CASH", "CHEQUE", "CARD"] as const;

// Empty strings from optional form fields should be treated as "not provided",
// not as validation failures (e.g. an untouched email/date input).
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalEmail = z.preprocess(blankToUndefined, z.email().optional());
const optionalDate = z.preprocess(blankToUndefined, z.coerce.date().optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());

const createSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  gender: z.preprocess(blankToUndefined, z.enum(genders).optional()),
  dateOfBirth: optionalDate,
  nationalId: optionalText(30),
  photoUrl: optionalText(2000),
  phone: z.string().trim().min(1).max(30),
  alternativePhone: optionalText(30),
  email: optionalEmail,
  address: optionalText(255),
  departmentId: z.string().trim().min(1, "Choose a department"),
  jobTitle: z.string().trim().min(1).max(80),
  employmentType: z.enum(employmentTypes).default("FULL_TIME"),
  status: z.enum(statuses).default("ACTIVE"),
  dateHired: z.coerce.date(),
  supervisorId: optionalId,
  isSupervisor: z.boolean().default(false),
  roleId: z.string().trim().min(1, "Choose a role"),
  // Locations this employee is pinned to. Empty = works anywhere.
  locationIds: z.array(z.string().trim().min(1)).default([]),
  // The POS's pre-selected location for this employee — must be one of
  // locationIds, or null. Auto-derived when omitted (see resolveDefaultLocation).
  defaultLocationId: z.preprocess(blankToUndefined, z.string().trim().nullable().optional()),
  salaryType: z.enum(salaryTypes).default("MONTHLY"),
  salaryAmount: z.coerce.number().min(0),
  paymentMethod: z.enum(paymentMethods).default("BANK_TRANSFER"),
  bankName: optionalText(80),
  bankAccountNumber: optionalText(40),
  mpesaNumber: optionalText(20),
  kraPin: optionalText(20),
  nssfNumber: optionalText(20),
  shaNumber: optionalText(20),
  employeeCode: z.string().trim().min(1).max(30),
  pin: z.string().trim().min(4).max(8),
  emergencyContactName: optionalText(80),
  emergencyContactPhone: optionalText(30),
});
const updateSchema = partialNoDefaults(createSchema).omit({ pin: true }).extend({ pin: z.string().trim().min(4).max(8).optional() });
const listSchema = z.object({
  search: z.string().trim().max(100).optional(),
  departmentId: optionalId,
  status: z.enum(statuses).optional(),
});

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const publicFields = {
  id: true,
  firstName: true,
  lastName: true,
  gender: true,
  dateOfBirth: true,
  nationalId: true,
  photoUrl: true,
  phone: true,
  alternativePhone: true,
  email: true,
  address: true,
  departmentId: true,
  department: { select: { id: true, name: true } },
  jobTitle: true,
  employmentType: true,
  status: true,
  dateHired: true,
  supervisorId: true,
  supervisor: { select: { id: true, firstName: true, lastName: true } },
  isSupervisor: true,
  roleId: true,
  role: { select: { id: true, name: true, allowedSections: true } },
  locations: { select: { id: true, name: true } },
  defaultLocationId: true,
  defaultLocation: { select: { id: true, name: true } },
  salaryType: true,
  salaryAmount: true,
  paymentMethod: true,
  bankName: true,
  bankAccountNumber: true,
  mpesaNumber: true,
  kraPin: true,
  nssfNumber: true,
  shaNumber: true,
  employeeCode: true,
  emergencyContactName: true,
  emergencyContactPhone: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function assertSupervisorInTenant(supervisorId: string | undefined, tenant: string, selfId?: string) {
  if (!supervisorId) return;
  if (supervisorId === selfId) throw Object.assign(new Error("An employee cannot supervise themselves"), { status: 400 });
  const supervisor = await prisma.employee.findFirst({ where: { id: supervisorId, tenantId: tenant }, select: { id: true } });
  if (!supervisor) throw Object.assign(new Error("Selected supervisor was not found"), { status: 400 });
}

async function assertRoleInTenant(roleId: string | undefined, tenant: string) {
  if (!roleId) return;
  const role = await prisma.role.findFirst({ where: { id: roleId, tenantId: tenant }, select: { id: true } });
  if (!role) throw Object.assign(new Error("Selected role was not found"), { status: 400 });
}

async function assertLocationsInTenant(locationIds: string[] | undefined, tenant: string) {
  if (!locationIds || locationIds.length === 0) return;
  const unique = [...new Set(locationIds)];
  const count = await prisma.location.count({ where: { id: { in: unique }, tenantId: tenant } });
  if (count !== unique.length) throw Object.assign(new Error("One or more selected locations were not found"), { status: 400 });
}

/** The default POS location to store: an explicit choice (must be in the
 * assigned set), else the sole assigned location, else null. */
function resolveDefaultLocation(explicit: string | null | undefined, assignedIds: string[], current: string | null): string | null {
  if (explicit !== undefined) {
    if (explicit === null) return null;
    if (!assignedIds.includes(explicit)) throw Object.assign(new Error("Default location must be one the employee is assigned to"), { status: 400 });
    return explicit;
  }
  if (current && assignedIds.includes(current)) return current;
  return assignedIds.length === 1 ? assignedIds[0] : null;
}

async function assertDepartmentInTenant(departmentId: string | undefined, tenant: string) {
  if (!departmentId) return;
  const department = await prisma.department.findFirst({ where: { id: departmentId, tenantId: tenant }, select: { id: true } });
  if (!department) throw Object.assign(new Error("Selected department was not found"), { status: 400 });
}

employeesRouter.get("/", async (req, res) => {
  const query = listSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid employee filters", details: query.error.flatten() }); return; }
  const { search, departmentId, status } = query.data;
  const where: Prisma.EmployeeWhereInput = {
    tenantId: tenantId(req),
    ...(departmentId ? { departmentId } : {}),
    ...(status ? { status } : {}),
    ...(search ? { OR: [
      { firstName: { contains: search, mode: "insensitive" } },
      { lastName: { contains: search, mode: "insensitive" } },
      { employeeCode: { contains: search, mode: "insensitive" } },
      { jobTitle: { contains: search, mode: "insensitive" } },
      { phone: { contains: search, mode: "insensitive" } },
    ] } : {}),
  };
  const [employees, total, active, onLeave, suspended, terminated] = await Promise.all([
    prisma.employee.findMany({ where, select: publicFields, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    prisma.employee.count({ where: { tenantId: tenantId(req) } }),
    prisma.employee.count({ where: { tenantId: tenantId(req), status: "ACTIVE" } }),
    prisma.employee.count({ where: { tenantId: tenantId(req), status: "ON_LEAVE" } }),
    prisma.employee.count({ where: { tenantId: tenantId(req), status: "SUSPENDED" } }),
    prisma.employee.count({ where: { tenantId: tenantId(req), status: "TERMINATED" } }),
  ]);
  res.json({ employees, summary: { total, active, onLeave, suspended, terminated } });
});

employeesRouter.get("/:id", async (req, res) => {
  const employee = await prisma.employee.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: publicFields });
  if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
  res.json({ employee });
});

employeesRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid employee", details: data.error.flatten() }); return; }
  const { pin, supervisorId, roleId, locationIds, defaultLocationId, ...employeeData } = data.data;
  try {
    await assertSupervisorInTenant(supervisorId, tenantId(req));
    await assertRoleInTenant(roleId, tenantId(req));
    await assertLocationsInTenant(locationIds, tenantId(req));
    await assertDepartmentInTenant(employeeData.departmentId, tenantId(req));
    const employee = await prisma.employee.create({
      data: {
        tenantId: tenantId(req), ...employeeData,
        supervisorId: supervisorId ?? null, roleId: roleId ?? null,
        locations: { connect: (locationIds ?? []).map((id) => ({ id })) },
        defaultLocationId: resolveDefaultLocation(defaultLocationId, locationIds ?? [], null),
        pin: hashSecret(pin),
      },
      select: publicFields,
    });
    res.status(201).json({ employee });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "An employee with this code already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

employeesRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid employee", details: data.error.flatten() }); return; }
  const { pin, supervisorId, roleId, locationIds, defaultLocationId, ...employeeData } = data.data;
  try {
    if (supervisorId !== undefined) await assertSupervisorInTenant(supervisorId, tenantId(req), req.params.id);
    if (roleId !== undefined) await assertRoleInTenant(roleId, tenantId(req));
    if (locationIds !== undefined) await assertLocationsInTenant(locationIds, tenantId(req));
    if (employeeData.departmentId !== undefined) await assertDepartmentInTenant(employeeData.departmentId, tenantId(req));
    const existing = await prisma.employee.findFirst({
      where: { id: req.params.id, tenantId: tenantId(req) },
      select: { id: true, defaultLocationId: true, locations: { select: { id: true } } },
    });
    if (!existing) { res.status(404).json({ error: "Employee not found" }); return; }
    // Keep the default location coherent with the assigned set whenever
    // either one is touched.
    const assignedIds = locationIds ?? existing.locations.map((l) => l.id);
    const nextDefault = defaultLocationId !== undefined || locationIds !== undefined
      ? resolveDefaultLocation(defaultLocationId, assignedIds, existing.defaultLocationId)
      : undefined;
    await prisma.employee.update({
      where: { id: existing.id },
      data: {
        ...employeeData,
        ...(supervisorId !== undefined ? { supervisorId: supervisorId ?? null } : {}),
        ...(roleId !== undefined ? { roleId: roleId ?? null } : {}),
        ...(locationIds !== undefined ? { locations: { set: locationIds.map((id) => ({ id })) } } : {}),
        ...(nextDefault !== undefined ? { defaultLocationId: nextDefault } : {}),
        ...(pin ? { pin: hashSecret(pin) } : {}),
      },
    });
    res.json({ employee: await prisma.employee.findUniqueOrThrow({ where: { id: req.params.id }, select: publicFields }) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "An employee with this code already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

employeesRouter.delete("/:id", async (req, res) => {
  const deleted = await prisma.employee.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!deleted.count) { res.status(404).json({ error: "Employee not found" }); return; }
  res.status(204).send();
});
