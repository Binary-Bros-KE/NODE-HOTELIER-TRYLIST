import type { HousekeepingEventAction, HousekeepingTask, HousekeepingTaskSource, HousekeepingTaskType, Prisma } from "@prisma/client";

import { prisma } from "./prisma.js";
import { nextHousekeepingTaskNo } from "./sequence.js";

/**
 * The one place housekeeping task rules live. Routes, Reception (checkout) and
 * Rooms (manual dirty/clean flips) all go through here so a room's cleanliness
 * can only ever change as a side effect of a task moving through its lifecycle:
 *
 *   PENDING -> IN_PROGRESS -> COMPLETED      (assignee, or a supervisor)
 *   PENDING | IN_PROGRESS -> CANCELLED       (supervisor, with a reason)
 *
 * COMPLETED and CANCELLED are terminal; tasks are never deleted.
 */

type Tx = Prisma.TransactionClient;

export class HousekeepingError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export type HkActor = { id: string; name: string; isManager: boolean };

export const ACTIVE_STATUSES = ["PENDING", "IN_PROGRESS"] as const;

export async function loadActor(tenantId: string | undefined, userId: string | undefined): Promise<HkActor> {
  if (!tenantId || !userId) throw new HousekeepingError("Sign in required", 401);
  const employee = await prisma.employee.findFirst({
    where: { id: userId, tenantId, status: "ACTIVE" },
    select: { id: true, firstName: true, lastName: true, isSupervisor: true, role: { select: { name: true } } },
  });
  if (!employee) throw new HousekeepingError("Sign in required", 401);
  const roleName = employee.role?.name;
  return {
    id: employee.id,
    name: `${employee.firstName} ${employee.lastName}`.trim(),
    isManager: roleName === "Super Admin" || employee.isSupervisor,
  };
}

export async function logTaskEvent(tx: Tx, task: { id: string; tenantId: string }, action: HousekeepingEventAction, summary: string, actor?: { id: string; name: string } | null) {
  await tx.housekeepingTaskEvent.create({
    data: { tenantId: task.tenantId, taskId: task.id, action, summary, performedBy: actor?.id ?? null, performerName: actor?.name ?? null },
  });
}

async function findAssignee(tx: Tx, tenantId: string, employeeId: string) {
  const employee = await tx.employee.findFirst({ where: { id: employeeId, tenantId, status: "ACTIVE" }, select: { id: true, firstName: true, lastName: true } });
  if (!employee) throw new HousekeepingError("Choose an active employee to assign this task to");
  return { id: employee.id, name: `${employee.firstName} ${employee.lastName}`.trim() };
}

/**
 * Flags a room as needing service: sets it DIRTY and opens an unassigned
 * CLEANING task, unless one is already open. Returns the new task, or null when
 * one already existed. Used by checkout, manual "mark dirty" and cancel.
 */
export async function createRoomTask(
  tx: Tx,
  args: { tenantId: string; roomId: string; source: HousekeepingTaskSource; reservationId?: string | null; notes?: string; actor?: { id: string; name: string } | null },
) {
  const room = await tx.room.findFirst({ where: { id: args.roomId, tenantId: args.tenantId }, select: { id: true, number: true } });
  if (!room) throw new HousekeepingError("Room not found", 404);
  await tx.room.update({ where: { id: room.id }, data: { cleanliness: "DIRTY" } });
  const active = await tx.housekeepingTask.findFirst({ where: { tenantId: args.tenantId, roomId: room.id, type: "CLEANING", status: { in: [...ACTIVE_STATUSES] } }, select: { id: true } });
  if (active) return null;
  const task = await tx.housekeepingTask.create({
    data: {
      tenantId: args.tenantId,
      taskNo: await nextHousekeepingTaskNo(args.tenantId),
      roomId: room.id,
      roomNumber: room.number,
      type: "CLEANING",
      source: args.source,
      reservationId: args.reservationId ?? null,
      notes: args.notes,
      createdBy: args.actor?.id ?? null,
    },
  });
  await logTaskEvent(tx, task, "CREATED", args.notes ?? `Cleaning task opened for room ${room.number}`, args.actor);
  return task;
}

