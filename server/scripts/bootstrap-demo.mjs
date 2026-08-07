/**
 * Build the demo shop against a RUNNING Leo Ink API, over HTTP.
 *
 * `prisma/seed.ts` needs a direct database connection, which a hosted database
 * often will not give you (Render's free tier has no Shell, and putting the
 * production credential on a laptop to run a seed is worse than not seeding).
 * This uses the product's own public sign-up (FR-723) and its normal REST
 * endpoints instead, so it works from anywhere that can reach the API.
 *
 *   node scripts/bootstrap-demo.mjs https://leo-ink-api.onrender.com
 *
 * Idempotent: if the owner already exists it signs in and tops up whatever
 * masters are missing, rather than failing or duplicating.
 */
const BASE = (process.argv[2] ?? 'http://localhost:4000').replace(/\/+$/, '') + '/api';

const OWNER = { email: 'owner@leoink.test', password: 'leoink123' };
const MAHARASHTRA = '27';
const KARNATAKA = '29';
const GUJARAT = '24';

// ── GSTIN check digit (BR-6), inlined so this file has no imports ────────────
const CODEPOINTS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstin(stateCode, pan, entity = '1') {
  const base = `${stateCode}${pan}${entity}Z`;
  const mod = CODEPOINTS.length;
  let factor = 2;
  let sum = 0;
  for (let i = base.length - 1; i >= 0; i--) {
    let digit = factor * CODEPOINTS.indexOf(base[i]);
    factor = factor === 2 ? 1 : 2;
    digit = Math.floor(digit / mod) + (digit % mod);
    sum += digit;
  }
  return base + CODEPOINTS[(mod - (sum % mod)) % mod];
}

let token = '';
let created = 0;
let skipped = 0;

