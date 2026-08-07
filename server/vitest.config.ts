import { defineConfig } from 'vitest/config';

const TEST_DATABASE_URL =
  'postgresql://postgres:postgres@127.0.0.1:5434/postgres?schema=public&connection_limit=1&pool_timeout=30&pgbouncer=true';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    globalSetup: ['tests/setup/globalSetup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: 'leo-ink-test-secret',
      TRIAL_DAYS: '14',
    },

    /**
     * The test database is a single PostgreSQL backend session (PGlite over the
     * wire protocol). A second worker process would open a second Prisma client
     * onto that same session and the two would collide on prepared statement
     * names — Postgres 42P05. One fork, one client, files run in sequence.
     */
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    sequence: { concurrent: false },
    isolate: false,

    testTimeout: 60_000,
    hookTimeout: 120_000,
    reporters: ['verbose'],
  },
});
