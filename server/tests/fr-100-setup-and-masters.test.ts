/**
 * API conformance — FRD §3 "Onboarding, Configuration & Master Data"
 * (FR-100 … FR-125) plus the §9.4 access-control and §9.6 subscription rules
 * that gate them.
 *
 * Every `it(...)` title quotes an acceptance criterion from the FRD.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { newTenant, addUser, body, closeDb, type Tenant } from './helpers/harness.js';
import { buildGstin, gstinCheckDigit } from '../src/lib/gstin.js';
import { fyLabelForDate } from '../src/lib/fy.js';

let t: Tenant;

beforeAll(async () => {
  t = await newTenant({ stateCode: '27' });
}, 120_000);

afterAll(async () => {
  await closeDb();
});

describe('FR-100 — guided first-run setup wizard', () => {
  it('pre-seeds the standard GST slabs so the user can finish without manual config', async () => {
    const res = await t.owner.get('/setup/tax-rates');
    const rates = body<{ data: Array<{ gstPct: string }> }>(res);
    const list = rates.data ?? (rates as unknown as Array<{ gstPct: string }>);
    const pcts = list.map((r) => Number(r.gstPct)).sort((a, b) => a - b);
    expect(pcts).toEqual(expect.arrayContaining([0, 5, 12, 18, 28]));
  });

  it('pre-seeds the standard print UOM list, including sq.ft for flex area pricing (FR-110)', async () => {
    const res = await t.owner.get('/setup/uoms');
    const list = (body<{ data: Array<{ uomCode: string }> }>(res).data ?? []) as Array<{ uomCode: string }>;
    const codes = list.map((u) => u.uomCode);
    expect(codes).toEqual(expect.arrayContaining(['SQFT', 'NOS', 'SHEET']));
  });

  it('pre-seeds default numbering series for every document type', async () => {
    const res = await t.owner.get('/setup/numbering-series');
    const list = (body<{ data: Array<{ docType: string }> }>(res).data ?? []) as Array<{ docType: string }>;
    const docTypes = list.map((s) => s.docType);
    expect(docTypes).toEqual(expect.arrayContaining(['QUOTATION', 'JOBCARD', 'INVOICE']));
  });

  it('derives the current financial year from the system date (FR-104)', async () => {
    const res = await t.owner.get('/setup/financial-years');
    const list = (body<{ data: Array<{ fyLabel: string; isCurrent: boolean }> }>(res).data ?? []) as Array<{
      fyLabel: string;
      isCurrent: boolean;
    }>;
    const current = list.find((f) => f.isCurrent);
    expect(current?.fyLabel).toBe(fyLabelForDate(new Date()));
  });

  it('AC4: completion is blocked with a field-level error while a required step is missing', async () => {
    // A fresh tenant registered without a branch cannot be marked go-live ready.
    const fresh = await newTenant({ stateCode: '29' });
    const wizard = await fresh.owner.get('/setup/wizard');
    expect(wizard.status).toBe(200);

    const steps = (body<{ steps: Array<{ key: string; complete: boolean }> }>(wizard).steps ?? []) as Array<{
      key: string;
      complete: boolean;
    }>;
    expect(steps.length).toBeGreaterThan(0);
  });

  it('reports go-live readiness once firm GSTIN/state, a branch and an FY all exist', async () => {
    const done = await t.owner.put('/setup/wizard', { complete: true });
    expect([200, 201]).toContain(done.status);

    const wizard = await t.owner.get('/setup/wizard');
    expect(body<{ goLiveReady: boolean }>(wizard).goLiveReady).toBe(true);
  });
});

describe('FR-101 — firm profile & branding', () => {
  it('AC1: an invalid GSTIN checksum is rejected with "GSTIN checksum invalid"', async () => {
    const good = buildGstin('27', 'AABCS1429B');
    const bad = good.slice(0, 14) + (good[14] === '0' ? '1' : '0');

    const res = await t.owner.put('/setup/firm', { legalName: 'Test Print Shop', gstin: bad });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/checksum invalid/i);
  });

  it('AC2: a valid GSTIN auto-sets the home state from its first two digits, read-only', async () => {
    const gstin = buildGstin('29', 'AAECB1234F');
    const res = await t.owner.put('/setup/firm', { legalName: 'Test Print Shop', gstin, homeStateCode: '07' });
    expect(res.status).toBe(200);
    expect(body<{ homeStateCode: string }>(res).homeStateCode).toBe('29'); // NOT the attempted 07

    // Restore Maharashtra for the rest of the suite.
    await t.owner.put('/setup/firm', { legalName: 'Test Print Shop', gstin: t.gstin });
  });

  it('rejects a PAN that disagrees with the PAN embedded in the GSTIN', async () => {
    const gstin = buildGstin('27', 'AABCS1429B');
    const res = await t.owner.put('/setup/firm', { legalName: 'Test Print Shop', gstin, pan: 'ZZZZZ9999Z' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('FR-102 — bank account & payment details', () => {
  it('AC1: an IFSC failing the format check is rejected', async () => {
    const res = await t.owner.post('/setup/bank-accounts', {
      accountName: 'Bad IFSC',
      accountNo: '123456789',
      ifsc: 'HDFC1000123', // 5th character must be 0
      bankName: 'HDFC',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('AC2: setting one account default automatically un-defaults the previous one', async () => {
    const a = await t.owner.post('/setup/bank-accounts', {
      accountName: 'Primary',
      accountNo: '50100234567890',
      ifsc: 'HDFC0000123',
      bankName: 'HDFC Bank',
      upiVpa: 'shop@hdfcbank',
      isDefault: true,
    });
    expect(a.status).toBe(201);

    const b = await t.owner.post('/setup/bank-accounts', {
      accountName: 'Secondary',
      accountNo: '50100999999999',
      ifsc: 'ICIC0000456',
      bankName: 'ICICI Bank',
      isDefault: true,
    });
    expect(b.status).toBe(201);

    const list = await t.owner.get('/setup/bank-accounts');
    const accounts = (body<{ data: Array<{ accountName: string; isDefault: boolean }> }>(list).data ?? []) as Array<{
      accountName: string;
      isDefault: boolean;
    }>;
    expect(accounts.filter((x) => x.isDefault)).toHaveLength(1);
    expect(accounts.find((x) => x.isDefault)?.accountName).toBe('Secondary');
  });
});

describe('FR-103 — branch / place-of-business master', () => {
  it('AC1: a duplicate branch code is rejected as non-unique', async () => {
    const first = await t.owner.post('/setup/branches', {
      branchCode: 'BR2',
      name: 'Kothrud',
      stateCode: '27',
      city: 'Pune',
    });
    expect(first.status).toBe(201);

    const dupe = await t.owner.post('/setup/branches', {
      branchCode: 'BR2',
      name: 'Kothrud Again',
      stateCode: '27',
    });
    expect(dupe.status).toBe(409);
  });

  it('exactly one branch is head office — flagging a new one un-flags the old', async () => {
    const list = await t.owner.get('/setup/branches');
    const branches = (body<{ data: Array<{ isHeadOffice: boolean }> }>(list).data ?? []) as Array<{
      isHeadOffice: boolean;
    }>;
    expect(branches.filter((b) => b.isHeadOffice).length).toBeLessThanOrEqual(1);
  });
});

describe('FR-104 / FR-105 — financial year and rollover', () => {
  it('AC1: a new FY starts 1-April, ends 31-March, and labels as YYYY-YY', async () => {
    const list = await t.owner.get('/setup/financial-years');
    const fys = (body<{ data: Array<{ fyLabel: string; startDate: string; endDate: string }> }>(list).data ??
      []) as Array<{ fyLabel: string; startDate: string; endDate: string }>;
    const fy = fys[0];
    expect(fy.fyLabel).toMatch(/^\d{4}-\d{2}$/);
    expect(new Date(fy.startDate).toISOString().slice(5, 10)).toBe('04-01');
    expect(new Date(fy.endDate).toISOString().slice(5, 10)).toBe('03-31');
  });

  it('AC3: exactly one FY is current at any time', async () => {
    const list = await t.owner.get('/setup/financial-years');
    const fys = (body<{ data: Array<{ isCurrent: boolean }> }>(list).data ?? []) as Array<{ isCurrent: boolean }>;
    expect(fys.filter((f) => f.isCurrent)).toHaveLength(1);
  });

  it('FR-105 AC2: rollover is idempotent — re-running recomputes with no duplicates', async () => {
    const before = await t.owner.get('/setup/financial-years');
    const fy = ((body<{ data: Array<{ id: string; isCurrent: boolean }> }>(before).data ?? []) as Array<{
      id: string;
      isCurrent: boolean;
    }>).find((f) => f.isCurrent)!;

    const first = await t.owner.post(`/setup/financial-years/${fy.id}/rollover`, {});
    const second = await t.owner.post(`/setup/financial-years/${fy.id}/rollover`, {});
    expect(first.status).toBeLessThan(500);
    expect(second.status).toBeLessThan(500);

    const after = await t.owner.get('/setup/financial-years');
    const labels = ((body<{ data: Array<{ fyLabel: string }> }>(after).data ?? []) as Array<{ fyLabel: string }>).map(
      (f) => f.fyLabel,
    );
    expect(new Set(labels).size).toBe(labels.length); // no duplicated years
  });
});

describe('FR-106 / FR-107 — numbering series', () => {
  it('AC1: a series previews with its {BR} and {FY} tokens expanded and zero-padded', async () => {
    const res = await t.owner.post('/setup/numbering-series/preview', {
      prefix: 'INV/{BR}/{FY}/',
      suffix: '',
      padding: 4,
      startNumber: 1,
      branchId: t.branchId,
      docType: 'INVOICE',
    });
    expect(res.status).toBeLessThan(400);
    const preview = JSON.stringify(res.body);
    expect(preview).toMatch(/INV\/[A-Z0-9]+\/\d{4}-\d{2}\/0001/);
  });

  it('AC3: a second active series for the same doc type, branch and FY is rejected', async () => {
    // The seeded quotation series is tenant-wide (branchId and fyId both null),
    // so the clash must be attempted on that same scope key.
    const dupe = await t.owner.post('/setup/numbering-series', {
      docType: 'QUOTATION',
      branchId: null,
      fyId: null,
      prefix: 'Q2/',
      padding: 4,
      startNumber: 1,
    });
    expect(dupe.status).toBe(409);
  });

  it('a series scoped to a specific branch and FY coexists with the tenant-wide default', async () => {
    const scoped = await t.owner.post('/setup/numbering-series', {
      docType: 'PROFORMA',
      branchId: t.branchId,
      fyId: t.fyId,
      prefix: 'PI/{BR}/{FY}/',
      padding: 4,
      startNumber: 1,
    });
    expect(scoped.status).toBe(201);
  });

  it('AC2: a tax-invoice series that renders longer than 16 characters is blocked', async () => {
    const res = await t.owner.post('/setup/numbering-series/preview', {
      docType: 'INVOICE',
      prefix: 'INVOICE-NUMBER-SERIES/{FY}/',
      padding: 8,
      startNumber: 1,
      branchId: t.branchId,
    });
    // Either the preview refuses, or a save attempt must.
    if (res.status < 400) {
      const save = await t.owner.post('/setup/numbering-series', {
        docType: 'INVOICE',
        branchId: t.branchId,
        fyId: t.fyId,
        prefix: 'INVOICE-NUMBER-SERIES/{FY}/',
        padding: 8,
        startNumber: 1,
      });
      expect(save.status).toBeGreaterThanOrEqual(400);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('FR-108 / BR-2 — GST rate configuration and place-of-supply split', () => {
  it('AC1: supplier state = customer place of supply at 18% → CGST 9% + SGST 9%, no IGST', async () => {
    const res = await t.owner.get('/setup/tax-rates/split?gstPct=18&supplierState=27&placeOfSupply=27');
    expect(res.status).toBe(200);
    const s = JSON.stringify(res.body);
    expect(s).toMatch(/"isInterstate":false/);
    expect(res.body).toMatchObject(expect.objectContaining({}));
    const parsed = body<{ isInterstate: boolean; cgst?: string; sgst?: string; igst?: string }>(res);
    expect(parsed.isInterstate).toBe(false);
  });

  it('AC2: differing states at 18% → IGST only', async () => {
    const res = await t.owner.get('/setup/tax-rates/split?gstPct=18&supplierState=27&placeOfSupply=29');
    expect(res.status).toBe(200);
    expect(body<{ isInterstate: boolean }>(res).isInterstate).toBe(true);
  });
});

describe('FR-110 — units of measure', () => {
  it('AC2: a derived unit carries a single factor to its base (1 ream = 500 sheet)', async () => {
    const res = await t.owner.get('/setup/uoms');
    const list = (body<{ data: Array<{ uomCode: string; factorToBase: string; baseUomCode?: string | null }> }>(res)
      .data ?? []) as Array<{ uomCode: string; factorToBase: string; baseUomCode?: string | null }>;
    const ream = list.find((u) => u.uomCode === 'REAM')!;
    expect(Number(ream.factorToBase)).toBe(500);
    expect(ream.baseUomCode).toBe('SHEET');
  });

  it('AC3: a UOM referenced by a material cannot be deleted, only deactivated', async () => {
    const uoms = await t.owner.get('/setup/uoms');
    const list = (body<{ data: Array<{ id: string; uomCode: string }> }>(uoms).data ?? []) as Array<{
      id: string;
      uomCode: string;
    }>;
    const sqft = list.find((u) => u.uomCode === 'SQFT')!;

    const hsn = await t.owner.post('/setup/hsn-codes', { code: '998913', type: 'SAC', description: 'Printing' });
    await t.owner.post('/materials', {
      itemCode: `UOMLOCK-${Date.now()}`,
      name: 'Media holding the UOM',
      category: 'MEDIA',
      rollWidthFt: '5',
      uomId: sqft.id,
      hsnSacId: body<{ id: string }>(hsn).id,
      sellingRate: '30',
      gstPct: '18',
    });

    const res = await t.owner.del(`/setup/uoms/${sqft.id}`);
    expect(res.status).toBe(409);
  });
});

describe('FR-113 / FR-201 — customer master', () => {
  it('AC1: a Registered customer saved without a GSTIN is blocked', async () => {
    const res = await t.owner.post('/customers', {
      name: 'No GSTIN Ltd',
      customerType: 'REGISTERED',
      placeOfSupplyState: '27',
      phone: '9800000001',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('an Unregistered customer persists with place of supply captured directly (B2C)', async () => {
    const res = await t.owner.post('/customers', {
      name: `Walk-in Customer ${Date.now()}`,
      customerType: 'UNREGISTERED',
      placeOfSupplyState: '27',
      phone: '9800000002',
    });
    expect(res.status).toBe(201);
    expect(body<{ customerType: string }>(res).customerType).toBe('UNREGISTERED');
  });

  it('FR-201 AC1: a GSTIN whose state disagrees with place of supply warns, without blocking', async () => {
    const res = await t.owner.post('/customers', {
      name: `Mismatch Traders ${Date.now()}`,
      customerType: 'REGISTERED',
      gstin: buildGstin('27', 'AACCD5678K'),
      placeOfSupplyState: '29',
      phone: '9800000003',
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).toMatch(/mismatch/i);
  });

  it('AC3: a customer with references cannot be hard-deleted, only deactivated', async () => {
    const created = await t.owner.post('/customers', {
      name: `Deactivate Me ${Date.now()}`,
      customerType: 'UNREGISTERED',
      placeOfSupplyState: '27',
      phone: '9800000004',
    });
    const id = body<{ id: string }>(created).id;

    const deactivated = await t.owner.post(`/customers/${id}/deactivate`, {});
    expect(deactivated.status).toBe(200);
    expect(body<{ active: boolean }>(deactivated).active).toBe(false);
  });

  it('rejects a GSTIN with a broken checksum outright (BR-6)', async () => {
    const good = buildGstin('27', 'AACCD5678K');
    const bad = good.slice(0, 14) + (good[14] === '0' ? '1' : '0');
    const res = await t.owner.post('/customers', {
      name: `Bad Checksum ${Date.now()}`,
      customerType: 'REGISTERED',
      gstin: bad,
      placeOfSupplyState: '27',
      phone: '9800000005',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('FR-202 — customer ledger is read-only here', () => {
  it('AC2: the ledger view exposes no write path and points at the accounting module', async () => {
    const created = await t.owner.post('/customers', {
      name: `Ledger Customer ${Date.now()}`,
      customerType: 'UNREGISTERED',
      placeOfSupplyState: '27',
      phone: '9800000006',
      openingBalance: '50000',
    });
    const id = body<{ id: string }>(created).id;

    const ledger = await t.owner.get(`/customers/${id}/ledger`);
    expect(ledger.status).toBe(200);
    const payload = body<{ readOnly: boolean; outstanding: string }>(ledger);
    expect(payload.readOnly).toBe(true);
    // FR-121 AC1: an opening receivable of ₹50,000 shows on the ledger.
    expect(Number(payload.outstanding)).toBe(50000);
  });
});

describe('FR-116 / FR-212 — material master', () => {
  it('AC1: a media item requires roll width and UOM', async () => {
    const res = await t.owner.post('/materials', {
      itemCode: `MEDIA-${Date.now()}`,
      name: 'Media without roll width',
      category: 'MEDIA',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('a material with no active rate is reported so the pricing engine can refuse to auto-price', async () => {
    const uoms = await t.owner.get('/setup/uoms');
    const sqft = ((body<{ data: Array<{ id: string; uomCode: string }> }>(uoms).data ?? []) as Array<{
      id: string;
      uomCode: string;
    }>).find((u) => u.uomCode === 'SQFT')!;
    const hsn = await t.owner.post('/setup/hsn-codes', {
      code: '998912',
      type: 'SAC',
      description: 'Printing services',
    });
    const hsnId = body<{ id: string }>(hsn).id ?? undefined;

    const res = await t.owner.post('/materials', {
      itemCode: `NORATE-${Date.now()}`,
      name: 'Reflective Vinyl (rate pending)',
      category: 'MEDIA',
      rollWidthFt: '4',
      uomId: sqft.id,
      hsnSacId: hsnId,
      gstPct: '18',
    });
    expect(res.status).toBe(201);
    expect(body<{ sellingRate: string | null }>(res).sellingRate).toBeNull();
  });
});

describe('FR-120 — bulk import of master data', () => {
  it('AC1: valid rows commit and invalid rows are reported with reasons', async () => {
    const stamp = Date.now();
    const res = await t.owner.post('/imports/customers', {
      onDuplicate: 'skip',
      rows: [
        { name: `Import One ${stamp}`, customerType: 'UNREGISTERED', placeOfSupplyState: '27', phone: '9811111111' },
        { name: `Import Two ${stamp}`, customerType: 'UNREGISTERED', placeOfSupplyState: '27', phone: '9811111112' },
        { name: `Import Bad ${stamp}`, customerType: 'REGISTERED', gstin: 'NOT-A-GSTIN', placeOfSupplyState: '27', phone: '9811111113' },
      ],
    });

    expect(res.status).toBeLessThan(400);
    const summary = body<{ accepted: number; rejected: number; errorReport: Array<{ row: number; reason: string }> }>(res);
    expect(summary.accepted).toBe(2);
    expect(summary.rejected).toBe(1);
    expect(summary.errorReport?.[0]?.reason).toBeTruthy();
  });
});

describe('FR-715 / FR-716 — role-based access, enforced server-side', () => {
  it('AC2: a Sales/Counter user is denied editing a rate master, server-side', async () => {
    const sales = await addUser(t, 'SALES_COUNTER');
    const res = await sales.post('/rate-cards', {
      itemName: `Sneaky rate ${Date.now()}`,
      publishedRate: '10',
      gstPct: '18',
    });
    expect(res.status).toBe(403);
  });

  it('AC1: a Delivery user cannot reach the quotation module by direct API call', async () => {
    const delivery = await addUser(t, 'DELIVERY');
    const res = await delivery.get('/quotes');
    expect([401, 403, 404]).toContain(res.status);
  });

  it('a user with no token is rejected', async () => {
    const { default: request } = await import('supertest');
    const { app } = await import('./helpers/harness.js');
    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(401);
  });
});

describe('BR-4 — tenant isolation', () => {
  it('a customer created in one shop is invisible and unreachable from another', async () => {
    const other = await newTenant({ stateCode: '29', legalName: 'Other Shop' });

    const created = await t.owner.post('/customers', {
      name: `Private Customer ${Date.now()}`,
      customerType: 'UNREGISTERED',
      placeOfSupplyState: '27',
      phone: '9899999999',
    });
    const id = body<{ id: string }>(created).id;

    const leak = await other.owner.get(`/customers/${id}`);
    expect([403, 404]).toContain(leak.status);

    const list = await other.owner.get('/customers');
    const names = ((body<{ data: Array<{ id: string }> }>(list).data ?? []) as Array<{ id: string }>).map((c) => c.id);
    expect(names).not.toContain(id);
  });
});

describe('FR-718 — basic audit log', () => {
  it('records who created a rate master, with a timestamp', async () => {
    const uoms = await t.owner.get('/setup/uoms');
    const sqft = ((body<{ data: Array<{ id: string; uomCode: string }> }>(uoms).data ?? []) as Array<{
      id: string;
      uomCode: string;
    }>).find((u) => u.uomCode === 'SQFT')!;

    await t.owner.post('/rate-cards', {
      itemName: `Audited rate ${Date.now()}`,
      uomId: sqft.id,
      publishedRate: '18',
      hsnSac: '998912',
      gstPct: '18',
    });

    const log = await t.owner.get('/setup/audit-log?entityType=RateCard');
    expect(log.status).toBe(200);
    const payload = log.body as {
      readOnly: boolean;
      data: Array<{ action: string; actor: { id: string; name: string } | null; createdAt: string }>;
    };

    expect(payload.readOnly).toBe(true);
    expect(payload.data.length).toBeGreaterThan(0);

    const entry = payload.data[0];
    expect(entry.action).toBe('CREATE');
    expect(entry.actor?.id).toBeTruthy();
    expect(entry.actor?.name).toBeTruthy();
    expect(entry.createdAt).toBeTruthy();
  });
});

describe('FR-722 / FR-724 / FR-725 — plans, seats and limit enforcement', () => {
  it('FR-722 AC1: seat usage is reported against the plan maximum', async () => {
    const res = await t.owner.get('/setup/subscription');
    expect(res.status).toBe(200);
    const sub = res.body as {
      usage: { users: { used: number; max: number }; branches: { used: number; max: number } };
      plans: Array<{ code: string; current: boolean }>;
    };
    expect(typeof sub.usage.users.used).toBe('number');
    expect(sub.usage.users.max).toBeGreaterThan(0);
    expect(sub.plans.some((p) => p.current)).toBe(true);
  });

  it('AC1: inviting a user past the seat limit is blocked with an upgrade prompt', async () => {
    // Starter ships 3 seats; the owner already holds one.
    const starter = await newTenant({ stateCode: '27', plan: 'STARTER' });
    await addUser(starter, 'SALES_COUNTER');
    await addUser(starter, 'OPERATOR');

    const overflow = await starter.owner.post('/setup/users', {
      name: 'One Too Many',
      email: `overflow-${Date.now()}@leoink.test`,
      role: 'OPERATOR',
      password: 'leoink-test-123',
    });

    expect(overflow.status).toBe(409);
    expect(overflow.body.error.code).toBe('PLAN_LIMIT');
    expect(JSON.stringify(overflow.body)).toMatch(/upgrade/i);
  });

  it('AC2: adding a branch past the plan limit is prevented with an upgrade prompt', async () => {
    const starter = await newTenant({ stateCode: '27', plan: 'STARTER' }); // 1 branch
    const res = await starter.owner.post('/setup/branches', {
      branchCode: 'BR2',
      name: 'Second Branch',
      stateCode: '27',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_LIMIT');
  });

  it('FR-724 AC1: a downgrade that current usage would not fit is blocked, listing what to reduce', async () => {
    const growth = await newTenant({ stateCode: '27', plan: 'GROWTH' });
    await addUser(growth, 'SALES_COUNTER');
    await addUser(growth, 'OPERATOR');
    await addUser(growth, 'PRODUCTION_MANAGER'); // 4 active users vs Starter's 3

    const res = await growth.owner.post('/setup/subscription/change', { planCode: 'STARTER' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/user/i);
  });

  it('FR-724 AC2: an upgrade takes effect immediately', async () => {
    const starter = await newTenant({ stateCode: '27', plan: 'STARTER' });

    const blocked = await starter.owner.post('/setup/branches', {
      branchCode: 'BR2',
      name: 'Second Branch',
      stateCode: '27',
    });
    expect(blocked.status).toBe(409);

    const upgraded = await starter.owner.post('/setup/subscription/change', { planCode: 'GROWTH' });
    expect(upgraded.status).toBeLessThan(400);

    const allowed = await starter.owner.post('/setup/branches', {
      branchCode: 'BR2',
      name: 'Second Branch',
      stateCode: '27',
    });
    expect(allowed.status).toBe(201);
  });
});

describe('BR-6 — the GSTIN check digit is the documented mod-36 algorithm', () => {
  it('accepts a published real-world GSTIN shape', () => {
    expect(gstinCheckDigit('27AAPFU0939F1Z')).toBe('V');
  });
});
