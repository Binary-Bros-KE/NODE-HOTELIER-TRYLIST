import type { NextFunction, Request, Response } from "express";

import { prisma } from "../lib/prisma.js";

// A session is good for a day from its last use: an in-use login is pushed forward
// (at most every few hours, so this isn't a write per request), an idle one lapses.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RENEW_WHEN_LEFT_MS = 12 * 60 * 60 * 1000;

// Reached before anyone signs in: resolving the workspace and its branding.
const PUBLIC_GETS = [/^\/health$/, /^\/tenant\/(resolve|modules|license)$/, /^\/business-profile$/];

// Installed print bridges identify themselves with an employee id and no session (see
// PRINT-BRIDGE/src/agent.js). Until they carry a printer key they keep that, for printing only.
const BRIDGE_PATHS = /^\/pos\/print-jobs\/(pending|[^/]+\/(claim|complete|fail))$/;

function bearerToken(req: Request): string | null {
  const header = req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() || null : null;
}

/**
 * Who is acting comes from the signed-in session, never from what the browser says:
 * x-user-id is ignored here and req.userId is set from the session's employee. Every
 * ownership rule, "Super Admin only" check and activity record downstream relies on it.
 * A session ends when it lapses, on logout, when the employee is no longer active, or
 * if it's used against another property.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const claimedUserId = req.userId;
  req.userId = undefined;
  const token = bearerToken(req);

  if (!token) {
    if (req.method === "GET" && PUBLIC_GETS.some((pattern) => pattern.test(req.path))) { next(); return; }
    if (claimedUserId && BRIDGE_PATHS.test(req.path)) { req.userId = claimedUserId; next(); return; }
    res.status(401).json({ error: "Please sign in again", code: "AUTH_REQUIRED" });
    return;
  }

  prisma.session.findUnique({ where: { token }, select: { id: true, tenantId: true, employeeId: true, expiresAt: true, employee: { select: { status: true } } } })
    .then(async (session) => {
      const now = Date.now();
      if (!session || session.expiresAt.getTime() <= now || session.employee.status !== "ACTIVE" || (req.tenantId && req.tenantId !== session.tenantId)) {
        res.status(401).json({ error: "Your session has ended - please sign in again", code: "SESSION_EXPIRED" });
        return;
      }
      req.userId = session.employeeId;
      req.tenantId = session.tenantId;
      if (session.expiresAt.getTime() - now < RENEW_WHEN_LEFT_MS) {
        await prisma.session.update({ where: { id: session.id }, data: { expiresAt: new Date(now + SESSION_TTL_MS) } }).catch(() => {});
      }
      next();
    })
    .catch(next);
}
