import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

declare global {
  // eslint-disable-next-line no-var
  var __leoInkPrisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__leoInkPrisma ??
  new PrismaClient({
    datasources: { db: { url: env.databaseUrl } },
    log: env.nodeEnv === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.nodeEnv !== 'production') globalThis.__leoInkPrisma = prisma;

export type Db = typeof prisma;
