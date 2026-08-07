/**
 * THE SHARED PRINT-PRICING ENGINE  —  Wedge #1
 *
 * FR-210 "one shared, versioned pricing service … Quote builder and Invoice builder
 * MUST call this same engine — no duplicated pricing math."
 * BR-7  "A figure computed on a quotation must compute identically when that quote
 * becomes a jobcard and then an invoice."
 *
 * Covers FR-211 (flex sq-ft), FR-212 (media rate lookup), FR-213 (markup/margin),
 * FR-214 (line + document discount), FR-215 (rounding & minimum charge),
 * FR-223/FR-224 (GST-aware totals, place-of-supply split), FR-504/FR-505.
 *
 * Deterministic by construction: no clocks, no randomness, no I/O. Given the same
 * inputs and the same engine version it always returns byte-identical output.
 */
import { D, Decimal, Numeric, apportion, applyRounding, round2, round4, sum, RoundingMode } from '../lib/money.js';
import { amountInWords } from '../lib/indianFormat.js';

/** Stamped onto every PricingResult (FR-210) so a converted invoice can reproduce a quote. */
export const PRICING_ENGINE_VERSION = '1.0.0';

export type LineKind = 'AREA' | 'QTY';
export type MarkupMode = 'MARKUP' | 'MARGIN';
export type RateSource = 'LINE_OVERRIDE' | 'MATERIAL_MASTER' | 'RATE_CARD';

export class PricingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly lineNo?: number,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

export interface PricingLineInput {
  lineNo: number;
  /** AREA = flex/large-format square-foot pricing (FR-211); QTY = piece/sheet. */
  kind: LineKind;
  description?: string;
  hsnSac?: string | null;
  isService?: boolean;

  qty: Numeric;
  heightFt?: Numeric;
  widthFt?: Numeric;

  /** Selling rate per UOM. Wins over costRate+markup (FR-212 resolution order). */
  rate?: Numeric;
  rateSource?: RateSource;
  /** FR-213 — derive selling from cost when no explicit rate is supplied. */
  costRate?: Numeric;
  markupPct?: Numeric;
  markupMode?: MarkupMode;

  /** FR-221 — lamination/finishing add-on, per UOM (per sq.ft for AREA lines). */
  addOnRate?: Numeric;
  /** FR-221 — flat finishing add-on for the whole line. */
  addOnFlat?: Numeric;

  /** FR-211 — per-media (or global) minimum charge. */
  minCharge?: Numeric;

  /** FR-214 — line discount: percent, or an explicit amount (amount wins). */
  discountPct?: Numeric;
  discountAmt?: Numeric;

  gstPct: Numeric;
  cessPct?: Numeric;
}

export interface PricingDocumentInput {
  lines: PricingLineInput[];
  /** FR-224 — resolved treatment; true ⇒ IGST, false ⇒ CGST+SGST. */
  isInterstate: boolean;
  /** FR-224 — a non-GST-registered tenant suppresses tax lines entirely. */
  taxEnabled?: boolean;

  /** FR-214 — document-level discount (amount wins over percent). */
  docDiscountPct?: Numeric;
  docDiscountAmt?: Numeric;

  /** FR-213 — tenant default applied to lines that carry no markup of their own. */
  defaultMarkupPct?: Numeric;
  defaultMarkupMode?: MarkupMode;

  /** FR-211 — optional per-tenant round-up-to-nearest-foot (default off). */
  roundUpFeet?: boolean;
  /** FR-215 — global minimum charge fallback. */
  globalMinCharge?: Numeric;

  /** FR-112 / FR-215 */
  roundingMode?: RoundingMode;
  roundingPrecision?: number;

  /** FR-214 — discount above this percent flags the document for approval. */
  maxDiscountPct?: Numeric;
}

export interface PricedLine {
  lineNo: number;
  kind: LineKind;
  description?: string;
  hsnSac?: string | null;
  isService: boolean;

