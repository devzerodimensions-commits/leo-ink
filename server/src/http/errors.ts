import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { PricingError } from '../engine/pricing.js';

export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'BAD_REQUEST',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string, code = 'BAD_REQUEST', details?: unknown) => new AppError(m, 400, code, details);
export const unauthorized = (m = 'Authentication required') => new AppError(m, 401, 'UNAUTHORIZED');
export const forbidden = (m = 'You do not have permission to perform this action') => new AppError(m, 403, 'FORBIDDEN');
export const notFound = (m = 'Not found') => new AppError(m, 404, 'NOT_FOUND');
export const conflict = (m: string, code = 'CONFLICT') => new AppError(m, 409, code);
export const unprocessable = (m: string, code = 'UNPROCESSABLE', details?: unknown) =>
  new AppError(m, 422, code, details);

/** Wrap async route handlers so rejected promises reach the error middleware. */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}

interface FieldIssue {
  field: string;
  message: string;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    const fields: FieldIssue[] = err.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    }));
    res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed', fields } });
    return;
  }

  if (err instanceof PricingError) {
    res.status(422).json({
      error: { code: err.code, message: err.message, lineNo: err.lineNo },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  // Prisma unique-constraint violations surface as a clean 409.
  const e = err as { code?: string; meta?: { target?: string[] }; message?: string };
  if (e?.code === 'P2002') {
    res.status(409).json({
      error: {
        code: 'DUPLICATE',
        message: `A record with this ${(e.meta?.target ?? ['value']).join(', ')} already exists`,
      },
    });
    return;
  }
  if (e?.code === 'P2025') {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
    return;
  }

  // eslint-disable-next-line no-console
  console.error('[leo-ink] unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}
