import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { nairobiWallClockToUtc } from "../../lib/shifts.js";
import {
  ACTIVE_STATUSES,
  HousekeepingError,
  assignTask,
  cancelTask,
  completeTask,
  createManualTask,
  loadActor,
  logTaskEvent,
  minutesBetween,
  startTask,
  type HkActor,
} from "../../lib/housekeeping.js";

// Workflow: a supervisor (isSupervisor, Manager or Super Admin) receives work,
// assigns it to a housekeeping employee, who starts and completes it. There is
// no delete and no room swap: a room only leaves the task list by being
// cleaned, and a wrongly raised task is cancelled (with a reason) so the
// record survives. See lib/housekeeping.ts for the state machine.
export const housekeepingRouter = Router();
housekeepingRouter.use(requireModule("HOUSEKEEPING"));

const TASK_TYPES = ["CLEANING", "INSPECTION", "MAINTENANCE", "GENERAL"] as const;
const PRIORITIES = ["LOW", "NORMAL", "HIGH"] as const;

const createSchema = z.object({
  roomId: z.string().cuid().optional(),
  title: z.string().trim().min(2).max(120).optional(),
  type: z.enum(TASK_TYPES).default("CLEANING"),
  priority: z.enum(PRIORITIES).default("NORMAL"),
  assignedToId: z.string().cuid().optional(),
  notes: z.string().trim().max(500).optional(),
  dueAt: z.coerce.date().optional(),
});
const patchSchema = z.object({
  title: z.string().trim().min(2).max(120).optional(),
  priority: z.enum(PRIORITIES).optional(),
  notes: z.string().trim().max(500).optional(),
  dueAt: z.coerce.date().nullable().optional(),
});
const listSchema = z.object({
  status: z.enum(["active", "PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).default("active"),
  type: z.enum(TASK_TYPES).optional(),
  roomId: z.string().cuid().optional(),
  assigneeId: z.string().cuid().optional(),
  search: z.string().trim().max(80).optional(),
});
const historySchema = z.object({
  status: z.enum(["COMPLETED", "CANCELLED"]).optional(),
  type: z.enum(TASK_TYPES).optional(),
  roomId: z.string().cuid().optional(),
  assigneeId: z.string().cuid().optional(),
  search: z.string().trim().max(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const monthSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });

function tenantId(req: { tenantId?: string }): string {
  if (!req.tenantId) throw new HousekeepingError("Tenant context is required");
  return req.tenantId;
}

const taskInclude = {
  room: { select: { id: true, number: true, name: true, status: true, cleanliness: true } },
  assignee: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.HousekeepingTaskInclude;

function serialize<T extends { status: string; dueAt: Date | null; startedAt: Date | null; completedAt: Date | null; assignedAt: Date | null; createdAt: Date; assignedToName: string | null; assignedTo: string | null; assignee?: { firstName: string; lastName: string } | null }>(task: T) {
  const assigneeName = task.assignee ? `${task.assignee.firstName} ${task.assignee.lastName}`.trim() : task.assignedToName ?? (task.assignedTo ? `${task.assignedTo} (legacy)` : null);
  return {
    ...task,
    assigneeName,
    overdue: (ACTIVE_STATUSES as readonly string[]).includes(task.status) && Boolean(task.dueAt) && task.dueAt!.getTime() < Date.now(),
    waitMinutes: minutesBetween(task.assignedAt ?? task.createdAt, task.startedAt),
    workMinutes: minutesBetween(task.startedAt, task.completedAt),
    totalMinutes: minutesBetween(task.createdAt, task.completedAt),
  };
}

const PRIORITY_RANK = { HIGH: 0, NORMAL: 1, LOW: 2 } as const;

// One wrapper so every handler can throw HousekeepingError and get a clean status.
const handle = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((error) => {
    if (error instanceof HousekeepingError) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  });
};

async function loadTask(req: Request, actor: HkActor) {
  const task = await prisma.housekeepingTask.findFirst({ where: { id: req.params.id as string, tenantId: tenantId(req) } });
  if (!task || (!actor.isManager && task.assignedToId !== actor.id)) throw new HousekeepingError("Housekeeping task not found", 404);
  return task;
}

housekeepingRouter.get("/rooms", handle(async (req, res) => {
  const rooms = await prisma.room.findMany({ where: { tenantId: tenantId(req) }, include: { roomType: true }, orderBy: [{ cleanliness: "desc" }, { number: "asc" }] });
  res.json({ rooms, summary: { ready: rooms.filter((room) => room.status === "VACANT" && room.cleanliness === "CLEAN").length, needsService: rooms.filter((room) => room.cleanliness !== "CLEAN").length } });
}));

/** Who the current user is here - lets the UI choose the supervisor or employee view. */
housekeepingRouter.get("/me", handle(async (req, res) => {
  const actor = await loadActor(req.tenantId, req.userId);
  res.json({ id: actor.id, name: actor.name, isManager: actor.isManager });
}));

// Deliberately not /employees: that payload carries salary data.
housekeepingRouter.get("/staff", handle(async (req, res) => {
  const tid = tenantId(req);
  const actor = await loadActor(tid, req.userId);
  if (!actor.isManager) throw new HousekeepingError("Only a supervisor can see the staff list", 403);
  const [employees, counts] = await Promise.all([
    prisma.employee.findMany({
      where: { tenantId: tid, status: "ACTIVE", department: { name: { equals: "Housekeeping", mode: "insensitive" } } },
      select: { id: true, firstName: true, lastName: true, employeeCode: true, isSupervisor: true, jobTitle: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    prisma.housekeepingTask.groupBy({ by: ["assignedToId"], where: { tenantId: tid, status: { in: [...ACTIVE_STATUSES] }, assignedToId: { not: null } }, _count: { _all: true } }),
  ]);
  const active = new Map(counts.map((c) => [c.assignedToId, c._count._all]));
  res.json({ staff: employees.map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}`.trim(), employeeCode: e.employeeCode, jobTitle: e.jobTitle, isSupervisor: e.isSupervisor, activeTasks: active.get(e.id) ?? 0 })) });
}));

housekeepingRouter.get("/tasks", handle(async (req, res) => {
  const query = listSchema.safeParse(req.query);
  if (!query.success) throw new HousekeepingError("Invalid task filters");
  const tid = tenantId(req);
  const actor = await loadActor(tid, req.userId);
  const { status, type, roomId, assigneeId, search } = query.data;
  const scope: Prisma.HousekeepingTaskWhereInput = { tenantId: tid, ...(actor.isManager ? {} : { assignedToId: actor.id }) };
  const where: Prisma.HousekeepingTaskWhereInput = {
    ...scope,
    status: status === "active" ? { in: [...ACTIVE_STATUSES] } : status,
    ...(type ? { type } : {}),
    ...(roomId ? { roomId } : {}),
    ...(assigneeId && actor.isManager ? { assignedToId: assigneeId } : {}),
    ...(search ? { OR: [{ title: { contains: search, mode: "insensitive" } }, { roomNumber: { contains: search, mode: "insensitive" } }, { taskNo: { contains: search, mode: "insensitive" } }, { assignedToName: { contains: search, mode: "insensitive" } }] } : {}),
  };
  const [tasks, pending, inProgress, unassigned] = await Promise.all([
    prisma.housekeepingTask.findMany({ where, include: taskInclude, take: 500 }),
    prisma.housekeepingTask.count({ where: { ...scope, status: "PENDING" } }),
    prisma.housekeepingTask.count({ where: { ...scope, status: "IN_PROGRESS" } }),
    actor.isManager ? prisma.housekeepingTask.count({ where: { tenantId: tid, status: "PENDING", assignedToId: null } }) : Promise.resolve(0),
  ]);
  const rows = tasks.map(serialize).sort((a, b) =>
    Number(b.overdue) - Number(a.overdue)
    || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity)
    || a.createdAt.getTime() - b.createdAt.getTime());
  res.json({ tasks: rows, summary: { pending, inProgress, unassigned, overdue: rows.filter((t) => t.overdue).length }, isManager: actor.isManager });
}));

/** Cheap poll target for the sidebar badge: what needs *my* attention. */
housekeepingRouter.get("/tasks/count", handle(async (req, res) => {
  const tid = tenantId(req);
  const actor = await loadActor(tid, req.userId);
  const [assignedPending, unassigned] = await Promise.all([
    prisma.housekeepingTask.count({ where: { tenantId: tid, assignedToId: actor.id, status: "PENDING" } }),
    actor.isManager ? prisma.housekeepingTask.count({ where: { tenantId: tid, assignedToId: null, status: "PENDING" } }) : Promise.resolve(0),
  ]);
  res.json({ assignedPending, unassigned, badge: actor.isManager ? unassigned + assignedPending : assignedPending });
}));

housekeepingRouter.get("/history", handle(async (req, res) => {
  const query = historySchema.safeParse(req.query);
  if (!query.success) throw new HousekeepingError("Invalid history filters");
  const tid = tenantId(req);
  const actor = await loadActor(tid, req.userId);
  const { status, type, roomId, assigneeId, search, from, to, limit } = query.data;
  const range = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(to.getTime() + 86_400_000) } : {}) } : undefined;
  const where: Prisma.HousekeepingTaskWhereInput = {
    tenantId: tid,
    ...(actor.isManager ? (assigneeId ? { assignedToId: assigneeId } : {}) : { assignedToId: actor.id }),
    status: status ?? { in: ["COMPLETED", "CANCELLED"] },
    ...(type ? { type } : {}),
    ...(roomId ? { roomId } : {}),
    ...(range ? { OR: [{ completedAt: range }, { cancelledAt: range }] } : {}),
    ...(search ? { AND: [{ OR: [{ title: { contains: search, mode: "insensitive" } }, { roomNumber: { contains: search, mode: "insensitive" } }, { taskNo: { contains: search, mode: "insensitive" } }, { assignedToName: { contains: search, mode: "insensitive" } }] }] } : {}),
  };
  const tasks = (await prisma.housekeepingTask.findMany({ where, include: taskInclude, orderBy: { updatedAt: "desc" }, take: limit })).map(serialize);
  const done = tasks.filter((t) => t.status === "COMPLETED");
  const worked = done.map((t) => t.workMinutes).filter((m): m is number => m !== null);
  res.json({
    tasks,
    summary: {
      completed: done.length,
      cancelled: tasks.length - done.length,
      avgWorkMinutes: worked.length ? Math.round(worked.reduce((a, b) => a + b, 0) / worked.length) : null,
      totalWorkMinutes: worked.reduce((a, b) => a + b, 0),
    },
  });
}));

housekeepingRouter.get("/tasks/:id", handle(async (req, res) => {
  const actor = await loadActor(req.tenantId, req.userId);
  const found = await loadTask(req, actor);
  const task = await prisma.housekeepingTask.findUniqueOrThrow({ where: { id: found.id }, include: { ...taskInclude, events: { orderBy: { occurredAt: "asc" } } } });
  res.json({ task: serialize(task) });
}));

housekeepingRouter.post("/tasks", handle(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid housekeeping task", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const actor = await loadActor(tid, req.userId);
  if (!actor.isManager) throw new HousekeepingError("Only a supervisor can create tasks", 403);
  const task = await prisma.$transaction((tx) => createManualTask(tx, { tenantId: tid, actor, ...parsed.data }));
  res.status(201).json({ task: serialize(await prisma.housekeepingTask.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude })) });
}));

// Only descriptive fields: the room, type and status can never be edited.
housekeepingRouter.patch("/tasks/:id", handle(async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid housekeeping task", details: parsed.error.flatten() }); return; }
  const actor = await loadActor(req.tenantId, req.userId);
  if (!actor.isManager) throw new HousekeepingError("Only a supervisor can edit tasks", 403);
  const task = await loadTask(req, actor);
  if (task.status === "COMPLETED" || task.status === "CANCELLED") throw new HousekeepingError(`This task is already ${task.status.toLowerCase()}`, 409);
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.housekeepingTask.update({ where: { id: task.id }, data: { ...parsed.data, updatedBy: actor.id }, include: taskInclude });
    await logTaskEvent(tx, task, "EDITED", `Details updated by ${actor.name}`, actor);
    return next;
  });
  res.json({ task: serialize(updated) });
}));

const transition = (fn: (tx: Prisma.TransactionClient, task: Awaited<ReturnType<typeof loadTask>>, actor: HkActor, body: Record<string, unknown>) => Promise<unknown>) =>
  handle(async (req, res) => {
    const actor = await loadActor(req.tenantId, req.userId);
    const task = await loadTask(req, actor);
    await prisma.$transaction((tx) => fn(tx, task, actor, (req.body ?? {}) as Record<string, unknown>));
    const fresh = await prisma.housekeepingTask.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
    res.json({ task: serialize(fresh) });
  });

housekeepingRouter.post("/tasks/:id/assign", transition(async (tx, task, actor, body) => {
  const parsed = z.object({ employeeId: z.string().cuid() }).safeParse(body);
  if (!parsed.success) throw new HousekeepingError("Choose an employee");
  return assignTask(tx, task, parsed.data.employeeId, actor);
}));
housekeepingRouter.post("/tasks/:id/start", transition((tx, task, actor) => startTask(tx, task, actor)));
housekeepingRouter.post("/tasks/:id/complete", transition((tx, task, actor) => completeTask(tx, task, actor)));
housekeepingRouter.post("/tasks/:id/cancel", transition(async (tx, task, actor, body) => {
  const parsed = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(body);
  if (!parsed.success) throw new HousekeepingError("Give a reason for cancelling this task");
  return cancelTask(tx, task, actor, parsed.data.reason);
}));

// ---------------------------------------------------------------- reports

function monthWindow(month: string) {
  const [year, m] = month.split("-").map(Number);
  return { from: nairobiWallClockToUtc(year, m, 1, 0, 0), to: nairobiWallClockToUtc(year, m + 1, 1, 0, 0) };
}

async function employeeReport(tid: string, month: string, onlyEmployeeId?: string) {
  const { from, to } = monthWindow(month);
  const [completed, cancelled, sessions, staff] = await Promise.all([
    prisma.housekeepingTask.findMany({
      where: { tenantId: tid, status: "COMPLETED", completedAt: { gte: from, lt: to }, ...(onlyEmployeeId ? { OR: [{ completedById: onlyEmployeeId }, { assignedToId: onlyEmployeeId }] } : {}) },
      select: { id: true, taskNo: true, type: true, title: true, roomNumber: true, dueAt: true, assignedToId: true, completedById: true, assignedAt: true, createdAt: true, startedAt: true, completedAt: true },
      orderBy: { completedAt: "asc" },
    }),
    prisma.housekeepingTask.findMany({ where: { tenantId: tid, status: "CANCELLED", cancelledAt: { gte: from, lt: to }, assignedToId: onlyEmployeeId ?? { not: null } }, select: { assignedToId: true } }),
    // One grouped read for shift hours (approvedEnd - approvedStart, same as shiftSummary) instead of a summary per shift.
    prisma.shiftSession.findMany({
      where: { tenantId: tid, status: "ENDED", approvedStartAt: { gte: from, lt: to }, ...(onlyEmployeeId ? { employeeId: onlyEmployeeId } : {}) },
      select: { employeeId: true, approvedStartAt: true, approvedEndAt: true, requestedEndAt: true },
    }),
    prisma.employee.findMany({
      where: { tenantId: tid, ...(onlyEmployeeId ? { id: onlyEmployeeId } : { status: "ACTIVE", department: { name: { equals: "Housekeeping", mode: "insensitive" } } }) },
      select: { id: true, firstName: true, lastName: true, employeeCode: true, jobTitle: true },
    }),
  ]);

  type Row = { employeeId: string; name: string; employeeCode: string | null; jobTitle: string | null; tasksCompleted: number; byType: Record<string, number>; totalWorkMinutes: number; timedTasks: number; avgWorkMinutes: number | null; dueTasks: number; onTime: number; onTimeRate: number | null; cancelled: number; shifts: number; shiftHours: number; tasks: typeof completed };
  const rows = new Map<string, Row>();
  const ensure = (id: string, e?: { firstName: string; lastName: string; employeeCode: string | null; jobTitle: string | null }): Row => {
    let row = rows.get(id);
    if (!row) {
      row = { employeeId: id, name: e ? `${e.firstName} ${e.lastName}`.trim() : "Former employee", employeeCode: e?.employeeCode ?? null, jobTitle: e?.jobTitle ?? null, tasksCompleted: 0, byType: {}, totalWorkMinutes: 0, timedTasks: 0, avgWorkMinutes: null, dueTasks: 0, onTime: 0, onTimeRate: null, cancelled: 0, shifts: 0, shiftHours: 0, tasks: [] };
      rows.set(id, row);
    }
    return row;
  };
  for (const e of staff) ensure(e.id, e);
  const known = new Map(staff.map((e) => [e.id, e]));
  for (const task of completed) {
    const owner = task.completedById ?? task.assignedToId;
    if (!owner || (onlyEmployeeId && owner !== onlyEmployeeId)) continue;
    const row = ensure(owner, known.get(owner));
    row.tasksCompleted += 1;
    row.byType[task.type] = (row.byType[task.type] ?? 0) + 1;
    const minutes = minutesBetween(task.startedAt, task.completedAt);
    if (minutes !== null) { row.totalWorkMinutes += minutes; row.timedTasks += 1; }
    if (task.dueAt && task.completedAt) { row.dueTasks += 1; if (task.completedAt <= task.dueAt) row.onTime += 1; }
    row.tasks.push(task);
  }
  for (const task of cancelled) if (task.assignedToId) ensure(task.assignedToId, known.get(task.assignedToId)).cancelled += 1;
  for (const s of sessions) {
    const end = s.approvedEndAt ?? s.requestedEndAt;
    if (!s.approvedStartAt || !end) continue;
    const row = ensure(s.employeeId, known.get(s.employeeId));
    row.shifts += 1;
    row.shiftHours += Math.max(0, (end.getTime() - s.approvedStartAt.getTime()) / 36e5);
  }
  for (const row of rows.values()) {
    row.avgWorkMinutes = row.timedTasks ? Math.round(row.totalWorkMinutes / row.timedTasks) : null;
    row.onTimeRate = row.dueTasks ? Math.round((row.onTime / row.dueTasks) * 100) : null;
    row.shiftHours = Math.round(row.shiftHours * 10) / 10;
  }
  return { month, from, to, employees: [...rows.values()].sort((a, b) => b.tasksCompleted - a.tasksCompleted || a.name.localeCompare(b.name)) };
}

housekeepingRouter.get("/reports/employees", handle(async (req, res) => {
  const query = monthSchema.safeParse(req.query);
  if (!query.success) throw new HousekeepingError("Choose a month (YYYY-MM)");
  const tid = tenantId(req);
  const actor = await loadActor(tid, req.userId);
  if (!actor.isManager) throw new HousekeepingError("Only a supervisor can view the staff report", 403);
  const report = await employeeReport(tid, query.data.month);
  res.json({ ...report, employees: report.employees.map(({ tasks: _tasks, ...row }) => row) });
}));

housekeepingRouter.get("/reports/employees/:employeeId", handle(async (req, res) => {
  const query = monthSchema.safeParse(req.query);
  if (!query.success) throw new HousekeepingError("Choose a month (YYYY-MM)");
  const tid = tenantId(req);
  const actor = await loadActor(tid, req.userId);
  const employeeId = req.params.employeeId === "me" ? actor.id : (req.params.employeeId as string);
  if (!actor.isManager && employeeId !== actor.id) throw new HousekeepingError("You can only view your own report", 403);
  const report = await employeeReport(tid, query.data.month, employeeId);
  const employee = report.employees.find((e) => e.employeeId === employeeId);
  if (!employee) throw new HousekeepingError("Employee not found", 404);
  res.json({ month: report.month, from: report.from, to: report.to, employee });
}));