  qty: Decimal;
  heightFt: Decimal | null;
  widthFt: Decimal | null;
  /** FR-211 — area per piece, height × width. */
  areaSqft: Decimal | null;
  /** Chargeable units: area × qty for AREA lines, qty for QTY lines. */
  units: Decimal;

  costRate: Decimal | null;
  markupPct: Decimal;
  markupMode: MarkupMode;
  /** Selling rate per UOM actually used. */
  rate: Decimal;
  rateSource: RateSource;
  addOnRate: Decimal;
  addOnFlat: Decimal;

  /** Pre-discount line amount, after any minimum-charge uplift. */
  grossAmount: Decimal;
  minCharge: Decimal;
  minChargeApplied: boolean;
  /** FR-211 — the uplift actually added by the minimum charge, shown transparently. */
  minChargeUplift: Decimal;

  discountPct: Decimal;
  discountAmt: Decimal;
  docDiscountShare: Decimal;
  lineTaxable: Decimal;

  gstPct: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  cess: Decimal;
  lineTax: Decimal;
  lineTotal: Decimal;
}

export interface RateBucket {
  gstPct: Decimal;
  taxableValue: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  total: Decimal;
}

export interface HsnBucket {
  hsnSac: string;
  isService: boolean;
  gstPct: Decimal;
  qty: Decimal;
  taxableValue: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
}

export interface PricingResult {
  engineVersion: string;
  isInterstate: boolean;
  taxEnabled: boolean;
  lines: PricedLine[];

  /** Σ gross (pre-discount). */
  subtotal: Decimal;
  /** Σ line discounts + document discount. */
  discountTotal: Decimal;
  docDiscountAmt: Decimal;
  taxableValue: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  cess: Decimal;
  totalTax: Decimal;
  /** taxableValue + totalTax, before round-off. */
  computedTotal: Decimal;
  roundOff: Decimal;
  grandTotal: Decimal;
  amountInWords: string;

  /** FR-223 — rate-wise tax summary. */
  rateWiseSummary: RateBucket[];
  /** FR-506 — HSN/SAC-wise summary (goods and service lines both appear). */
  hsnSummary: HsnBucket[];

  /** FR-214 — set when the effective discount exceeds the tenant threshold. */
  needsApproval: boolean;
  effectiveDiscountPct: Decimal;
}

/**
 * FR-224 / FR-505 / BR-2 — "If the customer's place-of-supply state = the issuing
 * branch's state → CGST + SGST; otherwise → IGST."
 */
export function resolveGstTreatment(
  supplierStateCode: string | null | undefined,
  placeOfSupplyStateCode: string | null | undefined,
): { isInterstate: boolean } {
  if (!supplierStateCode) throw new PricingError('Issuing branch has no state code', 'SUPPLIER_STATE_MISSING');
  if (!placeOfSupplyStateCode) throw new PricingError('Place of supply is required', 'PLACE_OF_SUPPLY_MISSING');
  return { isInterstate: supplierStateCode.trim() !== placeOfSupplyStateCode.trim() };
}

/** FR-505 — split one line's tax. Intra-state halves the rate into CGST and SGST. */
export function splitTax(
  taxableValue: Numeric,
  gstPct: Numeric,
  isInterstate: boolean,
): { cgst: Decimal; sgst: Decimal; igst: Decimal } {
  const taxable = round2(taxableValue);
  const pct = D(gstPct);

  if (isInterstate) {
    return { cgst: new Decimal(0), sgst: new Decimal(0), igst: round2(taxable.times(pct).dividedBy(100)) };
  }
  const half = round2(taxable.times(pct.dividedBy(2)).dividedBy(100));
  return { cgst: half, sgst: half, igst: new Decimal(0) };
}

/**
 * FR-213 — derive selling rate from cost.
 *   MARKUP: selling = cost × (1 + markup/100)
 *   MARGIN: selling = cost ÷ (1 − margin/100)
 */
