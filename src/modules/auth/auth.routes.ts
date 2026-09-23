import { Router } from "express";
import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { verifySecret } from "../../lib/hash.js";

export const authRouter = Router();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const loginSchema = z.object({
  employeeCode: z.string().trim().optional(),
  pin: z.string().trim().min(1),
});

const roleSelect = { select: { id: true, name: true, allowedSections: true, permissions: true } } as const;
const locationsSelect = { select: { id: true, name: true } } as const;
const defaultLocationSelect = { select: { id: true, name: true } } as const;
const departmentSelect = { select: { id: true, name: true } } as const;
const employeeInclude = { role: roleSelect, locations: locationsSelect, defaultLocation: defaultLocationSelect, department: departmentSelect } as const;
type LoginEmployee = Prisma.EmployeeGetPayload<{ include: typeof employeeInclude }>;

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

function bearerToken(req: { header(name: string): string | undefined }): string | null {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function publicEmployee(employee: {
  id: string; firstName: string; lastName: string; employeeCode: string; jobTitle: string; isSupervisor: boolean;
  department: { id: string; name: string } | null;
  role: { id: string; name: string; allowedSections: string[]; permissions: string[] } | null;
  locations: { id: string; name: string }[];
  defaultLocation: { id: string; name: string } | null;
}) {
  return {
    id: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    employeeCode: employee.employeeCode,
    jobTitle: employee.jobTitle,
    isSupervisor: employee.isSupervisor,
    department: employee.department?.name ?? null,
    role: employee.role,
    locations: employee.locations,
    defaultLocation: employee.defaultLocation,
  };
}

authRouter.post("/login", async (req, res, next) => {
  const data = loginSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Enter your PIN" }); return; }
  try {
    const tid = tenantId(req);
    const employeeCode = data.data.employeeCode?.trim();
    let employee: LoginEmployee | null = null;
    if (employeeCode) {
      employee = await prisma.employee.findFirst({
        where: { tenantId: tid, employeeCode: { equals: employeeCode, mode: "insensitive" } },
        include: employeeInclude,
      });
    } else {
      const activeEmployees = await prisma.employee.findMany({ where: { tenantId: tid, status: "ACTIVE" }, include: employeeInclude });
      const matches = activeEmployees.filter((candidate) => verifySecret(data.data.pin, candidate.pin));
      if (matches.length > 1) { res.status(409).json({ error: "This PIN is shared. Use employee code login." }); return; }
      employee = matches[0] ?? null;
    }
    if (!employee || employee.status !== "ACTIVE" || !verifySecret(data.data.pin, employee.pin)) {
      res.status(401).json({ error: employeeCode ? "Incorrect employee code or PIN" : "Incorrect PIN" });
      return;
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await prisma.session.create({ data: { token, employeeId: employee.id, tenantId: tid, expiresAt } });
    res.json({ token, expiresAt, user: publicEmployee(employee) });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", async (req, res) => {
  const token = bearerToken(req);
  if (!token) { res.status(401).json({ error: "Not authenticated" }); return; }
  const session = await prisma.session.findUnique({ where: { token }, include: { employee: { include: employeeInclude } } });
  if (!session || session.expiresAt < new Date()) { res.status(401).json({ error: "Session expired" }); return; }
  res.json({ user: publicEmployee(session.employee), tenantId: session.tenantId, expiresAt: session.expiresAt });
});

authRouter.post("/logout", async (req, res) => {
  const token = bearerToken(req);
  if (token) await prisma.session.deleteMany({ where: { token } });
  res.status(204).send();
});

const setLocationSchema = z.object({ locationId: z.string().trim().min(1).nullable() });

authRouter.patch("/me/location", async (req, res, next) => {
  const token = bearerToken(req);
  if (!token) { res.status(401).json({ error: "Not authenticated" }); return; }
  const data = setLocationSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid location", details: data.error.flatten() }); return; }
  try {
    const session = await prisma.session.findUnique({ where: { token }, include: { employee: { select: { id: true, locations: { select: { id: true } } } } } });
    if (!session || session.expiresAt < new Date()) { res.status(401).json({ error: "Session expired" }); return; }
    const { locationId } = data.data;
    if (locationId) {
      const assigned = session.employee.locations;
      if (assigned.length > 0) {
        if (!assigned.some((l) => l.id === locationId)) { res.status(400).json({ error: "You can only pick a location you're assigned to" }); return; }
      } else {
        const ok = await prisma.location.findFirst({ where: { id: locationId, tenantId: session.tenantId, isActive: true }, select: { id: true } });
        if (!ok) { res.status(400).json({ error: "Choose an active location from this property" }); return; }
      }
    }
    await prisma.employee.update({ where: { id: session.employee.id }, data: { defaultLocationId: locationId } });
    const employee = await prisma.employee.findUniqueOrThrow({ where: { id: session.employee.id }, include: employeeInclude });
    res.json({ user: publicEmployee(employee) });
  } catch (error) {
    next(error);
  }
});
