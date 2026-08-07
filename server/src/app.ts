import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './env.js';
import { errorHandler } from './http/errors.js';
import { authenticate } from './auth/middleware.js';

import { authRouter } from './modules/auth/routes.js';
import { setupRouter } from './modules/setup/routes.js';
import { mastersRouter } from './modules/masters/routes.js';
import { crmRouter } from './modules/crm/routes.js';
import { quotesRouter } from './modules/quotes/routes.js';
import { productionRouter } from './modules/production/routes.js';

export function createApp() {
  const app = express();

  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(cors({ origin: env.corsOrigin.split(',').map((s) => s.trim()), credentials: true }));
  app.use(express.json({ limit: '5mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'leo-ink', phase: 1 });
  });

  // Public: sign-up, sign-in.
  app.use('/api/auth', authRouter);

  // Everything else is authenticated, tenant-scoped and branch-scoped (BR-4, FR-717).
  app.use('/api', authenticate);
  app.use('/api', setupRouter);
  app.use('/api', mastersRouter);
  app.use('/api', crmRouter);
  app.use('/api', quotesRouter);
  app.use('/api', productionRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } });
  });

  app.use(errorHandler);
  return app;
}
