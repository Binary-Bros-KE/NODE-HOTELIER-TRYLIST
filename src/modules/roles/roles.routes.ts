import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { partialNoDefaults } from "../../lib/zod.js";

export const rolesRouter = Router();

const sections = ["OVERVIEW", "RECEPTION", "HOUSEKEEPING", "SALES", "KITCHEN", "SERVICE_CENTER", "INVENTORY", "TEAM", "FINANCE", "REPORTS", "SYSTEM"] as const;
// Action-level capabilities (enforced server-side by requirePermission) —
// separate from `allowedSections`, which only hides sidebar/routes.
const permissions = [
  "POS_VIEW_ALL_ORDERS", "POS_APPROVE_COUNTER", "POS_APPROVE_CANCELLATION",
  "SHIFT_MANAGE", "ATTENDANCE_MANAGE", "SHIFT_EXEMPT",
  "REQUISITION_CREATE", "REQUISITION_APPROVE",
  "SHIFT_REVIEW", "SALARY_MANAGE",
] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.preprocess(blankToUndefined, z.string().trim().max(200).optional()),
  allowedSections: z.array(z.enum(sections)).default([]),
  permissions: z.array(z.enum(permissions)).default([]),
});
const updateSchema = partialNoDefaults(createSchema);

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const publicFields = {
  id: true,
  name: true,
  description: true,
  isSystemRole: true,
  allowedSections: true,
  permissions: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { employees: true } },
} as const;

function serialize<T extends { _count: { employees: number } }>(role: T) {
  const { _count, ...rest } = role;
  return { ...rest, employeeCount: _count.employees };
}

rolesRouter.get("/", async (req, res) => {
  const [roles, total, systemCount] = await Promise.all([
    prisma.role.findMany({ where: { tenantId: tenantId(req) }, select: publicFields, orderBy: [{ isSystemRole: "desc" }, { name: "asc" }] }),
    prisma.role.count({ where: { tenantId: tenantId(req) } }),
    prisma.role.count({ where: { tenantId: tenantId(req), isSystemRole: true } }),
  ]);
  res.json({ roles: roles.map(serialize), summary: { total, system: systemCount, custom: total - systemCount } });
});

rolesRouter.get("/:id", async (req, res) => {
  const role = await prisma.role.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: publicFields });
  if (!role) { res.status(404).json({ error: "Role not found" }); return; }
  res.json({ role: serialize(role) });
});

rolesRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid role", details: data.error.flatten() }); return; }
  try {
    const role = await prisma.role.create({ data: { tenantId: tenantId(req), ...data.data }, select: publicFields });
    res.status(201).json({ role: serialize(role) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A role with this name already exists" }); return; }
    next(error);
  }
});

rolesRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid role", details: data.error.flatten() }); return; }
  try {
    const existing = await prisma.role.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) } });
    if (!existing) { res.status(404).json({ error: "Role not found" }); return; }
    // A system role's name is load-bearing — requireAdmin/isSuperAdmin
    // (tenantContext.ts) and the initial-seed lookup (tenantBootstrap.ts)
    // all key off "Super Admin"/"Manager" by name, not id. Its
    // capabilities/sections can still be tuned, just not its identity.
    if (existing.isSystemRole && data.data.name !== undefined && data.data.name !== existing.name) {
      res.status(400).json({ error: "System roles can't be renamed" });
      return;
    }
    const role = await prisma.role.update({ where: { id: existing.id }, data: data.data, select: publicFields });
    res.json({ role: serialize(role) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A role with this name already exists" }); return; }
    next(error);
  }
});

rolesRouter.delete("/:id", async (req, res) => {
  const role = await prisma.role.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!role) { res.status(404).json({ error: "Role not found" }); return; }
  if (role.isSystemRole) { res.status(400).json({ error: "System roles cannot be deleted" }); return; }
  await prisma.role.delete({ where: { id: role.id } });
  res.status(204).send();
});
