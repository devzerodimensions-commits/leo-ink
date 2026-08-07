/**
 * Conformance tests for the shared print-pricing engine.
 *
 * Every `it(...)` title quotes an acceptance criterion from
 * "Leo Ink — Phase 1 FRD.md" §4.2 / §7.2. If one of these fails, the build does
 * not meet the document.
 */
import { describe, it, expect } from 'vitest';
import {
  priceDocument,
  resolveGstTreatment,
  splitTax,
  applyMarkup,
  computeArea,
  PricingError,
  PRICING_ENGINE_VERSION,
  serializePricing,
  type PricingDocumentInput,
} from '../src/engine/pricing.js';

const flexLine = (over: Partial<PricingDocumentInput['lines'][number]> = {}) => ({
  lineNo: 1,
  kind: 'AREA' as const,
  heightFt: 4,
  widthFt: 6,
  qty: 2,
  rate: 40,
  gstPct: 18,
  ...over,
});

describe('FR-210 — shared pricing engine, single computation service', () => {
  it('stamps the engine version on every result', () => {
    const r = priceDocument({ lines: [flexLine()], isInterstate: false });
    expect(r.engineVersion).toBe(PRICING_ENGINE_VERSION);
  });

  it('AC1: identical line inputs priced twice yield byte-for-byte identical amounts', () => {
    const input: PricingDocumentInput = {
      lines: [flexLine(), { lineNo: 2, kind: 'QTY', qty: 500, rate: 2.35, gstPct: 12, hsnSac: '4911', isService: false }],
      isInterstate: false,
      docDiscountAmt: 137.5,
    };
    // The quote builder computes, then the invoice builder recomputes the same inputs.
    const asQuote = serializePricing(priceDocument(input));
    const asInvoice = serializePricing(priceDocument(structuredClone(input)));
    expect(JSON.stringify(asInvoice)).toBe(JSON.stringify(asQuote));
  });

  it('AC2: money values are exact decimals, not floats (0.1 + 0.2 problem)', () => {
    const r = priceDocument({
      lines: [{ lineNo: 1, kind: 'QTY', qty: 3, rate: 0.1, gstPct: 0 }],
      isInterstate: false,
      roundingMode: 'NONE',
    });
    // A float pipeline gives 0.30000000000000004.
    expect(r.taxableValue.toFixed(2)).toBe('0.30');
    expect(serializePricing(r).taxableValue).toBe('0.30');
  });

  it('rejects a document with no lines', () => {
    expect(() => priceDocument({ lines: [], isInterstate: false })).toThrow(PricingError);
  });
});

describe('FR-211 — flex / large-format square-foot pricing', () => {
  it('AC1: height 4 ft × width 6 ft, qty 2 at Rs 40/sq.ft → area 24 sq.ft, line base Rs 1,920', () => {
    const r = priceDocument({ lines: [flexLine()], isInterstate: false });
    const line = r.lines[0];
    expect(line.areaSqft!.toFixed(2)).toBe('24.00');
    expect(line.grossAmount.toFixed(2)).toBe('1920.00');
  });

  it('AC2: a Rs 150 line against a Rs 250 media minimum is charged Rs 250, with the uplift indicated', () => {
    const r = priceDocument({
      lines: [{ lineNo: 1, kind: 'AREA', heightFt: 1, widthFt: 1, qty: 1, rate: 150, minCharge: 250, gstPct: 18 }],
      isInterstate: false,
    });
    const line = r.lines[0];
    expect(line.grossAmount.toFixed(2)).toBe('250.00');
    expect(line.minChargeApplied).toBe(true);
    expect(line.minChargeUplift.toFixed(2)).toBe('100.00');
  });

  it('AC3: the rate used is the selected media rate, not a generic one', () => {
    const backlit = priceDocument({
      lines: [flexLine({ rate: 32, rateSource: 'MATERIAL_MASTER' })],
      isInterstate: false,
    });
    expect(backlit.lines[0].rate.toFixed(2)).toBe('32.00');
    expect(backlit.lines[0].rateSource).toBe('MATERIAL_MASTER');
    expect(backlit.lines[0].grossAmount.toFixed(2)).toBe('1536.00'); // 24 × 32 × 2
  });

  it('accepts fractional feet, and the optional round-up-to-foot rule is off by default', () => {
    expect(computeArea(3.5, 2.5).toFixed(4)).toBe('8.7500');
    expect(computeArea(3.5, 2.5, true).toFixed(4)).toBe('12.0000'); // 4 × 3
  });

  it('refuses a line with no resolvable rate (FR-212: material without an active rate)', () => {
    expect(() =>
      priceDocument({
        lines: [{ lineNo: 1, kind: 'AREA', heightFt: 2, widthFt: 3, qty: 1, gstPct: 18 }],
        isInterstate: false,
      }),
    ).toThrow(/No rate available/);
  });
});

