/**
 * API conformance — FRD §4 "CRM, Estimation, Quotation & Pricing Engine"
 * (FR-200 … FR-233). This is Leo Ink's wedge #1; the acceptance criteria quoted
 * in each test title come straight from the FRD.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { newTenant, body, closeDb, type Tenant, type Client } from './helpers/harness.js';
import { buildGstin } from '../src/lib/gstin.js';

let t: Tenant;
let owner: Client;

let sqftUomId: string;
let sacId: string;
let starFlexId: string;
let backlitId: string;
let noRateMediaId: string;
let intraCustomerId: string;
let interCustomerId: string;

async function pickUom(code: string): Promise<string> {
  const res = await owner.get('/setup/uoms');
  const list = (body<{ data: Array<{ id: string; uomCode: string }> }>(res).data ?? []) as Array<{
    id: string;
    uomCode: string;
  }>;
  return list.find((u) => u.uomCode === code)!.id;
}

beforeAll(async () => {
  t = await newTenant({ stateCode: '27' });
  owner = t.owner;

  sqftUomId = await pickUom('SQFT');

  const hsn = await owner.post('/setup/hsn-codes', {
    code: '998912',
    type: 'SAC',
    description: 'Printing services',
  });
  sacId = body<{ id: string }>(hsn).id;

  const star = await owner.post('/materials', {
    itemCode: 'FLX-STAR',
    name: 'Star Flex 340 GSM',
    category: 'MEDIA',
    rollWidthFt: '10',
    uomId: sqftUomId,
    hsnSacId: sacId,
    costRate: '11',
    sellingRate: '40',
    minCharge: '250',
    gstPct: '18',
  });
  starFlexId = body<{ id: string }>(star).id;

  const backlit = await owner.post('/materials', {
    itemCode: 'FLX-BACKLIT',
    name: 'Backlit Flex 510 GSM',
    category: 'MEDIA',
    rollWidthFt: '8',
    uomId: sqftUomId,
    hsnSacId: sacId,
    costRate: '19',
    sellingRate: '32',
    minCharge: '350',
    gstPct: '18',
  });
  backlitId = body<{ id: string }>(backlit).id;

  const noRate = await owner.post('/materials', {
    itemCode: 'VNL-REFLECT',
    name: 'Reflective Vinyl (rate pending)',
    category: 'MEDIA',
    rollWidthFt: '4',
    uomId: sqftUomId,
    hsnSacId: sacId,
    gstPct: '18',
  });
  noRateMediaId = body<{ id: string }>(noRate).id;

  const intra = await owner.post('/customers', {
    name: 'Deccan Auto Spares Pvt Ltd',
    customerType: 'REGISTERED',
    gstin: buildGstin('27', 'AACCD5678K'),
    placeOfSupplyState: '27',
    phone: '9822011223',
    email: 'purchase@deccanauto.in',
  });
  intraCustomerId = body<{ id: string }>(intra).id;

  const inter = await owner.post('/customers', {
    name: 'Bengaluru Events LLP',
    customerType: 'REGISTERED',
    gstin: buildGstin('29', 'AAEFB9012M'),
    placeOfSupplyState: '29',
    phone: '9845566778',
    email: 'ops@bengalurevents.in',
  });
  interCustomerId = body<{ id: string }>(inter).id;
}, 180_000);

afterAll(async () => {
  await closeDb();
});

const flexLine = (over: Record<string, unknown> = {}) => ({
  lineNo: 1,
  kind: 'AREA',
  materialId: starFlexId,
  heightFt: '4',
  widthFt: '6',
  qty: '2',
  gstPct: '18',
  hsnSac: '998912',
  ...over,
});

describe('FR-210 / FR-211 — the shared engine prices flex by the square foot', () => {
  it('AC1: 4 ft × 6 ft, qty 2 at ₹40/sq.ft → area 24 sq.ft and line base ₹1,920', async () => {
    const res = await owner.post('/quotes/price', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '40' })],
    });
    expect(res.status).toBe(200);

    const p = body<{ lines: Array<{ areaSqft: string; grossAmount: string }>; engineVersion: string }>(res);
    expect(Number(p.lines[0].areaSqft)).toBe(24);
    expect(p.lines[0].grossAmount).toBe('1920.00');
    expect(p.engineVersion).toBeTruthy();
  });

  it('AC2: a line below the media minimum is raised to the minimum, with the uplift indicated', async () => {
    const res = await owner.post('/quotes/price', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ heightFt: '1', widthFt: '1', qty: '1', rate: '150', minCharge: '250' })],
    });
    const line = body<{ lines: Array<{ grossAmount: string; minChargeApplied: boolean; minChargeUplift: string }> }>(res)
      .lines[0];
    expect(line.grossAmount).toBe('250.00');
    expect(line.minChargeApplied).toBe(true);
    expect(line.minChargeUplift).toBe('100.00');
  });

  it('AC3: selecting backlit uses the backlit rate from the material master, not a generic one', async () => {
    const res = await owner.post('/quotes/price', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ materialId: backlitId })],
    });
    const line = body<{ lines: Array<{ rate: string; rateSource: string; grossAmount: string }> }>(res).lines[0];
    expect(Number(line.rate)).toBe(32);
    expect(line.rateSource).toBe('MATERIAL_MASTER');
    expect(line.grossAmount).toBe('1536.00'); // 24 × 32 × 2
  });
});

describe('FR-212 — media rate lookup and its resolution order', () => {
  it('AC1: a media with an active rate populates rate, HSN/SAC and GST on the line', async () => {
    const res = await owner.post('/quotes/price', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [{ lineNo: 1, kind: 'AREA', materialId: starFlexId, heightFt: '3', widthFt: '3', qty: '1' }],
    });
    const line = body<{ lines: Array<{ rate: string; hsnSac: string; gstPct: string }> }>(res).lines[0];
    expect(Number(line.rate)).toBe(40);
    expect(line.hsnSac).toBe('998912');
    expect(Number(line.gstPct)).toBe(18);
  });

  it('AC2: an explicit line rate wins over the master and is flagged as an override', async () => {
    const res = await owner.post('/quotes/price', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '55' })],
    });
    const line = body<{ lines: Array<{ rate: string; rateSource: string }> }>(res).lines[0];
    expect(Number(line.rate)).toBe(55);
    expect(line.rateSource).toBe('LINE_OVERRIDE');
  });

  it('AC3: a media with no active rate blocks auto-pricing and prompts for a rate', async () => {
    const res = await owner.post('/quotes/price', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [{ lineNo: 1, kind: 'AREA', materialId: noRateMediaId, heightFt: '3', widthFt: '3', qty: '1' }],
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/RATE_UNAVAILABLE|rate/i);
  });
});

describe('FR-214 — discounts are always pre-GST', () => {
  it('AC1: a ₹1,000 line with 10% discount is taxed on ₹900', async () => {
    const res = await owner.post('/quotes/price', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [{ lineNo: 1, kind: 'QTY', qty: '1', rate: '1000', gstPct: '18', hsnSac: '998912' }],
    });
    const p = body<{ lines: Array<{ lineTaxable: string }>; cgst: string; sgst: string }>(res);
    expect(p.lines[0].lineTaxable).toBe('1000.00');

    const discounted = await owner.post('/quotes/price', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [{ lineNo: 1, kind: 'QTY', qty: '1', rate: '1000', discountPct: '10', gstPct: '18', hsnSac: '998912' }],
    });
    const d = body<{ lines: Array<{ lineTaxable: string }>; cgst: string; sgst: string }>(discounted);
    expect(d.lines[0].lineTaxable).toBe('900.00');
    expect(d.cgst).toBe('81.00');
    expect(d.sgst).toBe('81.00');
  });

  it('AC2: a ₹200 document discount over two differently-rated lines is apportioned pro-rata', async () => {
    const res = await owner.post('/quotes/price', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      docDiscountAmt: '200',
      lines: [
        { lineNo: 1, kind: 'QTY', qty: '1', rate: '600', gstPct: '18', hsnSac: '998912' },
        { lineNo: 2, kind: 'QTY', qty: '1', rate: '400', gstPct: '12', hsnSac: '4911' },
      ],
    });
    const p = body<{ lines: Array<{ docDiscountShare: string; lineTaxable: string; cgst: string }>; taxableValue: string }>(
      res,
    );
    expect(p.lines[0].docDiscountShare).toBe('120.00');
    expect(p.lines[1].docDiscountShare).toBe('80.00');
    expect(p.lines[0].lineTaxable).toBe('480.00');
    expect(p.lines[1].lineTaxable).toBe('320.00');
    expect(p.lines[0].cgst).toBe('43.20'); // 9% of 480
    expect(p.lines[1].cgst).toBe('19.20'); // 6% of 320
    expect(p.taxableValue).toBe('800.00');
  });
});

describe('FR-223 / FR-224 — GST-aware totals and place-of-supply resolution', () => {
  it('AC1: same state at 18% → CGST 9% + SGST 9%, no IGST', async () => {
    const res = await owner.post('/quotes/price', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [{ lineNo: 1, kind: 'QTY', qty: '1', rate: '1000', gstPct: '18', hsnSac: '998912' }],
    });
    const p = body<{ cgst: string; sgst: string; igst: string; isInterstate: boolean }>(res);
    expect(p.isInterstate).toBe(false);
    expect(p.cgst).toBe('90.00');
    expect(p.sgst).toBe('90.00');
    expect(p.igst).toBe('0.00');
  });

  it('AC2: a different state at 18% → IGST 18%, no CGST/SGST', async () => {
    const res = await owner.post('/quotes/price', {
      customerId: interCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '29',
      lines: [{ lineNo: 1, kind: 'QTY', qty: '1', rate: '1000', gstPct: '18', hsnSac: '998912' }],
    });
    const p = body<{ cgst: string; sgst: string; igst: string; isInterstate: boolean }>(res);
    expect(p.isInterstate).toBe(true);
    expect(p.igst).toBe('180.00');
    expect(p.cgst).toBe('0.00');
  });

  it('AC3: a grand total of ₹1,235 renders "Rupees One Thousand Two Hundred Thirty Five Only"', async () => {
    const res = await owner.post('/quotes/price', {
      customerId: interCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '29',
      lines: [{ lineNo: 1, kind: 'QTY', qty: '1', rate: '1046.27', gstPct: '18', hsnSac: '998912' }],
    });
    const p = body<{ grandTotal: string; roundOff: string; amountInWords: string }>(res);
    expect(p.grandTotal).toBe('1235.00');
    expect(p.roundOff).toBe('0.40');
    expect(p.amountInWords).toBe('Rupees One Thousand Two Hundred Thirty Five Only');
  });
});

describe('FR-222 / FR-230 — quote persistence, numbering and lifecycle', () => {
  let draftId: string;

  it('a draft saves with all engine figures persisted and NO quote number (BR-3)', async () => {
    const res = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      quoteDate: new Date().toISOString().slice(0, 10),
      lines: [flexLine({ rate: '40' })],
    });
    expect(res.status).toBe(201);

    const q = body<{
      id: string;
      quoteNo: string | null;
      status: string;
      taxableValue: string;
      cgst: string;
      grandTotal: string;
      engineVersion: string;
      amountInWords: string;
    }>(res);

    draftId = q.id;
    expect(q.status).toBe('DRAFT');
    expect(q.quoteNo).toBeNull();
    expect(q.taxableValue).toBe('1920.00');
    expect(q.cgst).toBe('172.80'); // 9% of 1920
    expect(q.grandTotal).toBe('2266.00'); // 1920 + 345.60 = 2265.60 → 2266
    expect(q.engineVersion).toBeTruthy();
    expect(q.amountInWords).toMatch(/^Rupees /);
  });

  it('AC3: a saved draft reopens with lines and totals exactly as left', async () => {
    const res = await owner.get(`/quotes/${draftId}`);
    expect(res.status).toBe(200);
    const q = body<{ lines: unknown[]; grandTotal: string }>(res);
    expect(q.lines).toHaveLength(1);
    expect(q.grandTotal).toBe('2266.00');
  });

  it('AC1: changing a line quantity recomputes the line and every document total', async () => {
    const res = await owner.put(`/quotes/${draftId}`, {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '40', qty: '4' })],
    });
    expect(res.status).toBe(200);
    const q = body<{ taxableValue: string }>(res);
    expect(q.taxableValue).toBe('3840.00'); // 24 sq.ft × 40 × 4
  });

  it('FR-230 AC1: sending allocates a gap-free FY-resetting number, and the next is consecutive', async () => {
    const first = await owner.post(`/quotes/${draftId}/send`, { channel: 'WHATSAPP' });
    expect(first.status).toBeLessThan(400);
    const q1 = body<{ quoteNo: string; status: string; sentAt: string; validUntil: string }>(first);

    expect(q1.status).toBe('SENT');
    expect(q1.quoteNo).toMatch(/^QUO\/\d{4}-\d{2}\/0*1$/);
    expect(q1.sentAt).toBeTruthy();
    expect(q1.validUntil).toBeTruthy();

    const second = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '40' })],
    });
    const secondSent = await owner.post(`/quotes/${body<{ id: string }>(second).id}/send`, { channel: 'WHATSAPP' });
    const q2 = body<{ quoteNo: string }>(secondSent);

    const n1 = Number(q1.quoteNo.split('/').pop());
    const n2 = Number(q2.quoteNo.split('/').pop());
    expect(n2).toBe(n1 + 1); // gap-free
  });

  it('an abandoned draft burns no number — the sequence stays gap-free (FR-107 AC2)', async () => {
    const abandoned = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '40' })],
    });
    expect(body<{ quoteNo: string | null }>(abandoned).quoteNo).toBeNull();

    const next = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '40' })],
    });
    const sent = await owner.post(`/quotes/${body<{ id: string }>(next).id}/send`, { channel: 'WHATSAPP' });
    expect(Number(body<{ quoteNo: string }>(sent).quoteNo.split('/').pop())).toBe(3);
  });

  it('AC3: moving a quote to Lost requires a reason', async () => {
    const created = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '40' })],
    });
    const id = body<{ id: string }>(created).id;
    await owner.post(`/quotes/${id}/send`, { channel: 'WHATSAPP' });

    const noReason = await owner.post(`/quotes/${id}/status`, { status: 'LOST' });
    expect(noReason.status).toBeGreaterThanOrEqual(400);

    const withReason = await owner.post(`/quotes/${id}/status`, { status: 'LOST', lostReason: 'Price too high' });
    expect(withReason.status).toBe(200);
    expect(body<{ status: string }>(withReason).status).toBe('LOST');
  });

  it('rejects an illegal status transition (Draft → Won)', async () => {
    const created = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '40' })],
    });
    const id = body<{ id: string }>(created).id;
    const res = await owner.post(`/quotes/${id}/status`, { status: 'WON' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('FR-224 — place of supply is mandatory before Send', () => {
  it('AC3: sending a quote with no place of supply is blocked', async () => {
    const created = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      lines: [flexLine({ rate: '40' })],
      placeOfSupplyState: null,
    });

    if (created.status === 201) {
      const id = body<{ id: string }>(created).id;
      const sent = await owner.post(`/quotes/${id}/send`, { channel: 'WHATSAPP' });
      expect(sent.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(sent.body)).toMatch(/place.of.supply/i);
    } else {
      expect(created.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('FR-226 — sharing the quote', () => {
  it('AC3: an email share to a customer with no email prompts rather than failing silently', async () => {
    const noEmail = await owner.post('/customers', {
      name: `No Email Shop ${Date.now()}`,
      customerType: 'UNREGISTERED',
      placeOfSupplyState: '27',
      phone: '9800000123',
    });
    const created = await owner.post('/quotes', {
      customerId: body<{ id: string }>(noEmail).id,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '40' })],
    });
    const res = await owner.post(`/quotes/${body<{ id: string }>(created).id}/send`, { channel: 'EMAIL' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/email/i);
  });
});

describe('FR-225 — branded quote document model', () => {
  it('AC3: the document is labelled a Quotation / Estimate and never a Tax Invoice', async () => {
    const created = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '40' })],
    });
    const id = body<{ id: string }>(created).id;
    await owner.post(`/quotes/${id}/send`, { channel: 'WHATSAPP' });

    const doc = await owner.get(`/quotes/${id}/document`);
    expect(doc.status).toBe(200);

    const rendered = body<{ documentTitle: string; declaration: string | null }>(doc);
    expect(rendered.documentTitle).toMatch(/Quotation/i);
    expect(rendered.documentTitle).not.toMatch(/Tax Invoice/i);
    // The only place "tax invoice" may appear is the disclaimer that this is not one.
    expect(rendered.declaration).toMatch(/not a tax invoice/i);
  });

  it('AC2: regenerating the same quote produces identical content (deterministic)', async () => {
    const created = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '40' })],
    });
    const id = body<{ id: string }>(created).id;
    await owner.post(`/quotes/${id}/send`, { channel: 'WHATSAPP' });

    const a = await owner.get(`/quotes/${id}/document`);
    const b = await owner.get(`/quotes/${id}/document`);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  });
});

describe('FR-231 — clone / re-quote', () => {
  it('AC1: a clone is a new Draft with the same lines and a link back to the source', async () => {
    const created = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '40' })],
    });
    const sourceId = body<{ id: string }>(created).id;

    const cloned = await owner.post(`/quotes/${sourceId}/clone`, {});
    expect(cloned.status).toBeLessThan(400);
    const clone = body<{ id: string; status: string; quoteNo: string | null; clonedFrom: string; lines: unknown[] }>(
      cloned,
    );
    expect(clone.status).toBe('DRAFT');
    expect(clone.quoteNo).toBeNull();
    expect(clone.clonedFrom).toBe(sourceId);
    expect(clone.lines).toHaveLength(1);
  });

  it('AC2: a clone re-prices at current rates while keeping the spec', async () => {
    const created = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [{ lineNo: 1, kind: 'AREA', materialId: backlitId, heightFt: '4', widthFt: '6', qty: '1' }],
    });
    const sourceId = body<{ id: string }>(created).id;
    expect(body<{ taxableValue: string }>(created).taxableValue).toBe('768.00'); // 24 × 32

    // The shop raises the backlit rate.
    await owner.put(`/materials/${backlitId}`, { sellingRate: '36' });

    const cloned = await owner.post(`/quotes/${sourceId}/clone`, {});
    expect(body<{ taxableValue: string }>(cloned).taxableValue).toBe('864.00'); // 24 × 36

    await owner.put(`/materials/${backlitId}`, { sellingRate: '32' }); // restore
  });
});

describe('FR-233 — one-click quote → jobcard, with the quoted figures carried', () => {
  let wonQuoteId: string;

  it('AC1: converting a Won quote creates a jobcard with identical specs and prices', async () => {
    const created = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '40' })],
    });
    wonQuoteId = body<{ id: string }>(created).id;

    await owner.post(`/quotes/${wonQuoteId}/send`, { channel: 'WHATSAPP' });
    await owner.post(`/quotes/${wonQuoteId}/status`, { status: 'WON' });

    const converted = await owner.post(`/quotes/${wonQuoteId}/convert-to-jobcard`, {});
    expect(converted.status).toBeLessThan(400);

    // The response carries both sides of the link.
    const payload = converted.body as {
      quote: { id: string; status: string };
      jobcard: { id: string; jobcardNo: string };
    };
    expect(payload.quote.id).toBe(wonQuoteId);

    const jc = payload.jobcard;
    expect(jc.jobcardNo).toMatch(/^JC\//);

    const bag = await owner.get(`/jobcards/${jc.id}/job-bag`);
    const specs = body<{ specs: Array<{ rate: string; lineTaxable: string; areaSqft: string }> }>(bag).specs;
    expect(specs).toHaveLength(1);
    expect(Number(specs[0].rate)).toBe(40);
    expect(specs[0].lineTaxable).toBe('1920.00');
    expect(Number(specs[0].areaSqft)).toBe(48); // 24 sq.ft × qty 2
  });

  it('AC3: converting a second time is blocked and links to the existing jobcard', async () => {
    const again = await owner.post(`/quotes/${wonQuoteId}/convert-to-jobcard`, {});
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toMatch(/jobcard/i);
  });

  it('AC (guard): a quote that is not Won cannot be converted', async () => {
    const created = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      lines: [flexLine({ rate: '40' })],
    });
    const res = await owner.post(`/quotes/${body<{ id: string }>(created).id}/convert-to-jobcard`, {});
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('FR-200 / FR-220 — enquiry inbox and one-click conversion', () => {
  it('AC2: a phone enquiry saves without an email', async () => {
    const res = await owner.post('/enquiries', {
      source: 'PHONE',
      contactName: 'Mr Deshmukh',
      phone: '9876500001',
      vertical: 'FLEX_LARGE_FORMAT',
      description: '2 flex banners 6×4 ft for a shop opening',
    });
    expect(res.status).toBe(201);
    expect(body<{ status: string }>(res).status).toBe('NEW');
  });

  it('AC4: a second open enquiry with the same phone and product type warns without blocking', async () => {
    const res = await owner.post('/enquiries', {
      source: 'WHATSAPP',
      contactName: 'Mr Deshmukh',
      phone: '9876500001',
      vertical: 'FLEX_LARGE_FORMAT',
      description: 'Same requirement again',
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).toMatch(/duplicate/i);
  });

  it('FR-220 AC2: converting an enquiry with no customer requires one first', async () => {
    const enquiry = await owner.post('/enquiries', {
      source: 'WALK_IN',
      contactName: 'Unlinked Walk-in',
      phone: '9876500002',
      vertical: 'FLEX_LARGE_FORMAT',
    });
    const res = await owner.post(`/enquiries/${body<{ id: string }>(enquiry).id}/convert-to-quote`, {});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/customer/i);
  });

  it('FR-220 AC1 & AC3: converting a linked enquiry opens a pre-filled draft and marks it Quoted', async () => {
    const enquiry = await owner.post('/enquiries', {
      source: 'WALK_IN',
      contactName: 'Deccan Auto',
      phone: '9822011223',
      customerId: intraCustomerId,
      vertical: 'FLEX_LARGE_FORMAT',
      description: 'Backlit board 8×4 ft',
    });
    const enquiryId = body<{ id: string }>(enquiry).id;

    const converted = await owner.post(`/enquiries/${enquiryId}/convert-to-quote`, {});
    expect(converted.status).toBeLessThan(400);

    const { quote } = converted.body as { quote: { id: string; status: string; enquiryId: string; quoteNo: string | null } };
    expect(quote.status).toBe('DRAFT');
    expect(quote.quoteNo).toBeNull(); // BR-3 — no number until it is sent
    expect(quote.enquiryId).toBe(enquiryId);

    const after = await owner.get(`/enquiries/${enquiryId}`);
    expect(body<{ status: string }>(after).status).toBe('QUOTED');
  });
});

describe('FR-203 — follow-ups', () => {
  it('a follow-up must have exactly one parent', async () => {
    const res = await owner.post('/follow-ups', {
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      note: 'Call back',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('AC2: an overdue follow-up is flagged in the worklist', async () => {
    const enquiry = await owner.post('/enquiries', {
      source: 'PHONE',
      contactName: 'Overdue Lead',
      phone: '9876500003',
      vertical: 'FLEX_LARGE_FORMAT',
    });
    const created = await owner.post('/follow-ups', {
      enquiryId: body<{ id: string }>(enquiry).id,
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
      note: 'Should already have called',
    });
    expect(created.status).toBe(201);

    const mine = await owner.get('/follow-ups/mine');
    const items = (body<{ data: Array<{ overdue: boolean }> }>(mine).data ?? []) as Array<{ overdue: boolean }>;
    expect(items.some((f) => f.overdue)).toBe(true);
  });

  it('closing a follow-up requires an outcome note', async () => {
    const mine = await owner.get('/follow-ups/mine');
    const items = (body<{ data: Array<{ id: string; status: string }> }>(mine).data ?? []) as Array<{
      id: string;
      status: string;
    }>;
    const open = items.find((f) => f.status === 'OPEN')!;

    const noOutcome = await owner.post(`/follow-ups/${open.id}/close`, {});
    expect(noOutcome.status).toBeGreaterThanOrEqual(400);

    const withOutcome = await owner.post(`/follow-ups/${open.id}/close`, { outcome: 'Spoke, wants a revised rate' });
    expect(withOutcome.status).toBe(200);
  });
});

describe('BR-7 — quote ↔ invoice parity guarantee', () => {
  it('the stateless price preview and the persisted quote agree to the paise', async () => {
    const lines = [
      flexLine({ rate: '40' }),
      { lineNo: 2, kind: 'QTY', qty: '500', rate: '2.35', gstPct: '12', hsnSac: '4911' },
    ];

    const preview = await owner.post('/quotes/price', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      docDiscountAmt: '137.50',
      lines,
    });
    const saved = await owner.post('/quotes', {
      customerId: intraCustomerId,
      branchId: t.branchId,
      placeOfSupplyState: '27',
      docDiscountAmt: '137.50',
      lines,
    });

    const p = body<{ taxableValue: string; cgst: string; sgst: string; roundOff: string; grandTotal: string }>(preview);
    const q = body<{ taxableValue: string; cgst: string; sgst: string; roundOff: string; grandTotal: string }>(saved);

    expect(q.taxableValue).toBe(p.taxableValue);
    expect(q.cgst).toBe(p.cgst);
    expect(q.sgst).toBe(p.sgst);
    expect(q.roundOff).toBe(p.roundOff);
    expect(q.grandTotal).toBe(p.grandTotal);
  });
});
