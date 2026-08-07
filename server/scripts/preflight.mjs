/**
 * Fail fast, and say why.
 *
 * Without this, a missing DATABASE_URL surfaces as Prisma's `P1012 … get-config
 * wasm` validation dump, which tells a deploying user nothing about what to do.
 * Runs before `prisma migrate deploy` in the start script.
 *
 * Plain .mjs on purpose: it must run before anything is compiled, and without
 * depending on tsx being present in a production install.
 */
const REQUIRED = [
  {
    key: 'DATABASE_URL',
    why: 'PostgreSQL connection string',
    hint:
      'Render → leo-ink-api → Environment → Add Environment Variable.\n' +
      '      Get the value from your database provider, e.g. Neon → Connect →\n' +
      '      turn OFF "Connection pooling" → Copy snippet.\n' +
      '      It should look like: postgresql://user:pass@host/dbname?sslmode=require',
  },
  {
    key: 'JWT_SECRET',
    why: 'signs session tokens',
    hint: 'Render → Environment → add JWT_SECRET and click Generate.',
  },
];

const OPTIONAL = [
  { key: 'CORS_ORIGIN', why: 'the web app origin allowed to call this API', fallback: 'http://localhost:5173' },
  { key: 'TRIAL_DAYS', why: 'free-trial length (FR-723)', fallback: '14' },
];

const missing = REQUIRED.filter(({ key }) => !process.env[key]?.trim());

if (missing.length > 0) {
  const lines = [
    '',
    '─'.repeat(74),
    ' Leo Ink cannot start — required configuration is missing',
    '─'.repeat(74),
    '',
  ];

  for (const { key, why, hint } of missing) {
    lines.push(`  ✗ ${key}  (${why})`);
    lines.push(`      ${hint}`);
    lines.push('');
  }

  lines.push(' Set it, save, and the service will redeploy automatically.');
  lines.push('─'.repeat(74));
  lines.push('');

  process.stderr.write(lines.join('\n'));
  process.exit(1);
}

// Nudge, don't block: these have sane fallbacks but are usually wrong in production.
for (const { key, why, fallback } of OPTIONAL) {
  if (!process.env[key]?.trim()) {
    process.stdout.write(`[leo-ink] ${key} not set (${why}) — falling back to "${fallback}"\n`);
  }
}

process.stdout.write('[leo-ink] configuration OK — applying migrations\n');