describe('FR-213 — markup / margin on cost', () => {
  it('AC1: cost Rs 100 with 25% markup → selling Rs 125 before discount and tax', () => {
    expect(applyMarkup(100, 25, 'MARKUP').toFixed(2)).toBe('125.00');
  });

  it('AC2: a line without markup picks up the tenant default of 20%', () => {
    const r = priceDocument({
      lines: [{ lineNo: 1, kind: 'QTY', qty: 1, costRate: 100, gstPct: 18 }],
      isInterstate: false,
      defaultMarkupPct: 20,
    });
    expect(r.lines[0].rate.toFixed(2)).toBe('120.00');
  });

  it('AC3: margin mode at 20% on cost Rs 100 → selling Rs 125 (100 / 0.8)', () => {
    expect(applyMarkup(100, 20, 'MARGIN').toFixed(2)).toBe('125.00');
  });

  it('markup is applied before discount and before GST', () => {
    const r = priceDocument({
      lines: [{ lineNo: 1, kind: 'QTY', qty: 1, costRate: 100, markupPct: 25, discountPct: 10, gstPct: 18 }],
      isInterstate: false,
    });
    expect(r.lines[0].rate.toFixed(2)).toBe('125.00');
    expect(r.lines[0].grossAmount.toFixed(2)).toBe('125.00');
    expect(r.lines[0].discountAmt.toFixed(2)).toBe('12.50');
    expect(r.lines[0].lineTaxable.toFixed(2)).toBe('112.50');
  });
});

describe('FR-214 — discount handling (line & total)', () => {
  it('AC1: a Rs 1,000 line with 10% line discount → taxable Rs 900 and GST computed on Rs 900', () => {
    const r = priceDocument({
      lines: [{ lineNo: 1, kind: 'QTY', qty: 1, rate: 1000, discountPct: 10, gstPct: 18 }],
      isInterstate: false,
    });
    expect(r.lines[0].lineTaxable.toFixed(2)).toBe('900.00');
    expect(r.lines[0].cgst.toFixed(2)).toBe('81.00');
    expect(r.lines[0].sgst.toFixed(2)).toBe('81.00');
    expect(r.totalTax.toFixed(2)).toBe('162.00');
  });

  it('AC2: a Rs 200 document discount over two differently-rated lines is apportioned pro-rata', () => {
    const r = priceDocument({
      lines: [
        { lineNo: 1, kind: 'QTY', qty: 1, rate: 600, gstPct: 18 },
        { lineNo: 2, kind: 'QTY', qty: 1, rate: 400, gstPct: 12 },
      ],
      isInterstate: false,
      docDiscountAmt: 200,
    });

    // 60 / 40 split of the Rs 200.
    expect(r.lines[0].docDiscountShare.toFixed(2)).toBe('120.00');
    expect(r.lines[1].docDiscountShare.toFixed(2)).toBe('80.00');
    // The shares must sum back to the discount exactly — no rounding leak.
    expect(r.lines[0].docDiscountShare.plus(r.lines[1].docDiscountShare).toFixed(2)).toBe('200.00');

    // Each rate's tax is computed on its own net share.
    expect(r.lines[0].lineTaxable.toFixed(2)).toBe('480.00');
    expect(r.lines[1].lineTaxable.toFixed(2)).toBe('320.00');
    expect(r.lines[0].cgst.toFixed(2)).toBe('43.20'); // 9% of 480
    expect(r.lines[1].cgst.toFixed(2)).toBe('19.20'); // 6% of 320
    expect(r.taxableValue.toFixed(2)).toBe('800.00');
  });

  it('apportionment residue is absorbed so shares always sum to the document discount', () => {
    const r = priceDocument({
      lines: [
        { lineNo: 1, kind: 'QTY', qty: 1, rate: 100, gstPct: 18 },
        { lineNo: 2, kind: 'QTY', qty: 1, rate: 100, gstPct: 18 },
        { lineNo: 3, kind: 'QTY', qty: 1, rate: 100, gstPct: 18 },
      ],
      isInterstate: false,
      docDiscountAmt: 10, // 3.333… each
    });
    const total = r.lines.reduce((a, l) => a.plus(l.docDiscountShare), r.lines[0].docDiscountShare.minus(r.lines[0].docDiscountShare));
    expect(total.toFixed(2)).toBe('10.00');
  });

  it('AC3: a discount above the tenant threshold flags the quote as requiring approval', () => {
    const overThreshold = priceDocument({
      lines: [{ lineNo: 1, kind: 'QTY', qty: 1, rate: 1000, discountPct: 20, gstPct: 18 }],
      isInterstate: false,
      maxDiscountPct: 15,
    });
    expect(overThreshold.needsApproval).toBe(true);

    const withinThreshold = priceDocument({
      lines: [{ lineNo: 1, kind: 'QTY', qty: 1, rate: 1000, discountPct: 10, gstPct: 18 }],
      isInterstate: false,
      maxDiscountPct: 15,
    });
    expect(withinThreshold.needsApproval).toBe(false);
  });

  it('rejects a discount larger than the line', () => {
    expect(() =>
      priceDocument({
        lines: [{ lineNo: 1, kind: 'QTY', qty: 1, rate: 100, discountAmt: 150, gstPct: 18 }],
        isInterstate: false,
      }),
    ).toThrow(/exceed/);
  });
});

