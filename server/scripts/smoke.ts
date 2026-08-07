/**
 * End-to-end smoke test against a RUNNING server and the seeded demo shop.
 * Walks the FRD §2.6 happy path with real HTTP:
 *   sign in → enquiry → quotation (priced) → send → won → jobcard → job bag → board → scan → done
 *
 *   npx tsx scripts/smoke.ts
 */
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4000/api';

let token = '';
let failures = 0;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const get = (p: string) => call('GET', p);
const post = (p: string, b?: unknown) => call('POST', p, b ?? {});

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  [32m✓[0m ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  [31m✗[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function step(title: string) {
  console.log(`\n[1m${title}[0m`);
}

const unwrap = <T>(r: { body: unknown }): T => {
  const b = r.body as { data?: unknown };
  return (b && typeof b === 'object' && 'data' in b && !Array.isArray(b.data) ? b.data : b) as T;
};

// ─────────────────────────────────────────────────────────────────────────────

step('Sign in as the shop owner');
const login = await post('/auth/login', { email: 'owner@leoink.test', password: 'leoink123' });
check('POST /auth/login', login.status === 200, `HTTP ${login.status}`);
token = login.body?.token ?? login.body?.data?.token;
if (!token) {
  console.error('No token — is the API running and the database seeded?');
  process.exit(1);
}

const me = unwrap<{ tenant: { tradeName: string; gstin: string; homeStateCode: string }; user: { name: string } }>(
  await get('/auth/me'),
);
check('GET /auth/me', Boolean(me.tenant), `${me.tenant?.tradeName} · GSTIN ${me.tenant?.gstin}`);

step('Masters seeded (FR-108 / FR-110 / FR-116 / FR-216)');
const rates = unwrap<{ data: Array<{ gstPct: string }> }>(await get('/setup/tax-rates'));
check('GST slabs', (rates.data ?? []).length >= 5, `${(rates.data ?? []).length} slabs`);

const materials = unwrap<{ data: Array<{ name: string; sellingRate: string | null; minCharge: string }> }>(
  await get('/materials?pageSize=50'),
);
const star = (materials.data ?? []).find((m) => m.name.includes('Star Flex'))!;
check('Media master', Boolean(star), `${star?.name} @ ₹${star?.sellingRate}/sq.ft, min ₹${star?.minCharge}`);

const noRate = (materials.data ?? []).find((m) => m.sellingRate === null);
check('A media with no rate exists (FR-212)', Boolean(noRate), noRate?.name);

const customers = unwrap<{ data: Array<{ id: string; name: string; placeOfSupplyState: string }> }>(
  await get('/customers?pageSize=50'),
);
const intra = (customers.data ?? []).find((c) => c.placeOfSupplyState === '27')!;
const inter = (customers.data ?? []).find((c) => c.placeOfSupplyState === '29')!;
check('Customers', Boolean(intra && inter), `${intra?.name} (27) · ${inter?.name} (29)`);

const branches = unwrap<{ data: Array<{ id: string; branchCode: string; stateCode: string }> }>(
  await get('/setup/branches'),
);
const branch = (branches.data ?? [])[0];

step('Enquiry → quotation (FR-200 / FR-220)');
const enquiry = unwrap<{ id: string }>(
  await post('/enquiries', {
    source: 'WHATSAPP',
    contactName: 'Deccan Auto — Mr Deshmukh',
    phone: '9822011223',
    customerId: intra.id,
    vertical: 'FLEX_LARGE_FORMAT',
    description: '2 star-flex banners 6×4 ft with eyelets, for the showroom opening',
  }),
);
check('Enquiry logged', Boolean(enquiry.id));

const converted = (await post(`/enquiries/${enquiry.id}/convert-to-quote`, {})).body as {
  quote: { id: string; status: string; quoteNo: string | null };
};
check('Enquiry → draft quotation', converted.quote?.status === 'DRAFT', `quoteNo=${converted.quote?.quoteNo} (none until sent)`);

step('Price the job through the shared engine (FR-211 / FR-215 / FR-223)');
const priced = unwrap<{
  lines: Array<{ areaSqft: string; rate: string; rateSource: string; grossAmount: string; minChargeApplied: boolean }>;
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  roundOff: string;
  grandTotal: string;
  amountInWords: string;
  engineVersion: string;
}>(
  await post('/quotes/price', {
    customerId: intra.id,
    branchId: branch.id,
    placeOfSupplyState: '27',
    lines: [
      {
        lineNo: 1,
        kind: 'AREA',
        materialId: (materials.data ?? []).find((m) => m.name.includes('Star Flex')) ? undefined : undefined,
        heightFt: '4',
        widthFt: '6',
        qty: '2',
        rate: '40',
        gstPct: '18',
        hsnSac: '998912',
        addOnFlat: '60',
        spec: { substrate: 'Star Flex 340 GSM', finishing: ['eyelets'] },
      },
    ],
  }),
);
const line = priced.lines[0];
check('Area = height × width', Number(line.areaSqft) === 24, `${line.areaSqft} sq.ft`);
check('Line gross = area × rate × qty + finishing', line.grossAmount === '1980.00', `₹${line.grossAmount}`);
check('Intra-state → CGST + SGST, no IGST', priced.cgst === priced.sgst && priced.igst === '0.00', `CGST ₹${priced.cgst} · SGST ₹${priced.sgst}`);
check('Round-off recorded separately', priced.roundOff !== undefined, `₹${priced.roundOff}`);
check('Amount in words', priced.amountInWords.startsWith('Rupees'), priced.amountInWords);
check('Engine version stamped', Boolean(priced.engineVersion), `v${priced.engineVersion}`);

step('Save, send and win the quotation (FR-222 / FR-226 / FR-230)');
const quote = unwrap<{ id: string; grandTotal: string; taxableValue: string }>(
  await post('/quotes', {
    customerId: intra.id,
    branchId: branch.id,
    placeOfSupplyState: '27',
    notes: 'Delivery in 3 working days. Artwork approval required before print.',
    lines: [
      {
        lineNo: 1,
        kind: 'AREA',
        heightFt: '4',
        widthFt: '6',
        qty: '2',
        rate: '40',
        gstPct: '18',
        hsnSac: '998912',
        addOnFlat: '60',
        spec: { substrate: 'Star Flex 340 GSM', finishing: ['eyelets'], sides: '1' },
      },
    ],
  }),
);
check('Quotation saved as a draft', Boolean(quote.id), `taxable ₹${quote.taxableValue}, total ₹${quote.grandTotal}`);

const sent = unwrap<{ quoteNo: string; status: string; validUntil: string }>(
  await post(`/quotes/${quote.id}/send`, { channel: 'WHATSAPP' }),
);
check('Sent on WhatsApp → number allocated', sent.status === 'SENT' && /^QUO\//.test(sent.quoteNo), `${sent.quoteNo}, valid to ${sent.validUntil}`);

const doc = unwrap<{ documentTitle: string; declaration: string }>(await get(`/quotes/${quote.id}/document`));
check('Document is a Quotation, not a Tax Invoice (FR-225)', /quotation/i.test(doc.documentTitle), doc.documentTitle);

const won = unwrap<{ status: string }>(await post(`/quotes/${quote.id}/status`, { status: 'WON' }));
check('Marked won', won.status === 'WON');

step('Quote → jobcard, figures carried (FR-233)');
const conv = (await post(`/quotes/${quote.id}/convert-to-jobcard`, {})).body as {
  jobcard: { id: string; jobcardNo: string };
};
check('Jobcard created', /^JC\//.test(conv.jobcard?.jobcardNo ?? ''), conv.jobcard?.jobcardNo);

const bag = unwrap<{
  specs: Array<{ description: string; rate: string; lineTaxable: string; areaSqft: string }>;
  progress: Array<{ stageName: string; status: string; isTerminal: boolean }>;
  qrToken: string;
  overallStatus: string;
}>(await get(`/jobcards/${conv.jobcard.id}/job-bag`));

check('Specs carried from the quote', bag.specs.length === 1, bag.specs[0]?.description);
check('Quoted price carried', bag.specs[0]?.lineTaxable === quote.taxableValue, `₹${bag.specs[0]?.lineTaxable} = quote's ₹${quote.taxableValue}`);
check('Stage workflow initialised', bag.progress.length >= 4, bag.progress.map((p) => p.stageName).join(' → '));
check('QR token issued (FR-305)', bag.qrToken?.length >= 16);

const again = await post(`/quotes/${quote.id}/convert-to-jobcard`, {});
check('Re-conversion blocked (FR-233 AC3)', again.status === 409, `HTTP ${again.status}`);

step('Run it across the floor (FR-307 / FR-308 / FR-312)');
const board = unwrap<{ columns: Array<{ name: string; cards: Array<{ jobcardNo: string }> }> }>(
  await get('/production/board'),
);
check('Kanban board renders', board.columns.length >= 4, board.columns.map((c) => `${c.name}(${c.cards.length})`).join(' '));

const stages = bag.progress.length;
for (let i = 0; i < stages - 1; i++) {
  await post('/production/scan', { token: bag.qrToken, action: 'advance' });
}
const nearlyDone = unwrap<{ overallStatus: string }>(await get(`/jobcards/${conv.jobcard.id}`));
check('Scanning advances the job', nearlyDone.overallStatus === 'IN_PROGRESS', nearlyDone.overallStatus);

await post('/production/scan', { token: bag.qrToken, action: 'advance' });
const done = unwrap<{ overallStatus: string; completedAt: string | null }>(await get(`/jobcards/${conv.jobcard.id}`));
check('Terminal stage completes the job (FR-309)', done.overallStatus === 'DONE' && Boolean(done.completedAt), done.overallStatus);

const events = unwrap<{ data: Array<{ eventType: string; source: string }> }>(
  await get(`/jobcards/${conv.jobcard.id}/events`),
);
const scans = (events.data ?? []).filter((e) => e.source === 'SCAN').length;
check('Every move audited with its source', scans >= stages, `${events.data.length} events, ${scans} from scans`);

step('Inter-state supply flips to IGST (BR-2 / FR-505)');
const igstQuote = unwrap<{ cgst: string; sgst: string; igst: string; isInterstate: boolean }>(
  await post('/quotes/price', {
    customerId: inter.id,
    branchId: branch.id,
    placeOfSupplyState: '29',
    lines: [{ lineNo: 1, kind: 'AREA', heightFt: '4', widthFt: '6', qty: '2', rate: '40', gstPct: '18', hsnSac: '998912' }],
  }),
);
check('Karnataka customer → IGST only', igstQuote.isInterstate && igstQuote.cgst === '0.00' && Number(igstQuote.igst) > 0, `IGST ₹${igstQuote.igst}`);

step('Permissions are enforced server-side (FR-716)');
const salesLogin = await post('/auth/login', { email: 'sales@leoink.test', password: 'leoink123' });
const ownerToken = token;
token = salesLogin.body?.token ?? salesLogin.body?.data?.token;
const denied = await post('/rate-cards', { itemName: 'Sneaky', publishedRate: '1', gstPct: '18' });
check('Sales/Counter cannot edit rate masters', denied.status === 403, `HTTP ${denied.status}`);
token = ownerToken;

console.log(
  failures === 0
    ? `\n[32m[1mHappy path complete — every check passed.[0m\n`
    : `\n[31m[1m${failures} check(s) failed.[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
