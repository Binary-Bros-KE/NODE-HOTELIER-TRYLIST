import { Router } from "express";
import { logActivityAfter } from "../../lib/activity.js";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule, requirePermission } from "../../middleware/tenantContext.js";

export const attendanceRouter = Router();
attendanceRouter.use(requireModule("HR"));

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const monthSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12), // 1-based
  employeeId: z.string().trim().optional(),
});

/** One calendar month's attendance register — there's no retention limit,
 * any past year/month can be requested the same way. */
attendanceRouter.get("/", async (req, res) => {
  const query = monthSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "A year and month are required" }); return; }
  const { year, month, employeeId } = query.data;
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1));
  const records = await prisma.attendanceRecord.findMany({
    where: { tenantId: tenantId(req), date: { gte: from, lt: to }, ...(employeeId ? { employeeId } : {}) },
    orderBy: { date: "asc" },
  });
  res.json({ records });
});

const markSchema = z.object({
  employeeId: z.string().trim().min(1),
  date: z.coerce.date(),
  status: z.enum(["PRESENT", "ABSENT", "LATE", "ON_LEAVE"]),
  notes: z.string().trim().max(300).optional(),
});

/** Marking attendance has no automatic source (no clock-in device) — someone
 * always records it by hand, one employee/day at a time. */
attendanceRouter.put("/mark", requirePermission("ATTENDANCE_MANAGE"), async (req, res, next) => {
  const tid = tenantId(req);
  const data = markSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid attendance entry", details: data.error.flatten() }); return; }
  const employee = await prisma.employee.findFirst({ where: { id: data.data.employeeId, tenantId: tid }, select: { id: true, firstName: true, lastName: true } });
  if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
  try {
    const before = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: data.data.employeeId, date: data.data.date } }, select: { status: true } });
    const record = await prisma.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId: data.data.employeeId, date: data.data.date } },
      create: { tenantId: tid, employeeId: data.data.employeeId, date: data.data.date, status: data.data.status, notes: data.data.notes, markedBy: req.userId ?? null },
      update: { status: data.data.status, notes: data.data.notes, markedBy: req.userId ?? null },
    });
    if (before && before.status !== data.data.status) await logActivityAfter(req, { area: "SHIFTS", action: "attendance.change", target: { type: "Employee", id: employee.id, label: `${employee.firstName} ${employee.lastName}`.trim() }, reason: data.data.notes ?? null, changes: [{ field: "status", label: "Attendance", from: before.status, to: data.data.status }], summary: `Changed ${employee.firstName} ${employee.lastName}'s attendance for ${data.data.date.toISOString().slice(0, 10)}` });
    res.json({ record });
  } catch (error) {
    next(error);
  }
});

attendanceRouter.delete("/:employeeId/:date", requirePermission("ATTENDANCE_MANAGE"), async (req, res) => {
  const tid = tenantId(req);
  const date = z.coerce.date().safeParse(req.params.date);
  if (!date.success) { res.status(400).json({ error: "Invalid date" }); return; }
  const removed = await prisma.attendanceRecord.findFirst({ where: { tenantId: tid, employeeId: req.params.employeeId as string, date: date.data }, select: { status: true, employee: { select: { id: true, firstName: true, lastName: true } } } });
  await prisma.attendanceRecord.deleteMany({ where: { tenantId: tid, employeeId: req.params.employeeId as string, date: date.data } });
  if (removed) await logActivityAfter(req, { area: "SHIFTS", action: "attendance.remove", target: { type: "Employee", id: removed.employee.id, label: `${removed.employee.firstName} ${removed.employee.lastName}`.trim() }, summary: `Removed ${removed.employee.firstName} ${removed.employee.lastName}'s attendance (${removed.status.toLowerCase()}) for ${date.data.toISOString().slice(0, 10)}` });
  res.status(204).send();
});
