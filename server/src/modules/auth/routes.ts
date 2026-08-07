/**
 * Public auth routes — mounted at `/api/auth` before the global `authenticate`
 * middleware, so `/register` and `/login` are reachable without a token.
 * `/me` opts back in explicitly.
 *
 * FR-715 (role-based access), FR-723 (self-serve free trial).
 */
import { Router } from 'express';
import { asyncHandler } from '../../http/errors.js';
import { authenticate, requireAuth } from '../../auth/middleware.js';
import { loginSchema, registerSchema } from './schemas.js';
import { login, me, register } from './service.js';

export const authRouter = Router();

/** FR-723 — sign up, seed the tenant and start the free trial in one transaction. */
authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body ?? {});
    res.status(201).json(await register(body));
  }),
);

/** FR-715 — email + password; a DISABLED account is denied. */
authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body ?? {});
    res.json(await login(body));
  }),
);

/** Current session: user, tenant (incl. wizard state), branches, permissions, subscription. */
authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await me(requireAuth(req)));
  }),
);