export function applyMarkup(costRate: Numeric, pct: Numeric, mode: MarkupMode = 'MARKUP'): Decimal {
  const cost = D(costRate);
  const p = D(pct);
  if (mode === 'MARGIN') {
    const denom = new Decimal(1).minus(p.dividedBy(100));
    if (denom.lessThanOrEqualTo(0)) {
      throw new PricingError('Target margin must be below 100%', 'MARGIN_OUT_OF_RANGE');
    }
    return round4(cost.dividedBy(denom));
  }
  return round4(cost.times(new Decimal(1).plus(p.dividedBy(100))));
}

/** FR-211 — area per piece = height × width, with the optional round-up-to-foot rule. */
export function computeArea(heightFt: Numeric, widthFt: Numeric, roundUpFeet = false): Decimal {
  let h = D(heightFt);
  let w = D(widthFt);
  if (roundUpFeet) {
    h = h.ceil();
    w = w.ceil();
  }
  return round4(h.times(w));
}

// ─────────────────────────────────────────────────────────────────────────────

export function priceDocument(input: PricingDocumentInput): PricingResult {
  const {
    lines,
    isInterstate,
    taxEnabled = true,
    roundUpFeet = false,
    roundingMode = 'NORMAL',
    roundingPrecision = 0,
  } = input;

  if (!Array.isArray(lines) || lines.length === 0) {
    throw new PricingError('A document needs at least one line', 'NO_LINES');
  }

  // ── Pass 1 · per-line rate, area, gross, minimum charge, line discount ──────
  interface Stage1 {
    src: PricingLineInput;
    areaSqft: Decimal | null;
    units: Decimal;
    costRate: Decimal | null;
    markupPct: Decimal;
    markupMode: MarkupMode;
    rate: Decimal;
    rateSource: RateSource;
    addOnRate: Decimal;
    addOnFlat: Decimal;
    grossAmount: Decimal;
    minCharge: Decimal;
    minChargeApplied: boolean;
    minChargeUplift: Decimal;
    discountPct: Decimal;
    discountAmt: Decimal;
    lineNet: Decimal;
  }

  const stage1: Stage1[] = lines.map((line) => {
    const qty = D(line.qty);
    if (qty.lessThanOrEqualTo(0)) {
      throw new PricingError('Quantity must be greater than zero', 'QTY_INVALID', line.lineNo);
    }

    // FR-211 — area for flex/large-format lines.
    let areaSqft: Decimal | null = null;
    let units: Decimal;
    if (line.kind === 'AREA') {
      if (line.heightFt === undefined || line.widthFt === undefined) {
        throw new PricingError('Height and width are required for square-foot pricing', 'DIMENSIONS_REQUIRED', line.lineNo);
      }
      const h = D(line.heightFt);
      const w = D(line.widthFt);
      if (h.lessThanOrEqualTo(0) || w.lessThanOrEqualTo(0)) {
        throw new PricingError('Height and width must be greater than zero', 'DIMENSIONS_INVALID', line.lineNo);
      }
      areaSqft = computeArea(h, w, roundUpFeet);
      units = round4(areaSqft.times(qty));
    } else {
      units = round4(qty);
    }

    // FR-212 / FR-213 — rate resolution: explicit rate → cost+markup → error.
    const markupMode: MarkupMode = line.markupMode ?? input.defaultMarkupMode ?? 'MARKUP';
    const markupPct = D(line.markupPct ?? input.defaultMarkupPct ?? 0);
    const costRate = line.costRate === undefined || line.costRate === null ? null : D(line.costRate);

    let rate: Decimal;
    let rateSource: RateSource = line.rateSource ?? 'LINE_OVERRIDE';
    if (line.rate !== undefined && line.rate !== null && line.rate !== '') {
      rate = round4(line.rate);
    } else if (costRate !== null) {
      rate = applyMarkup(costRate, markupPct, markupMode);
    } else {
      // FR-212: "If a selected material has no active rate, the line cannot be auto-priced."
      throw new PricingError(
        'No rate available for this line — set a rate on the material master or override it on the line',
        'RATE_UNAVAILABLE',
        line.lineNo,
      );
    }
    if (rate.isNegative()) throw new PricingError('Rate cannot be negative', 'RATE_INVALID', line.lineNo);

    const addOnRate = D(line.addOnRate ?? 0);
    const addOnFlat = D(line.addOnFlat ?? 0);

    // FR-221 — finishing/lamination add-ons ride on the same chargeable units.
    let grossAmount = round2(units.times(rate.plus(addOnRate)).plus(addOnFlat));

    // FR-211 / FR-215 — minimum charge, enforced at line level before discounting.
    const minCharge = round2(line.minCharge ?? input.globalMinCharge ?? 0);
    let minChargeApplied = false;
    let minChargeUplift = new Decimal(0);
    if (minCharge.greaterThan(0) && grossAmount.lessThan(minCharge)) {
      minChargeUplift = round2(minCharge.minus(grossAmount));
      grossAmount = minCharge;
      minChargeApplied = true;
    }

    // FR-214 — line discount, always pre-GST.
    const discountPct = D(line.discountPct ?? 0);
    let discountAmt: Decimal;
    if (line.discountAmt !== undefined && line.discountAmt !== null && line.discountAmt !== '') {
      discountAmt = round2(line.discountAmt);
    } else {
      discountAmt = round2(grossAmount.times(discountPct).dividedBy(100));
    }
    if (discountAmt.isNegative()) throw new PricingError('Discount cannot be negative', 'DISCOUNT_INVALID', line.lineNo);
    if (discountAmt.greaterThan(grossAmount)) {
      throw new PricingError('Discount cannot exceed the line amount', 'DISCOUNT_EXCEEDS_LINE', line.lineNo);
    }

    return {
      src: line,
      areaSqft,
      units,
      costRate,
      markupPct,
      markupMode,
      rate,
      rateSource,
      addOnRate,
      addOnFlat,
      grossAmount,
      minCharge,
      minChargeApplied,
      minChargeUplift,
      discountPct,
      discountAmt,
      lineNet: round2(grossAmount.minus(discountAmt)),
    };
  });

  // ── Pass 2 · document discount, apportioned pro-rata to line net (FR-214) ───
  const netTotal = sum(stage1.map((s) => s.lineNet));

  let docDiscountAmt: Decimal;
  if (input.docDiscountAmt !== undefined && input.docDiscountAmt !== null && input.docDiscountAmt !== '') {
    docDiscountAmt = round2(input.docDiscountAmt);
  } else {
    docDiscountAmt = round2(netTotal.times(D(input.docDiscountPct ?? 0)).dividedBy(100));
  }
  if (docDiscountAmt.isNegative()) throw new PricingError('Document discount cannot be negative', 'DISCOUNT_INVALID');
  if (docDiscountAmt.greaterThan(netTotal)) {
    throw new PricingError('Document discount cannot exceed the document value', 'DISCOUNT_EXCEEDS_DOCUMENT');
  }

  const shares = apportion(
    docDiscountAmt,
    stage1.map((s) => s.lineNet),
  );

  // ── Pass 3 · taxable value and per-head tax (FR-223 / FR-505) ───────────────
  const priced: PricedLine[] = stage1.map((s, i) => {
    const docDiscountShare = shares[i];
    const lineTaxable = round2(s.lineNet.minus(docDiscountShare));
    const gstPct = taxEnabled ? D(s.src.gstPct) : new Decimal(0);
    const cessPct = taxEnabled ? D(s.src.cessPct ?? 0) : new Decimal(0);

    const { cgst, sgst, igst } = splitTax(lineTaxable, gstPct, isInterstate);
    const cess = round2(lineTaxable.times(cessPct).dividedBy(100));
    const lineTax = round2(cgst.plus(sgst).plus(igst).plus(cess));

    return {
      lineNo: s.src.lineNo,
      kind: s.src.kind,
      description: s.src.description,
      hsnSac: s.src.hsnSac ?? null,
      isService: s.src.isService ?? true,
      qty: D(s.src.qty),
      heightFt: s.src.heightFt === undefined ? null : D(s.src.heightFt),
      widthFt: s.src.widthFt === undefined ? null : D(s.src.widthFt),
      areaSqft: s.areaSqft,
      units: s.units,
      costRate: s.costRate,
      markupPct: s.markupPct,
      markupMode: s.markupMode,
      rate: s.rate,
      rateSource: s.rateSource,
      addOnRate: s.addOnRate,
      addOnFlat: s.addOnFlat,
      grossAmount: s.grossAmount,
      minCharge: s.minCharge,
      minChargeApplied: s.minChargeApplied,
      minChargeUplift: s.minChargeUplift,
      discountPct: s.discountPct,
      discountAmt: s.discountAmt,
      docDiscountShare,
      lineTaxable,
      gstPct,
      cgst,
      sgst,
      igst,
      cess,
      lineTax,
      lineTotal: round2(lineTaxable.plus(lineTax)),
    };
  });

  // ── Pass 4 · document aggregation and round-off (FR-215 / FR-112) ───────────
  const subtotal = sum(priced.map((l) => l.grossAmount));
  const lineDiscountTotal = sum(priced.map((l) => l.discountAmt));
  const taxableValue = sum(priced.map((l) => l.lineTaxable));
  const cgst = sum(priced.map((l) => l.cgst));
  const sgst = sum(priced.map((l) => l.sgst));
  const igst = sum(priced.map((l) => l.igst));
  const cess = sum(priced.map((l) => l.cess));
  const totalTax = round2(cgst.plus(sgst).plus(igst).plus(cess));
  const computedTotal = round2(taxableValue.plus(totalTax));

  const { payable: grandTotal, roundOff } = applyRounding(computedTotal, roundingMode, roundingPrecision);

  const discountTotal = round2(lineDiscountTotal.plus(docDiscountAmt));
  const effectiveDiscountPct = subtotal.isZero()
    ? new Decimal(0)
    : round4(discountTotal.times(100).dividedBy(subtotal));
  const maxDiscountPct = input.maxDiscountPct === undefined ? null : D(input.maxDiscountPct);
  const needsApproval = maxDiscountPct !== null && effectiveDiscountPct.greaterThan(maxDiscountPct);

  // FR-223 — rate-wise tax summary.
  const rateMap = new Map<string, RateBucket>();
  for (const l of priced) {
    const key = l.gstPct.toFixed(4);
    const bucket =
      rateMap.get(key) ??
      ({
        gstPct: l.gstPct,
        taxableValue: new Decimal(0),
        cgst: new Decimal(0),
        sgst: new Decimal(0),
        igst: new Decimal(0),
        total: new Decimal(0),
      } as RateBucket);
    bucket.taxableValue = round2(bucket.taxableValue.plus(l.lineTaxable));
    bucket.cgst = round2(bucket.cgst.plus(l.cgst));
    bucket.sgst = round2(bucket.sgst.plus(l.sgst));
    bucket.igst = round2(bucket.igst.plus(l.igst));
    bucket.total = round2(bucket.taxableValue.plus(bucket.cgst).plus(bucket.sgst).plus(bucket.igst));
    rateMap.set(key, bucket);
  }

  // FR-506 — HSN/SAC-wise summary across goods and service lines.
  const hsnMap = new Map<string, HsnBucket>();
  for (const l of priced) {
    const code = l.hsnSac ?? '—';
    const key = `${code}|${l.gstPct.toFixed(4)}`;
    const bucket =
      hsnMap.get(key) ??
      ({
        hsnSac: code,
        isService: l.isService,
        gstPct: l.gstPct,
        qty: new Decimal(0),
        taxableValue: new Decimal(0),
        cgst: new Decimal(0),
        sgst: new Decimal(0),
        igst: new Decimal(0),
      } as HsnBucket);
    bucket.qty = round4(bucket.qty.plus(l.units));
    bucket.taxableValue = round2(bucket.taxableValue.plus(l.lineTaxable));
    bucket.cgst = round2(bucket.cgst.plus(l.cgst));
    bucket.sgst = round2(bucket.sgst.plus(l.sgst));
    bucket.igst = round2(bucket.igst.plus(l.igst));
    hsnMap.set(key, bucket);
  }

  return {
    engineVersion: PRICING_ENGINE_VERSION,
    isInterstate,
    taxEnabled,
    lines: priced,
    subtotal,
    discountTotal,
    docDiscountAmt,
    taxableValue,
    cgst,
    sgst,
    igst,
    cess,
    totalTax,
    computedTotal,
    roundOff,
    grandTotal,
    amountInWords: amountInWords(grandTotal),
    rateWiseSummary: [...rateMap.values()].sort((a, b) => a.gstPct.comparedTo(b.gstPct)),
    hsnSummary: [...hsnMap.values()].sort((a, b) => a.hsnSac.localeCompare(b.hsnSac)),
    needsApproval,
    effectiveDiscountPct,
  };
}