async function call(method, path, body, { quiet = false } = {}) {
  // Render's free tier sleeps; the first request can take ~50s to wake it.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;
      if (!res.ok && !quiet) {
        return { ok: false, status: res.status, body: parsed };
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      if (attempt === 3) throw err;
      process.stdout.write(`    (retry ${attempt}: ${err.message})\n`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

const ok = (label, detail = '') => {
  created++;
  console.log(`  \x1b[32m+\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
};
let failed = 0;

/**
 * A duplicate is fine — this script is meant to be re-runnable. Anything else is
 * a real failure and must be shown, not swallowed as "already there".
 */
const already = (label, res) => {
  const code = res?.body?.error?.code;
  const duplicate = !res || code === 'DUPLICATE' || code === 'DUPLICATE_NAME' || code === 'CONFLICT' || res.status === 409;
  if (duplicate) {
    skipped++;
    console.log(`  \x1b[90m·\x1b[0m ${label} — already there`);
    return;
  }
  failed++;
  const detail = res.body?.error?.fields
    ? res.body.error.fields.map((f) => `${f.field}: ${f.message}`).join('; ')
    : (res.body?.error?.message ?? JSON.stringify(res.body));
  console.log(`  \x1b[31m✗\x1b[0m ${label} — HTTP ${res.status}: ${detail}`);
};

// ── 1. Sign up, or sign in if the shop already exists ────────────────────────

console.log(`\n\x1b[1mLeo Ink demo shop → ${BASE}\x1b[0m\n`);
console.log('Waking the API (free tier can take ~50s)…');

const health = await call('GET', '/health');
if (!health.ok) throw new Error(`API not reachable: HTTP ${health.status}`);
console.log('  API is up\n');

const TENANT_GSTIN = gstin(MAHARASHTRA, 'AABCS1429B');

console.log('Shop & owner');
let reg = await call('POST', '/auth/register', {
  legalName: 'Shree Ganesh Printers',
  tradeName: 'Shree Ganesh Flex & Digital',
  ownerName: 'Ganesh Kulkarni',
  email: OWNER.email,
  password: OWNER.password,
  phone: '9822011200',
  gstin: TENANT_GSTIN,
});

if (reg.ok) {
  token = reg.body.token ?? reg.body.data?.token;
  ok('registered Shree Ganesh Flex & Digital', OWNER.email);
} else {
  const login = await call('POST', '/auth/login', OWNER);
  if (!login.ok) {
    console.error(`\n  Could not register or sign in: ${JSON.stringify(reg.body ?? login.body)}\n`);
    process.exit(1);
  }
  token = login.body.token ?? login.body.data?.token;
  already('shop exists, signed in');
}

// ── 2. Firm identity, so place-of-supply resolution has a home state ─────────

const firm = await call('PUT', '/setup/firm', {
  legalName: 'Shree Ganesh Printers',
  tradeName: 'Shree Ganesh Flex & Digital',
  gstin: TENANT_GSTIN,
  addressLine1: 'Shop 14, Laxmi Complex, Shivajinagar',
  city: 'Pune',
  pincode: '411005',
  phone: '02025512345',
  email: 'accounts@shreeganeshprinters.in',
});
firm.ok ? ok('firm profile', `GSTIN ${TENANT_GSTIN}`) : already('firm profile', firm);

// ── 3. Branch ────────────────────────────────────────────────────────────────

console.log('\nBranch');
const branches = await call('GET', '/setup/branches');
let branch = (branches.body?.data ?? [])[0];
if (!branch) {
  const made = await call('POST', '/setup/branches', {
    branchCode: 'HO',
    name: 'Shivajinagar (Head Office)',
    gstin: TENANT_GSTIN,
    stateCode: MAHARASHTRA,
    city: 'Pune',
    pincode: '411005',
    isHeadOffice: true,
  });
  branch = made.body;
  made.ok ? ok('HO — Shivajinagar') : console.log(`  ! branch: ${JSON.stringify(made.body)}`);
} else {
  already(`${branch.branchCode} — ${branch.name}`);
}

// ── 4. Bank ──────────────────────────────────────────────────────────────────

const bank = await call('POST', '/setup/bank-accounts', {
  accountName: 'Shree Ganesh Printers',
  accountNo: '50100234567890',
  ifsc: 'HDFC0000123',
  bankName: 'HDFC Bank',
  branchName: 'Shivajinagar, Pune',
  upiVpa: 'shreeganesh@hdfcbank',
  isDefault: true,
});
bank.ok ? ok('bank account + UPI') : already('bank account', bank);

// ── 5. HSN / SAC ─────────────────────────────────────────────────────────────

console.log('\nHSN / SAC codes');
const hsnWanted = [
  { code: '998912', type: 'SAC', description: 'Printing and reproduction services' },
  { code: '4911', type: 'HSN', description: 'Other printed matter' },
];
const hsnIds = {};
for (const h of hsnWanted) {
  const made = await call('POST', '/setup/hsn-codes', h, { quiet: true });
  if (made.ok) {
    hsnIds[h.code] = made.body.id;
    ok(`${h.code} (${h.type})`, h.description);
  } else {
    const list = await call('GET', '/setup/hsn-codes');
    const found = (list.body?.data ?? []).find((x) => x.code === h.code);
    if (found) {
      hsnIds[h.code] = found.id;
      already(h.code);
    }
  }
}

// ── 6. UOMs are pre-seeded at sign-up; find the ones we price against ────────

const uoms = await call('GET', '/setup/uoms');
const uomId = (code) => (uoms.body?.data ?? []).find((u) => u.uomCode === code)?.id;
const SQFT = uomId('SQFT');
const NOS = uomId('NOS');
const SHEET = uomId('SHEET');

// ── 7. Media & materials — the price source for every flex estimate ──────────

console.log('\nMedia & materials');
const materials = [
  { itemCode: 'FLX-STAR', name: 'Star Flex 340 GSM', category: 'MEDIA', rollWidthFt: '10', uomId: SQFT, hsnSacId: hsnIds['998912'], costRate: '11', sellingRate: '18', minCharge: '250', gstPct: '18' },
  { itemCode: 'FLX-BACKLIT', name: 'Backlit Flex 510 GSM', category: 'MEDIA', rollWidthFt: '8', uomId: SQFT, hsnSacId: hsnIds['998912'], costRate: '19', sellingRate: '32', minCharge: '350', gstPct: '18' },
  { itemCode: 'VNL-GLOSS', name: 'Vinyl Gloss (self-adhesive)', category: 'MEDIA', rollWidthFt: '5', uomId: SQFT, hsnSacId: hsnIds['998912'], costRate: '22', sellingRate: '38', minCharge: '300', gstPct: '18' },
  { itemCode: 'VNL-OWV', name: 'One Way Vision', category: 'MEDIA', rollWidthFt: '4.5', uomId: SQFT, hsnSacId: hsnIds['998912'], costRate: '28', sellingRate: '48', minCharge: '400', gstPct: '18' },
  { itemCode: 'CNV-MATT', name: 'Canvas Matte', category: 'MEDIA', rollWidthFt: '4', uomId: SQFT, hsnSacId: hsnIds['998912'], costRate: '45', sellingRate: '75', minCharge: '500', gstPct: '18' },
  { itemCode: 'FAB-CLOTH', name: 'Cloth Banner Fabric', category: 'MEDIA', rollWidthFt: '6', uomId: SQFT, hsnSacId: hsnIds['998912'], costRate: '26', sellingRate: '44', minCharge: '350', gstPct: '18' },
  { itemCode: 'PPR-ART-300', name: 'Art Card 300 GSM (20x30 in)', category: 'PAPER', gsm: 300, size: '20x30 in', uomId: SHEET, hsnSacId: hsnIds['4911'], costRate: '9.5', sellingRate: '15', gstPct: '12' },
  // Deliberately rate-less, so FR-212's "cannot be auto-priced" path is visible.
  { itemCode: 'VNL-REFLECT', name: 'Reflective Vinyl (rate pending)', category: 'MEDIA', rollWidthFt: '4', uomId: SQFT, hsnSacId: hsnIds['998912'], gstPct: '18' },
];
for (const m of materials) {
  const made = await call('POST', '/materials', m, { quiet: true });
  made.ok
    ? ok(m.name, m.sellingRate ? `Rs ${m.sellingRate}/${m.category === 'PAPER' ? 'sheet' : 'sq.ft'}` : 'no rate set')
    : already(m.name, made);
}

// ── 8. Published price list ──────────────────────────────────────────────────

console.log('\nRate cards');
const rateCards = [
  { itemName: 'Flex Banner Printing (Star Flex)', uomId: SQFT, publishedRate: '18', hsnSac: '998912', gstPct: '18', minCharge: '250' },
  { itemName: 'Backlit Board Printing', uomId: SQFT, publishedRate: '32', hsnSac: '998912', gstPct: '18', minCharge: '350' },
  { itemName: 'Visiting Cards (per 100)', uomId: NOS, publishedRate: '250', hsnSac: '4911', gstPct: '12', minCharge: '250' },
  { itemName: 'A4 Colour Print (single side)', uomId: NOS, publishedRate: '10', hsnSac: '998912', gstPct: '18', minCharge: '0' },
  { itemName: 'Lamination - Gloss', uomId: SQFT, publishedRate: '6', hsnSac: '998912', gstPct: '18', minCharge: '0' },
  { itemName: 'Eyelet fitting', uomId: NOS, publishedRate: '5', hsnSac: '998912', gstPct: '18', minCharge: '0' },
];
for (const rc of rateCards) {
  const made = await call('POST', '/rate-cards', rc, { quiet: true });
  made.ok ? ok(rc.itemName, `Rs ${rc.publishedRate}`) : already(rc.itemName, made);
}

// ── 9. Customers — intra-state, inter-state and unregistered ─────────────────

console.log('\nCustomers');
const customers = [
  { name: 'Deccan Auto Spares Pvt Ltd', customerType: 'REGISTERED', gstin: gstin(MAHARASHTRA, 'AACCD5678K'), placeOfSupplyState: MAHARASHTRA, billingCity: 'Pune', phone: '9822011223', email: 'purchase@deccanauto.in', creditDays: 30, creditLimit: '200000', openingBalance: '48500' },
  { name: 'Bengaluru Events LLP', customerType: 'REGISTERED', gstin: gstin(KARNATAKA, 'AAEFB9012M'), placeOfSupplyState: KARNATAKA, billingCity: 'Bengaluru', phone: '9845566778', email: 'ops@bengalurevents.in', creditDays: 15, creditLimit: '150000' },
  { name: 'Surat Textiles Trading Co', customerType: 'REGISTERED', gstin: gstin(GUJARAT, 'AAGCS3456P'), placeOfSupplyState: GUJARAT, billingCity: 'Surat', phone: '9825566778', email: 'admin@surattextiles.in', creditDays: 45 },
  { name: 'Rakesh Sweets (Walk-in)', customerType: 'UNREGISTERED', placeOfSupplyState: MAHARASHTRA, billingCity: 'Pune', phone: '9011223344' },
];
for (const c of customers) {
  const made = await call('POST', '/customers', c, { quiet: true });
  made.ok ? ok(c.name, c.gstin ?? 'unregistered') : already(c.name, made);
}

// ── 10. One user per Phase-1 role, so the §2.3 matrix is demonstrable ────────

console.log('\nTeam');
const team = [
  { name: 'Sneha Patil', email: 'accounts@leoink.test', role: 'ACCOUNTS' },
  { name: 'Amit Jadhav', email: 'sales@leoink.test', role: 'SALES_COUNTER' },
  { name: 'Vikram Shinde', email: 'production@leoink.test', role: 'PRODUCTION_MANAGER' },
  { name: 'Ravi Pawar', email: 'operator@leoink.test', role: 'OPERATOR' },
  { name: 'Sanjay More', email: 'delivery@leoink.test', role: 'DELIVERY' },
];
for (const u of team) {
  const made = await call('POST', '/setup/users', { ...u, password: OWNER.password }, { quiet: true });
  if (made.ok) ok(`${u.name} (${u.role})`, u.email);
  else if (made.body?.error?.code === 'PLAN_LIMIT') {
    console.log(`  \x1b[33m·\x1b[0m ${u.role} skipped — free plan seat limit reached (FR-725 working as designed)`);
    skipped++;
  } else already(u.name, made);
}

// ── 11. Mark the shop go-live ready ──────────────────────────────────────────

const live = await call('PUT', '/setup/wizard', { complete: true });
console.log('');
live.ok ? ok('shop marked go-live ready') : console.log(`  · go-live: ${JSON.stringify(live.body?.error?.details ?? live.body)}`);

// ── Done ─────────────────────────────────────────────────────────────────────

const check = await call('POST', '/auth/login', OWNER);
console.log('\n' + '─'.repeat(62));
if (check.ok) {
  console.log(` \x1b[32m\x1b[1mReady.\x1b[0m  ${created} created, ${skipped} already present.`);
  console.log('');
  console.log(`   Sign in at your web app with:`);
  console.log(`     ${OWNER.email}  /  ${OWNER.password}`);
  console.log('');
  console.log('   Other roles (same password):');
  for (const u of team) console.log(`     ${u.email.padEnd(26)} ${u.role}`);
} else {
  console.log(' Setup ran, but the owner cannot sign in. Check the API logs.');
}
console.log('─'.repeat(62) + '\n');
