/**
 * Boots a throwaway PostgreSQL for the API conformance tests.
 *
 * PGlite is real PostgreSQL 17 compiled to WASM, served over the wire protocol —
 * so `prisma db push`, `numeric` arithmetic and `SELECT … FOR UPDATE` behave
 * exactly as they do against the production server.
 *
 * The database runs *in this process*, so every child process must be spawned
 * asynchronously — a synchronous `execFileSync` would block the event loop and
 * the server could never answer Prisma's connection.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDatabase, TEST_PORT } from '../../scripts/db.js';

const execFileAsync = promisify(execFile);
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_DATA_DIR = path.join(os.homedir(), 'AppData', 'Local', 'leo-ink', 'testdata');

let served: Awaited<ReturnType<typeof serveDatabase>> | undefined;

export async function setup() {
  await rm(TEST_DATA_DIR, { recursive: true, force: true });

  served = await serveDatabase({ port: TEST_PORT, dataDir: TEST_DATA_DIR });
  process.env.DATABASE_URL = served.url;

  // The data directory was just deleted, so this only ever creates tables.
  await execFileAsync('npx', ['prisma', 'db', 'push', '--skip-generate'], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: served.url },
    shell: process.platform === 'win32',
  });
}

export async function teardown() {
  await served?.stop();
  await rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
}
