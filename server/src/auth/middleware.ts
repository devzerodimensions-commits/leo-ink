import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { forbidden, unauthorized, AppError } from '../http/errors.js';
import { can, type Action, type Module } from './permissions.js';

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: UserRole;
  name: string;
  email: string;
  /** FR-717 — branch ids this user may transact for. Empty + allBranches ⇒ every branch. */
  branchIds: string[];
  allBranches: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export interface TokenPayload {
  sub: string;
  tenantId: string;
  role: UserRole;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

/**
 * FR-715 — the user record is re-read on every request so disabling a user
 * "immediately revokes access" and a role change "takes effect on that user's
 * next request/session".
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw unauthorized();

    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, env.jwtSecret) as TokenPayload;
    } catch {
      throw unauthorized('Session expired or invalid — please sign in again');
    }

    const user = await prisma.user.findFirst({
      where: { id: payload.sub, tenantId: payload.tenantId },
      include: { branches: true },
    });

    if (!user) throw unauthorized();
    if (user.status === 'DISABLED') throw forbidden('This user account has been disabled');

    req.auth = {
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
      name: user.name,
      email: user.email,
      branchIds: user.branches.map((b) => b.branchId),
      allBranches: user.allBranches || user.role === 'OWNER_ADMIN',
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** FR-716 — deny-by-default module/action gate applied to routers and routes. */
export function requirePermission(module: Module, action: Action) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const auth = requireAuth(req);
      if (!can(auth.role, module, action)) {
        throw forbidden(`Your role (${auth.role}) may not ${action} in ${module}`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const auth = requireAuth(req);
      if (!roles.includes(auth.role)) throw forbidden();
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * FR-717 / FR-118 — "a user can only transact for branches they are assigned to".
 * Throws rather than silently filtering so a direct id probe returns 403, per
 * FR-716 ("access is denied, not merely hidden").
 */
export function assertBranchAccess(auth: AuthContext, branchId: string): void {
  if (auth.allBranches) return;
  if (!auth.branchIds.includes(branchId)) {
    throw new AppError('You do not have access to this branch', 403, 'BRANCH_FORBIDDEN');
  }
}

/** Prisma `where` fragment that scopes a query to the caller's tenant and branches. */
export function scopeWhere(auth: AuthContext, branchField = 'branchId'): Record<string, unknown> {
  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (!auth.allBranches && auth.branchIds.length > 0) {
    where[branchField] = { in: auth.branchIds };
  }
  return where;
}
