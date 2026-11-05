import type { NextFunction, Request, Response } from "express";
import type { ModuleKey, Permission } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

/**
 * Reads the `x-tenant-id` header and attaches it to `req.tenantId`. The
 * x-user-id it also reads is only a claim: under /api, authenticate replaces it
 * with the signed-in session's employee before any route sees it.
 */
export function tenantContext(req: Request, _res: Response, next: NextFunction): void {
  const tenantId = req.header("x-tenant-id");
  if (tenantId) {
    req.tenantId = tenantId;
  }
  const userId = req.header("x-user-id");
  if (userId) {
    req.userId = userId;
  }
  next();
}

/**
 * Temporary role guard until full permission checks are wired up everywhere.
 * The acting employee is resolved from x-user-id (set from the logged-in
 * session) within the current tenant; only Super Admin / Manager may
 * perform protected operations.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.tenantId || !req.userId) {
    res.status(401).json({ error: "An authenticated admin user is required" });
    return;
  }

  prisma.employee
    .findFirst({
      where: {
        id: req.userId,
        tenantId: req.tenantId,
        status: "ACTIVE",
        role: { name: { in: ["Super Admin", "Manager"] } },
      },
      select: { id: true },
    })
    .then((admin) => {
      if (!admin) {
        res.status(403).json({ error: "Only a main admin can delete stores" });
        return;
      }
      next();
    })
    .catch(next);
}

/**
 * The real, generic permission check — resolves the acting employee's role
 * and reports whether that role's `permissions` array (Roles & Permissions
 * ▸ Capabilities) includes the one named here. A Super Admin always passes,
 * so the top of every tenant's org chart can never lock itself out even
 * before it's granted anything explicitly. This is what `allowedSections`
 * never was: allowedSections only hides sidebar/routes client-side, this
 * actually authorizes (or rejects) the request.
 *
 * Exported standalone (not just as the middleware below) for the handful of
 * places a permission only matters conditionally — e.g. marking a COUNTER-
 * mode order served needs POS_APPROVE_COUNTER, but a KITCHEN-mode order's
 * "waiter serves it" step needs no permission at all, and only the handler
 * knows which case it's in.
 */
export async function hasPermission(tenantId: string | undefined, userId: string | undefined, permission: Permission): Promise<boolean> {
  if (!tenantId || !userId) return false;
  const employee = await prisma.employee.findFirst({
    where: { id: userId, tenantId, status: "ACTIVE" },
    select: { role: { select: { name: true, permissions: true } } },
  });
  if (!employee) return false;
  const isSuperAdmin = employee.role?.name === "Super Admin";
  return isSuperAdmin || (employee.role?.permissions.includes(permission) ?? false);
}

/** Middleware factory built on {@link hasPermission} for routes that need
 * the same permission unconditionally, every time. */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.tenantId || !req.userId) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    hasPermission(req.tenantId, req.userId, permission)
      .then((ok) => {
        if (!ok) { res.status(403).json({ error: "You don't have permission to do this" }); return; }
        next();
      })
      .catch(next);
  };
}

/**
 * Middleware factory: ensures the current tenant (from req.tenantId)
 * has the given module enabled before allowing the request through.
 *
 * NOTE: since there is no auth/session layer yet, tenant identity comes
 * solely from the x-tenant-id header. This will be replaced by a proper
 * authenticated tenant lookup once auth is added.
 */
export function requireModule(moduleKey: ModuleKey) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tenantId } = req;

      if (!tenantId) {
        res.status(400).json({ error: "Missing x-tenant-id header" });
        return;
      }

      const tenantModule = await prisma.tenantModule.findUnique({
        where: {
          tenantId_moduleKey: {
            tenantId,
            moduleKey,
          },
        },
      });

      if (!tenantModule || !tenantModule.isEnabled) {
        res.status(403).json({ error: "Module not enabled for this tenant" });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