/** Creates a supervisor-defined task (room task of any type, or a general task with a title). */
export async function createManualTask(
  tx: Tx,
  args: { tenantId: string; actor: HkActor; roomId?: string; title?: string; type: HousekeepingTaskType; priority?: "LOW" | "NORMAL" | "HIGH"; dueAt?: Date; notes?: string; assignedToId?: string },
) {
  let roomNumber: string | null = null;
  if (args.roomId) {
    const room = await tx.room.findFirst({ where: { id: args.roomId, tenantId: args.tenantId }, select: { id: true, number: true } });
    if (!room) throw new HousekeepingError("Choose a room from this property");
    roomNumber = room.number;
    const duplicate = await tx.housekeepingTask.findFirst({ where: { tenantId: args.tenantId, roomId: room.id, type: args.type, status: { in: [...ACTIVE_STATUSES] } }, select: { id: true } });
    if (duplicate) throw new HousekeepingError(`An active ${args.type.toLowerCase()} task already exists for room ${room.number}`, 409);
  } else if (!args.title) {
    throw new HousekeepingError("Give the task a title, or choose a room");
  }
  const assignee = args.assignedToId ? await findAssignee(tx, args.tenantId, args.assignedToId) : null;
  const now = new Date();
  const task = await tx.housekeepingTask.create({
    data: {
      tenantId: args.tenantId,
      taskNo: await nextHousekeepingTaskNo(args.tenantId),
      roomId: args.roomId ?? null,
      roomNumber,
      title: args.title ?? null,
      type: args.roomId ? args.type : "GENERAL",
      priority: args.priority ?? "NORMAL",
      source: "MANUAL",
      dueAt: args.dueAt,
      notes: args.notes,
      createdBy: args.actor.id,
      ...(assignee ? { assignedToId: assignee.id, assignedToName: assignee.name, assignedAt: now, assignedById: args.actor.id } : {}),
    },
  });
  if (args.roomId && args.type === "CLEANING") await tx.room.update({ where: { id: args.roomId }, data: { cleanliness: "DIRTY" } });
  await logTaskEvent(tx, task, "CREATED", args.title ?? `${args.type.toLowerCase()} task for room ${roomNumber}`, args.actor);
  if (assignee) await logTaskEvent(tx, task, "ASSIGNED", `Assigned to ${assignee.name}`, args.actor);
  return task;
}

export async function assignTask(tx: Tx, task: HousekeepingTask, employeeId: string, actor: HkActor) {
  if (!actor.isManager) throw new HousekeepingError("Only a supervisor can assign tasks", 403);
  if (task.status === "COMPLETED" || task.status === "CANCELLED") throw new HousekeepingError(`This task is already ${task.status.toLowerCase()}`, 409);
  const assignee = await findAssignee(tx, task.tenantId, employeeId);
  if (task.assignedToId === assignee.id) return task;
  const reassign = Boolean(task.assignedToId);
  // Handing over mid-task starts the new person's clock afresh; the timeline keeps the first attempt.
  const restart = task.status === "IN_PROGRESS";
  const updated = await tx.housekeepingTask.update({
    where: { id: task.id },
    data: {
      assignedToId: assignee.id,
      assignedToName: assignee.name,
      assignedAt: new Date(),
      assignedById: actor.id,
      updatedBy: actor.id,
      ...(restart ? { status: "PENDING", startedAt: null, startedById: null } : {}),
    },
  });
  if (restart && task.roomId && task.type === "CLEANING") await tx.room.update({ where: { id: task.roomId }, data: { cleanliness: "DIRTY" } });
  await logTaskEvent(tx, task, reassign ? "REASSIGNED" : "ASSIGNED", `${reassign ? "Reassigned" : "Assigned"} to ${assignee.name}${restart ? " (work restarted)" : ""}`, actor);
  return updated;
}

function assertCanWork(task: HousekeepingTask, actor: HkActor) {
  if (!actor.isManager && task.assignedToId !== actor.id) throw new HousekeepingError("This task is not assigned to you", 403);
}