describe('FR-215 / FR-112 — rounding & round-off', () => {
  it('AC1: a grand total of Rs 1,234.60 → round_off +Rs 0.40 and payable Rs 1,235', () => {
    // 1046.27 taxable + IGST 18% (188.33) = 1234.60
    const r = priceDocument({
      lines: [{ lineNo: 1, kind: 'QTY', qty: 1, rate: 1046.27, gstPct: 18 }],
      isInterstate: true,
    });
    expect(r.computedTotal.toFixed(2)).toBe('1234.60');
    expect(r.roundOff.toFixed(2)).toBe('0.40');
    expect(r.grandTotal.toFixed(2)).toBe('1235.00');
  });

  it('FR-502 AC3: a grand total of 4,721.63 → invoice value 4,722.00 with round_off +0.37, taxable unchanged', () => {
    const r = priceDocument({
      lines: [{ lineNo: 1, kind: 'QTY', qty: 1, rate: 4001.38, gstPct: 18 }],
      isInterstate: true,
    });
    expect(r.computedTotal.toFixed(2)).toBe('4721.63');
    expect(r.roundOff.toFixed(2)).toBe('0.37');
    expect(r.grandTotal.toFixed(2)).toBe('4722.00');
    expect(r.taxableValue.toFixed(2)).toBe('4001.38'); // untouched by round-off
  });

  it('FR-112 AC2: mode None shows the exact 2-decimal total with no round-off', () => {
    const r = priceDocument({
      lines: [{ lineNo: 1, kind: 'QTY', qty: 1, rate: 1046.27, gstPct: 18 }],
      isInterstate: true,
      roundingMode: 'NONE',
    });
    expect(r.roundOff.toFixed(2)).toBe('0.00');
    expect(r.grandTotal.toFixed(2)).toBe('1234.60');
  });

  /**
   * FR-505 rounds CGST and SGST at half the rate *each*, so an intra-state
   * document can legitimately differ from the same value taxed as IGST by a
   * paise. Pinned deliberately — it is the statutory head-wise computation,
   * not a rounding bug.
   */
  it('FR-505 — head-wise rounding: the same taxable value can differ a paise between IGST and CGST+SGST', () => {
    const line = [{ lineNo: 1, kind: 'QTY' as const, qty: 1, rate: 1046.27, gstPct: 18 }];
    const inter = priceDocument({ lines: line, isInterstate: true, roundingMode: 'NONE' });
    const intra = priceDocument({ lines: line, isInterstate: false, roundingMode: 'NONE' });

    expect(inter.igst.toFixed(2)).toBe('188.33'); // round(1046.27 × 18%)
    expect(intra.cgst.toFixed(2)).toBe('94.16'); // round(1046.27 × 9%)
    expect(intra.sgst.toFixed(2)).toBe('94.16');
    expect(intra.totalTax.toFixed(2)).toBe('188.32');
    expect(inter.computedTotal.minus(intra.computedTotal).toFixed(2)).toBe('0.01');
  });

  it('FR-112 AC3: line taxes stay at 2 decimals regardless of grand-total rounding', () => {
    const r = priceDocument({
      lines: [{ lineNo: 1, kind: 'QTY', qty: 3, rate: 33.33, gstPct: 18 }],
      isInterstate: false,
    });
    for (const l of r.lines) {
      expect(l.cgst.decimalPlaces()).toBeLessThanOrEqual(2);
      expect(l.sgst.decimalPlaces()).toBeLessThanOrEqual(2);
      expect(l.lineTaxable.decimalPlaces()).toBeLessThanOrEqual(2);
    }
  });

  it('round_off always lands in the statutory −0.50 … +0.49 window', () => {
    for (let paise = 0; paise < 100; paise++) {
      const r = priceDocument({
        lines: [{ lineNo: 1, kind: 'QTY', qty: 1, rate: `100.${String(paise).padStart(2, '0')}`, gstPct: 0 }],
        isInterstate: false,
      });
      expect(r.roundOff.toNumber()).toBeGreaterThanOrEqual(-0.5);
      expect(r.roundOff.toNumber()).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('FR-224 / FR-505 / BR-2 — place-of-supply tax split', () => {
  it('AC1: supplier state = customer place of supply at 18% → CGST 9% + SGST 9%, no IGST', () => {
    const { isInterstate } = resolveGstTreatment('27', '27');
    expect(isInterstate).toBe(false);

    const r = priceDocument({ lines: [{ lineNo: 1, kind: 'QTY', qty: 1, rate: 1000, gstPct: 18 }], isInterstate });
    expect(r.cgst.toFixed(2)).toBe('90.00');
    expect(r.sgst.toFixed(2)).toBe('90.00');
    expect(r.igst.toFixed(2)).toBe('0.00');
  });

  it('AC2: differing states at 18% → IGST 18%, no CGST/SGST', () => {
    const { isInterstate } = resolveGstTreatment('27', '29');
    expect(isInterstate).toBe(true);

    const r = priceDocument({ lines: [{ lineNo: 1, kind: 'QTY', qty: 1, rate: 1000, gstPct: 18 }], isInterstate });
    expect(r.igst.toFixed(2)).toBe('180.00');
    expect(r.cgst.toFixed(2)).toBe('0.00');
    expect(r.sgst.toFixed(2)).toBe('0.00');
  });

  it('AC3: changing the place of supply flips the split automatically', () => {
    const lines = [{ lineNo: 1, kind: 'QTY' as const, qty: 1, rate: 1000, gstPct: 18 }];
    const intra = priceDocument({ lines, isInterstate: resolveGstTreatment('27', '27').isInterstate });
    const inter = priceDocument({ lines, isInterstate: resolveGstTreatment('27', '29').isInterstate });
    expect(intra.grandTotal.toFixed(2)).toBe(inter.grandTotal.toFixed(2)); // same money, different heads
    expect(intra.igst.isZero()).toBe(true);
    expect(inter.igst.toFixed(2)).toBe('180.00');
  });

  it('requires a place of supply before it can resolve a treatment', () => {
    expect(() => resolveGstTreatment('27', null)).toThrow(/Place of supply is required/);
    expect(() => resolveGstTreatment(null, '27')).toThrow(/state code/);
  });

  it('splitTax halves the rate intra-state, never the rounded tax', () => {
    // 999.99 at 5%: half-rate arithmetic must not drift from the full-rate figure.
    const { cgst, sgst } = splitTax(999.99, 5, false);
    expect(cgst.toFixed(2)).toBe('25.00');
    expect(sgst.toFixed(2)).toBe('25.00');
    const { igst } = splitTax(999.99, 5, true);
    expect(igst.toFixed(2)).toBe('50.00');
  });
});

describe('FR-223 / FR-504 / FR-506 — multi-rate GST and summaries', () => {
  it('FR-504 AC1: lines at 5%, 12% and 18% produce three independently correct rate buckets', () => {
    const r = priceDocument({
      lines: [
        { lineNo: 1, kind: 'QTY', qty: 1, rate: 1000, gstPct: 5 },
        { lineNo: 2, kind: 'QTY', qty: 1, rate: 1000, gstPct: 12 },
        { lineNo: 3, kind: 'QTY', qty: 1, rate: 1000, gstPct: 18 },
      ],
      isInterstate: true,
    });
    expect(r.rateWiseSummary).toHaveLength(3);
    expect(r.rateWiseSummary.map((b) => b.igst.toFixed(2))).toEqual(['50.00', '120.00', '180.00']);
    expect(r.igst.toFixed(2)).toBe('350.00');
  });

  it('FR-504 AC2: a 0% line contributes taxable value but zero tax, and is retained', () => {
    const r = priceDocument({
      lines: [
        { lineNo: 1, kind: 'QTY', qty: 1, rate: 500, gstPct: 0 },
        { lineNo: 2, kind: 'QTY', qty: 1, rate: 500, gstPct: 18 },
      ],
      isInterstate: false,
    });
    const nil = r.rateWiseSummary.find((b) => b.gstPct.isZero())!;
    expect(nil.taxableValue.toFixed(2)).toBe('500.00');
    expect(nil.cgst.toFixed(2)).toBe('0.00');
    expect(r.taxableValue.toFixed(2)).toBe('1000.00');
  });

  it('FR-506 AC1: paper at 12% (HSN) and printing service at 18% (SAC 998912) tax correctly on one document', () => {
    const r = priceDocument({
      lines: [
        { lineNo: 1, kind: 'QTY', qty: 100, rate: 15, gstPct: 12, hsnSac: '4911', isService: false },
        { lineNo: 2, kind: 'AREA', heightFt: 4, widthFt: 6, qty: 1, rate: 40, gstPct: 18, hsnSac: '998912', isService: true },
      ],
      isInterstate: false,
    });

    const goods = r.hsnSummary.find((b) => b.hsnSac === '4911')!;
    const service = r.hsnSummary.find((b) => b.hsnSac === '998912')!;

    expect(goods.isService).toBe(false);
    expect(goods.taxableValue.toFixed(2)).toBe('1500.00');
    expect(goods.cgst.toFixed(2)).toBe('90.00'); // 6% of 1500

    expect(service.isService).toBe(true);
    expect(service.taxableValue.toFixed(2)).toBe('960.00'); // 24 sq.ft × 40
    expect(service.cgst.toFixed(2)).toBe('86.40'); // 9% of 960

    expect(r.taxableValue.toFixed(2)).toBe('2460.00');
    expect(r.totalTax.toFixed(2)).toBe('352.80');
  });

  it('FR-224 — a non-GST-registered tenant suppresses tax entirely', () => {
    const r = priceDocument({
      lines: [{ lineNo: 1, kind: 'QTY', qty: 1, rate: 1000, gstPct: 18 }],
      isInterstate: false,
      taxEnabled: false,
    });
    expect(r.totalTax.toFixed(2)).toBe('0.00');
    expect(r.grandTotal.toFixed(2)).toBe('1000.00');
  });
});

describe('FR-221 — job-spec wizard add-ons feed the priced line', () => {
  it('a per-sq-ft lamination add-on is included in the line amount', () => {
    const plain = priceDocument({ lines: [flexLine({ qty: 1 })], isInterstate: false });
    const laminated = priceDocument({ lines: [flexLine({ qty: 1, addOnRate: 6 })], isInterstate: false });

    expect(plain.lines[0].grossAmount.toFixed(2)).toBe('960.00'); // 24 × 40
    expect(laminated.lines[0].grossAmount.toFixed(2)).toBe('1104.00'); // 24 × (40 + 6)
  });

  it('a flat finishing charge (e.g. eyelets) adds once per line', () => {
    const r = priceDocument({ lines: [flexLine({ qty: 1, addOnFlat: 60 })], isInterstate: false });
    expect(r.lines[0].grossAmount.toFixed(2)).toBe('1020.00');
  });
});

describe('FR-223 AC3 / FR-720 — amount in words on the priced document', () => {
  it('a grand total of Rs 1,235 reads "Rupees One Thousand Two Hundred Thirty Five Only"', () => {
    const r = priceDocument({
      lines: [{ lineNo: 1, kind: 'QTY', qty: 1, rate: 1046.27, gstPct: 18 }],
      isInterstate: false,
    });
    expect(r.grandTotal.toFixed(2)).toBe('1235.00');
    expect(r.amountInWords).toBe('Rupees One Thousand Two Hundred Thirty Five Only');
  });
});
