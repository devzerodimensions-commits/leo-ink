/**
 * Local PostgreSQL for development and tests.
 *
 * Production runs a normal PostgreSQL server (see docker-compose.yml). For local
 * work this script serves PGlite — real PostgreSQL 17 compiled to WASM — over the
 * PostgreSQL wire protocol on the same port, so Prisma, psql and the app talk to
 * it exactly as they would to a server. Same SQL, same `numeric` semantics, same
 * `SELECT … FOR UPDATE` used by gap-free numbering (FR-107).
 *
 *   npx tsx scripts/db.ts start          — serve the dev database on 5433
 *   npx tsx scripts/db.ts start --test   — serve an ephemeral in-memory database on 5434
 */
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export const DEV_PORT = 5433;
export const TEST_PORT = 5434;

// Keep the cluster out of the project tree — this repo lives under a path with
// spaces, which several Postgres tools on Windows handle badly.
const DEV_DATA_DIR = process.env.LEOINK_PGDATA ?? path.join(os.homedir(), 'AppData', 'Local', 'leo-ink', 'pgdata');

export interface ServedDatabase {
  server: PGLiteSocketServer;
  db: PGlite;
  url: string;
  stop: () => Promise<void>;
}

export async function serveDatabase(options: {
  port: number;
  dataDir?: string;
  maxConnections?: number;
}): Promise<ServedDatabase> {
  const db = await PGlite.create(options.dataDir ? { dataDir: options.dataDir } : {});
  const server = new PGLiteSocketServer({
    db,
    port: options.port,
    host: '127.0.0.1',
    // Defaults to 1, which wedges the socket as soon as a second process connects
    // (the API plus a seed script, say). Queries still serialise onto the single
    // WASM backend; this only lets several clients hold a connection at once.
    maxConnections: options.maxConnections ?? 20,
  });
  await server.start();

  // `pgbouncer=true` stops Prisma naming its prepared statements. PGlite maps every
  // client connection onto ONE PostgreSQL backend, so two processes (API + seed, or
  // two test workers) would otherwise both try to register "s0" and collide — 42P05.
  // A real PostgreSQL server gives each connection its own session and needs no flag.
  const url = `postgresql://postgres:postgres@127.0.0.1:${options.port}/postgres?schema=public&connection_limit=1&pool_timeout=30&pgbouncer=true`;

  return {
    server,
    db,
    url,
    stop: async () => {
      await server.stop().catch(() => {});
      await db.close().catch(() => {});
    },
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isMain) {
  const useTest = process.argv.includes('--test');
  const served = await serveDatabase(
    useTest ? { port: TEST_PORT } : { port: DEV_PORT, dataDir: DEV_DATA_DIR },
  );

  process.stdout.write(
    `PostgreSQL (PGlite) listening on 127.0.0.1:${useTest ? TEST_PORT : DEV_PORT}\n` +
      `  DATABASE_URL=${served.url}\n` +
      `  data: ${useTest ? '(in-memory)' : DEV_DATA_DIR}\n` +
      'READY\n',
  );

  const shutdown = async () => {
    await served.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  setInterval(() => {}, 1 << 30);
}
