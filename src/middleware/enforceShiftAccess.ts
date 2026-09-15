import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";

const ALLOWED_WITHOUT_ACTIVE_SHIFT = [
  /^\/health$/,
  /^\/shifts\/current$/,
  /^\/shifts\/start-request$/,
  /^\/shifts\/approvals$/,
  /^\/shifts\/[^/]+\/start-approval$/,
];

/**
 * Blocks tenant work unless the acting employee has an approved ACTIVE
 * ShiftSession. Mounted after /auth, and the shift request/approval endpoints
 * stay reachable so staff can ask to start work from the dashboard. Super
 * Admin bypasses this; every other role needs an active shift.
 */
export function enforceShiftAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.tenantId || !req.userId) { next(); return; }
  const { tenantId, userId } = req;

  prisma.employee.findFirst({
    where: { id: userId, tenantId, status: "ACTIVE" },
    select: { role: { select: { name: true } } },
  })
    .then(async (employee) => {
      if (employee?.role?.name === "Super Admin") { next(); return; }
      if (ALLOWED_WITHOUT_ACTIVE_SHIFT.some((pattern) => pattern.test(req.path))) { next(); return; }
      const active = await prisma.shiftSession.findFirst({
        where: { tenantId, employeeId: userId, status: "ACTIVE", approvedStartAt: { not: null } },
        select: { id: true },
      });
      if (active) { next(); return; }
      res.status(403).json({
        error: "Request shift start from the dashboard and wait for supervisor approval before using the system.",
        code: "OUTSIDE_SHIFT",
      });
    })
    .catch(next);
}