export async function startTask(tx: Tx, task: HousekeepingTask, actor: HkActor) {
  assertCanWork(task, actor);
  if (task.status !== "PENDING") throw new HousekeepingError(`A ${task.status.toLowerCase().replace("_", " ")} task cannot be started`, 409);
  if (!task.assignedToId) throw new HousekeepingError("Assign this task to someone before it starts", 409);
  const updated = await tx.housekeepingTask.update({ where: { id: task.id }, data: { status: "IN_PROGRESS", startedAt: new Date(), startedById: actor.id, updatedBy: actor.id } });
  if (task.roomId && task.type === "CLEANING") await tx.room.update({ where: { id: task.roomId }, data: { cleanliness: "INSPECTING" } });
  await logTaskEvent(tx, task, "STARTED", `Started by ${actor.name}`, actor);
  return updated;
}

/** `force` lets a supervisor (or a manual "mark room clean") close a task that was never started. */
export async function completeTask(tx: Tx, task: HousekeepingTask, actor: HkActor, opts: { force?: boolean; summary?: string } = {}) {
  assertCanWork(task, actor);
  if (task.status === "COMPLETED" || task.status === "CANCELLED") throw new HousekeepingError(`This task is already ${task.status.toLowerCase()}`, 409);
  if (task.status !== "IN_PROGRESS" && !opts.force) throw new HousekeepingError("Start the task before completing it", 409);
  const updated = await tx.housekeepingTask.update({
    where: { id: task.id },
    data: { status: "COMPLETED", completedAt: new Date(), completedById: actor.id, completedByName: actor.name, updatedBy: actor.id },
  });
  if (task.roomId && (task.type === "CLEANING" || task.type === "INSPECTION")) {
    const otherActive = await tx.housekeepingTask.count({ where: { tenantId: task.tenantId, roomId: task.roomId, type: "CLEANING", status: { in: [...ACTIVE_STATUSES] }, id: { not: task.id } } });
    if (otherActive === 0) await tx.room.update({ where: { id: task.roomId }, data: { cleanliness: "CLEAN" } });
  }
  await logTaskEvent(tx, task, "COMPLETED", opts.summary ?? `Completed by ${actor.name}`, actor);
  return updated;
}

export async function cancelTask(tx: Tx, task: HousekeepingTask, actor: HkActor, reason: string) {
  if (!actor.isManager) throw new HousekeepingError("Only a supervisor can cancel tasks", 403);
  if (task.status === "COMPLETED" || task.status === "CANCELLED") throw new HousekeepingError(`This task is already ${task.status.toLowerCase()}`, 409);
  const updated = await tx.housekeepingTask.update({
    where: { id: task.id },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: actor.id, cancelReason: reason, updatedBy: actor.id },
  });
  await logTaskEvent(tx, task, "CANCELLED", `Cancelled by ${actor.name}: ${reason}`, actor);
  // A cancelled cleaning task must not strand its room: if it is still dirty,
  // reopen a fresh unassigned task so it stays on the supervisor's list.
  if (task.roomId && task.type === "CLEANING") {
    const room = await tx.room.findUnique({ where: { id: task.roomId }, select: { cleanliness: true } });
    if (room && room.cleanliness !== "CLEAN") {
      await createRoomTask(tx, { tenantId: task.tenantId, roomId: task.roomId, source: task.source, reservationId: task.reservationId, notes: `Reopened after cancellation (${reason})`, actor });
    }
  }
  return updated;
}

/** A manual "room is clean" flip closes the room's open cleaning task so tasks and room state agree. */
export async function completeOpenCleaningTasks(tx: Tx, tenantId: string, roomId: string, actor: HkActor) {
  const open = await tx.housekeepingTask.findMany({ where: { tenantId, roomId, type: "CLEANING", status: { in: [...ACTIVE_STATUSES] } } });
  for (const task of open) {
    await completeTaskAsOverride(tx, task, actor);
  }
}

async function completeTaskAsOverride(tx: Tx, task: HousekeepingTask, actor: HkActor) {
  // Ownership doesn't apply: the room was marked clean by whoever is on the Rooms screen.
  await tx.housekeepingTask.update({
    where: { id: task.id },
    data: { status: "COMPLETED", completedAt: new Date(), completedById: actor.id, completedByName: actor.name, updatedBy: actor.id },
  });
  await logTaskEvent(tx, task, "COMPLETED", `Room marked clean manually by ${actor.name}`, actor);
}

export const minutesBetween = (from: Date | null | undefined, to: Date | null | undefined) =>
  from && to ? Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000)) : null;
