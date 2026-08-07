/**
 * One-shot demo seeding for a deployed environment.
 *
 * Render's free tier has no Shell, so `npm run seed` cannot be run against a
 * hosted database by hand. This runs as part of the start command instead, but
 * only under two conditions, both required:
 *
 *   1. SEED_DEMO=true  — an explicit opt-in, so a real tenant's database is
 *      never populated with demo records by accident.
 *   2. the database holds no tenants — so a restart, redeploy or crash-loop
 *      cannot wipe or duplicate anything that already exists.
 *
 * Once a tenant exists this becomes a no-op, and SEED_DEMO can be removed.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.SEED_DEMO !== 'true') {
  process.stdout.write('[leo-ink] SEED_DEMO not set — skipping demo data\n');
  process.exit(0);
}

const prisma = new PrismaClient();

let tenants;
try {
  tenants = await prisma.tenant.count();
} catch (err) {
  process.stderr.write(`[leo-ink] could not check for existing tenants: ${err.message}\n`);
  await prisma.$disconnect();
  // Never block startup over the demo seed — the API itself is still fine.
  process.exit(0);
}
await prisma.$disconnect();

if (tenants > 0) {
  process.stdout.write(
    `[leo-ink] ${tenants} tenant(s) already present — skipping demo data.\n` +
      '[leo-ink] You can remove SEED_DEMO from the environment now.\n',
  );
  process.exit(0);
}

process.stdout.write('[leo-ink] database is empty — seeding the demo shop\n');
try {
  execFileSync('node', ['dist/prisma/seed.js'], { cwd: serverDir, stdio: 'inherit' });
} catch {
  process.stderr.write('[leo-ink] demo seed failed — starting the API anyway\n');
}
process.exit(0);