/** Convenience: JSON-safe view of a PricingResult (all decimals as fixed strings). */
export function serializePricing(result: PricingResult) {
  const m = (d: Decimal) => d.toFixed(2);
  const r = (d: Decimal | null) => (d === null ? null : d.toFixed(4));
  return {
    engineVersion: result.engineVersion,
    isInterstate: result.isInterstate,
    taxEnabled: result.taxEnabled,
    lines: result.lines.map((l) => ({
      lineNo: l.lineNo,
      kind: l.kind,
      description: l.description,
      hsnSac: l.hsnSac,
      isService: l.isService,
      qty: r(l.qty),
      heightFt: r(l.heightFt),
      widthFt: r(l.widthFt),
      areaSqft: r(l.areaSqft),
      units: r(l.units),
      costRate: r(l.costRate),
      markupPct: r(l.markupPct),
      markupMode: l.markupMode,
      rate: r(l.rate),
      rateSource: l.rateSource,
      addOnRate: r(l.addOnRate),
      addOnFlat: m(l.addOnFlat),
      grossAmount: m(l.grossAmount),
      minCharge: m(l.minCharge),
      minChargeApplied: l.minChargeApplied,
      minChargeUplift: m(l.minChargeUplift),
      discountPct: r(l.discountPct),
      discountAmt: m(l.discountAmt),
      docDiscountShare: m(l.docDiscountShare),
      lineTaxable: m(l.lineTaxable),
      gstPct: r(l.gstPct),
      cgst: m(l.cgst),
      sgst: m(l.sgst),
      igst: m(l.igst),
      cess: m(l.cess),
      lineTax: m(l.lineTax),
      lineTotal: m(l.lineTotal),
    })),
    subtotal: m(result.subtotal),
    discountTotal: m(result.discountTotal),
    docDiscountAmt: m(result.docDiscountAmt),
    taxableValue: m(result.taxableValue),
    cgst: m(result.cgst),
    sgst: m(result.sgst),
    igst: m(result.igst),
    cess: m(result.cess),
    totalTax: m(result.totalTax),
    computedTotal: m(result.computedTotal),
    roundOff: m(result.roundOff),
    grandTotal: m(result.grandTotal),
    amountInWords: result.amountInWords,
    rateWiseSummary: result.rateWiseSummary.map((b) => ({
      gstPct: r(b.gstPct),
      taxableValue: m(b.taxableValue),
      cgst: m(b.cgst),
      sgst: m(b.sgst),
      igst: m(b.igst),
      total: m(b.total),
    })),
    hsnSummary: result.hsnSummary.map((b) => ({
      hsnSac: b.hsnSac,
      isService: b.isService,
      gstPct: r(b.gstPct),
      qty: r(b.qty),
      taxableValue: m(b.taxableValue),
      cgst: m(b.cgst),
      sgst: m(b.sgst),
      igst: m(b.igst),
    })),
    needsApproval: result.needsApproval,
    effectiveDiscountPct: r(result.effectiveDiscountPct),
  };
}
