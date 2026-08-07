/**
 * Quotation services — FRD §4.2/§4.3/§4.4 (FR-210 … FR-233).
 *
 * BR-7 / FR-210 — every rupee on a quotation is produced by `priceDocument()`
 * in `src/engine/pricing.ts`. This module maps HTTP payloads onto that engine's
 * input, persists its output verbatim, and never re-derives a total.
 * BR-1  — decimals in, decimal strings out; Prisma columns take `.toFixed(n)`.
 * BR-3  — quote numbers are allocated at finalisation, never on a draft.
 * BR-4  — every query filters on `tenantId`; branch-scoped reads assert access.
 */
import type {
  Branch,
  Customer,
  Enquiry,
  FinancialYear,
  Prisma,
  Quote,
  QuoteLine,
  ShareChannel,
} from '@prisma/client';
import { prisma } from '../../db.js';
import { type AuthContext, assertBranchAccess } from '../../auth/middleware.js';
import { AppError, conflict, notFound, unprocessable } from '../../http/errors.js';
import { D, money, rate as rate4, sum } from '../../lib/money.js';
import { STATE_CODES } from '../../lib/gstin.js';
import { addDays, tenantToday, toDateOnly } from '../../lib/fy.js';
import { allocateNumber } from '../../lib/numbering.js';
import { amountInWords, formatCurrency } from '../../lib/indianFormat.js';
import { PRICING_ENGINE_VERSION, priceDocument, serializePricing, type PricingResult } from '../../engine/pricing.js';
import { recordAudit } from '../setup/audit.js';
import { createJobcardFromQuote } from '../production/service.js';
import {
  buildDocumentInput,
  loadPricingContext,
  resolveLines,
  resolveTreatment,
  type PricingContext,
  type ResolvedLine,
} from './pricingAdapter.js';
import type {
  PricePreviewInput,
  QuoteCloneInput,
  QuoteCreateInput,
  QuoteLineInput,
  QuoteListQuery,
  QuoteSendInput,
  QuoteStatusChangeInput,
  QuoteUpdateInput,
} from './schemas.js';

type Client = Prisma.TransactionClient;

// ─────────────────────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────────────────────

type DecimalLike = { toString(): string } | null | undefined;

const m2 = (v: DecimalLike): string => money(v === null || v === undefined ? '0' : v.toString());
const r4 = (v: DecimalLike): string => rate4(v === null || v === undefined ? '0' : v.toString());
const r4n = (v: DecimalLike): string | null => (v === null || v === undefined ? null : rate4(v.toString()));

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const isoDateN = (d: Date | null): string | null => (d === null ? null : isoDate(d));
const isoTs = (d: Date): string => d.toISOString();
const isoTsN = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const parseIsoDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const stateName = (code: string | null | undefined): string | null =>
  code ? STATE_CODES[code] ?? null : null;

function nullable(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

const QUOTE_INCLUDE = {
  lines: { orderBy: { lineNo: 'asc' } },
  customer: true,
  branch: true,
  fy: true,
  enquiry: true,
  jobcards: { select: { id: true, jobcardNo: true, overallStatus: true } },
} satisfies Prisma.QuoteInclude;

export type QuoteRecord = Quote & {
  lines: QuoteLine[];
  customer: Customer;
  branch: Branch;
  fy: FinancialYear;
  enquiry?: Enquiry | null;
  jobcards?: Array<{ id: string; jobcardNo: string; overallStatus: string }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Serialisers — BR-1: every decimal leaves as a fixed-decimal string
// ─────────────────────────────────────────────────────────────────────────────

export function serializeQuoteLine(l: QuoteLine) {
  return {
    id: l.id,
    lineNo: l.lineNo,
    description: l.description,
    /** FR-221 — the captured job spec. */
    spec: l.specJson,
    hsnSac: l.hsnSac,
    isService: l.isService,
    qty: r4(l.qty),
    uomCode: l.uomCode,
    heightFt: r4n(l.heightFt),
    widthFt: r4n(l.widthFt),
    areaSqft: r4n(l.areaSqft),
    materialId: l.materialId,
    rateCardId: l.rateCardId,
    /** FR-212 — provenance of the rate actually used. */
    rateSource: l.rateSource,
    costRate: r4n(l.costRate),
    markupPct: r4(l.markupPct),
    markupMode: l.markupMode,
    rate: r4(l.rate),
    addOnRate: r4(l.addOnRate),
    addOnFlat: m2(l.addOnFlat),
    grossAmount: m2(l.grossAmount),
    minCharge: m2(l.minCharge),
    /** FR-211 — the minimum-charge uplift, shown transparently. */
    minChargeApplied: l.minChargeApplied,
    discountPct: r4(l.discountPct),
    discountAmt: m2(l.discountAmt),
    docDiscountShare: m2(l.docDiscountShare),
    lineTaxable: m2(l.lineTaxable),
    gstPct: r4(l.gstPct),
    cgst: m2(l.cgst),
    sgst: m2(l.sgst),
    igst: m2(l.igst),
    lineTax: m2(l.lineTax),
    lineTotal: m2(l.lineTotal),
  };
}

/**
 * FR-223 — rate-wise tax summary, aggregated from the values the engine already
 * stamped on each line. No tax is recomputed here.
 */
export function rateWiseSummary(lines: QuoteLine[]) {
  const keys = [...new Set(lines.map((l) => r4(l.gstPct)))].sort((a, b) => D(a).comparedTo(D(b)));
  return keys.map((key) => {
    const group = lines.filter((l) => r4(l.gstPct) === key);
    const taxableValue = sum(group.map((l) => l.lineTaxable.toString()));
    const cgst = sum(group.map((l) => l.cgst.toString()));
    const sgst = sum(group.map((l) => l.sgst.toString()));
    const igst = sum(group.map((l) => l.igst.toString()));
    return {
      gstPct: key,
      taxableValue: money(taxableValue),
      cgst: money(cgst),
      sgst: money(sgst),
      igst: money(igst),
      total: money(sum([taxableValue, cgst, sgst, igst])),
    };
  });
}

/** FR-506-style HSN/SAC roll-up for the printable document. */
function hsnSummary(lines: QuoteLine[]) {
  const keyOf = (l: QuoteLine) => `${l.hsnSac ?? '—'}|${r4(l.gstPct)}`;
  const keys = [...new Set(lines.map(keyOf))].sort((a, b) => a.localeCompare(b));
  return keys.map((key) => {
    const group = lines.filter((l) => keyOf(l) === key);
    const first = group[0];
    const taxableValue = sum(group.map((l) => l.lineTaxable.toString()));
    return {
      hsnSac: first.hsnSac ?? '—',
      isService: first.isService,
      gstPct: r4(first.gstPct),
      uomCode: first.uomCode,
      qty: rate4(sum(group.map((l) => l.qty.toString()))),
      taxableValue: money(taxableValue),
      cgst: money(sum(group.map((l) => l.cgst.toString()))),
      sgst: money(sum(group.map((l) => l.sgst.toString()))),
      igst: money(sum(group.map((l) => l.igst.toString()))),
    };
  });
}

export function serializeQuote(q: QuoteRecord) {
  const totalTax = sum([q.cgst.toString(), q.sgst.toString(), q.igst.toString(), q.cess.toString()]);
  const jobcard = q.jobcards && q.jobcards.length > 0 ? q.jobcards[0] : null;

  return {
    id: q.id,
    /** BR-3 — null until the quote is finalised/sent. */
    quoteNo: q.quoteNo,
    quoteDate: isoDate(q.quoteDate),
    status: q.status,
    validUntil: isoDateN(q.validUntil),
    branchId: q.branchId,
    branch: {
      id: q.branch.id,
      branchCode: q.branch.branchCode,
      name: q.branch.name,
      stateCode: q.branch.stateCode,
      stateName: stateName(q.branch.stateCode),
      gstin: q.branch.gstin,
    },
    fyId: q.fyId,
    fy: { id: q.fy.id, fyLabel: q.fy.fyLabel },
    customerId: q.customerId,
    customer: {
      id: q.customer.id,
      name: q.customer.name,
      customerType: q.customer.customerType,
      gstin: q.customer.gstin,
      phone: q.customer.phone,
      email: q.customer.email,
      placeOfSupplyState: q.customer.placeOfSupplyState,
    },
    enquiryId: q.enquiryId,
    enquiry: q.enquiry
      ? {
          id: q.enquiry.id,
          status: q.enquiry.status,
          source: q.enquiry.source,
          contactName: q.enquiry.contactName,
          phone: q.enquiry.phone,
          vertical: q.enquiry.vertical,
        }
      : null,

    // FR-224 — resolved GST treatment.
    placeOfSupplyState: q.placeOfSupplyState,
    placeOfSupplyStateName: stateName(q.placeOfSupplyState),
    supplierStateCode: q.supplierStateCode,
    isInterstate: q.isInterstate,
    taxTreatment: q.isInterstate ? ('IGST' as const) : ('CGST_SGST' as const),

    // FR-214 / FR-215 / FR-223 — engine output, stored verbatim.
    docDiscountPct: r4(q.docDiscountPct),
    docDiscountAmt: m2(q.docDiscountAmt),
    subtotal: m2(q.subtotal),
    discountTotal: m2(q.discountTotal),
    taxableValue: m2(q.taxableValue),
    cgst: m2(q.cgst),
    sgst: m2(q.sgst),
    igst: m2(q.igst),
    cess: m2(q.cess),
    totalTax: money(totalTax),
    roundOff: m2(q.roundOff),
    grandTotal: m2(q.grandTotal),
    amountInWords: q.amountInWords,
    /** FR-210 — stamped so the invoice can reproduce these numbers. */
    engineVersion: q.engineVersion,
    needsApproval: q.needsApproval,
    approvedBy: q.approvedBy,
    approvedAt: isoTsN(q.approvedAt),

    lostReason: q.lostReason,
    notes: q.notes,
    terms: q.terms,
    clonedFrom: q.clonedFrom,
    sentAt: isoTsN(q.sentAt),
    sentVia: q.sentVia,
    wonAt: isoTsN(q.wonAt),
    createdBy: q.createdBy,
    createdAt: isoTs(q.createdAt),
    updatedAt: isoTs(q.updatedAt),

    lines: q.lines.map(serializeQuoteLine),
    rateWiseSummary: rateWiseSummary(q.lines),
    jobcard,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadQuote(auth: AuthContext, id: string, client: Client = prisma): Promise<QuoteRecord> {
  // BR-4 — another tenant's quote is indistinguishable from one that never existed.
  const quote = await client.quote.findFirst({ where: { id, tenantId: auth.tenantId }, include: QUOTE_INCLUDE });
  if (!quote) throw notFound('Quotation not found');
  assertBranchAccess(auth, quote.branchId); // FR-717
  return quote;
}

async function loadCustomer(auth: AuthContext, customerId: string, client: Client = prisma): Promise<Customer> {
  const customer = await client.customer.findFirst({ where: { id: customerId, tenantId: auth.tenantId } });
  if (!customer) throw unprocessable('Unknown customer', 'UNKNOWN_CUSTOMER');
  return customer;
}

/** FR-104 — the FY that contains the document date. */
async function resolveFy(tenantId: string, date: Date, client: Client = prisma): Promise<FinancialYear> {
  const day = toDateOnly(date);
  const fy = await client.financialYear.findFirst({
    where: { tenantId, startDate: { lte: day }, endDate: { gte: day } },
  });
  if (fy) return fy;
  throw unprocessable(
    `No financial year covers ${isoDate(day)} — add one in Settings → Financial Years`,
    'FY_NOT_CONFIGURED',
  );
}

/**
 * FR-106 — series are configured per (docType, branch, fy); the setup wizard
 * seeds a tenant-wide one. Pick the most specific configured scope.
 */
async function resolveSeriesScope(
  tx: Client,
  tenantId: string,
  branchId: string,
  fyId: string,
): Promise<{ branchId: string | null; fyId: string | null }> {
  const candidates: Array<{ branchId: string | null; fyId: string | null }> = [
    { branchId, fyId },
    { branchId, fyId: null },
    { branchId: null, fyId },
    { branchId: null, fyId: null },
  ];
  for (const scope of candidates) {
    const found = await tx.numberingSeries.findFirst({
      where: { tenantId, docType: 'QUOTATION', branchId: scope.branchId, fyId: scope.fyId, active: true },
      select: { id: true },
    });
    if (found) return scope;
  }
  // Nothing configured — allocateNumber raises NUMBERING_SERIES_MISSING with guidance.
  return { branchId: null, fyId: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence of engine output
// ─────────────────────────────────────────────────────────────────────────────

interface HeaderTotals {
  isInterstate: boolean;
  docDiscountPct: string;
  docDiscountAmt: string;
  subtotal: string;
  discountTotal: string;
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  roundOff: string;
  grandTotal: string;
  amountInWords: string;
  engineVersion: string;
  needsApproval: boolean;
}

/** An empty draft has nothing to price yet (FR-222 — "saved incomplete"). */
function emptyTotals(isInterstate: boolean, docDiscountPct: string): HeaderTotals {
  const zero = D(0);
  return {
    isInterstate,
    docDiscountPct,
    docDiscountAmt: zero.toFixed(2),
    subtotal: zero.toFixed(2),
    discountTotal: zero.toFixed(2),
    taxableValue: zero.toFixed(2),
    cgst: zero.toFixed(2),
    sgst: zero.toFixed(2),
    igst: zero.toFixed(2),
    cess: zero.toFixed(2),
    roundOff: zero.toFixed(2),
    grandTotal: zero.toFixed(2),
    amountInWords: amountInWords(zero),
    engineVersion: PRICING_ENGINE_VERSION,
    needsApproval: false,
  };
}

function headerTotals(result: PricingResult, docDiscountPct: string): HeaderTotals {
  return {
    isInterstate: result.isInterstate,
    docDiscountPct,
    docDiscountAmt: result.docDiscountAmt.toFixed(2),
    subtotal: result.subtotal.toFixed(2),
    discountTotal: result.discountTotal.toFixed(2),
    taxableValue: result.taxableValue.toFixed(2),
    cgst: result.cgst.toFixed(2),
    sgst: result.sgst.toFixed(2),
    igst: result.igst.toFixed(2),
    cess: result.cess.toFixed(2),
    roundOff: result.roundOff.toFixed(2),
    grandTotal: result.grandTotal.toFixed(2),
    amountInWords: result.amountInWords,
    engineVersion: result.engineVersion,
    needsApproval: result.needsApproval,
  };
}

/** Replace a quote's lines with the engine's priced output, field for field. */
async function writeLines(
  tx: Client,
  tenantId: string,
  quoteId: string,
  result: PricingResult | null,
  resolved: ResolvedLine[],
): Promise<void> {
  await tx.quoteLine.deleteMany({ where: { quoteId, tenantId } });
  if (!result) return;

  for (let i = 0; i < result.lines.length; i++) {
    const priced = result.lines[i];
    const meta = resolved[i];
    await tx.quoteLine.create({
      data: {
        tenantId,
        quoteId,
        lineNo: priced.lineNo,
        description: priced.description ?? meta.description,
        specJson: meta.spec as unknown as Prisma.InputJsonValue,
        hsnSac: priced.hsnSac,
        isService: priced.isService,
        qty: priced.qty.toFixed(4),
        uomCode: meta.uomCode,
        heightFt: priced.heightFt === null ? null : priced.heightFt.toFixed(4),
        widthFt: priced.widthFt === null ? null : priced.widthFt.toFixed(4),
        areaSqft: priced.areaSqft === null ? null : priced.areaSqft.toFixed(4),
        materialId: meta.materialId,
        rateCardId: meta.rateCardId,
        rateSource: priced.rateSource,
        costRate: priced.costRate === null ? null : priced.costRate.toFixed(4),
        markupPct: priced.markupPct.toFixed(4),
        markupMode: priced.markupMode,
        rate: priced.rate.toFixed(4),
        addOnRate: priced.addOnRate.toFixed(4),
        addOnFlat: priced.addOnFlat.toFixed(2),
        grossAmount: priced.grossAmount.toFixed(2),
        minCharge: priced.minCharge.toFixed(2),
        minChargeApplied: priced.minChargeApplied,
        discountPct: priced.discountPct.toFixed(4),
        discountAmt: priced.discountAmt.toFixed(2),
        docDiscountShare: priced.docDiscountShare.toFixed(2),
        lineTaxable: priced.lineTaxable.toFixed(2),
        gstPct: priced.gstPct.toFixed(4),
        cgst: priced.cgst.toFixed(2),
        sgst: priced.sgst.toFixed(2),
        igst: priced.igst.toFixed(2),
        lineTax: priced.lineTax.toFixed(2),
        lineTotal: priced.lineTotal.toFixed(2),
      },
    });
  }
}

/**
 * FR-222 — "Any edit triggers recomputation of that line then re-aggregation."
 * Every mutation funnels through here; the engine is the only source of totals.
 */
async function price(
  auth: AuthContext,
  ctx: PricingContext,
  lines: QuoteLineInput[],
  args: { placeOfSupplyState: string | null; docDiscountPct?: string | null; docDiscountAmt?: string | null },
  client: Client = prisma,
): Promise<{ result: PricingResult | null; resolved: ResolvedLine[]; isInterstate: boolean }> {
  const isInterstate = resolveTreatment(ctx, args.placeOfSupplyState);
  if (lines.length === 0) return { result: null, resolved: [], isInterstate };

  const resolved = await resolveLines(auth, lines, client);
  const result = priceDocument(
    buildDocumentInput(ctx, resolved, {
      isInterstate,
      docDiscountPct: args.docDiscountPct,
      docDiscountAmt: args.docDiscountAmt,
    }),
  );
  return { result, resolved, isInterstate };
}

/**
 * Rebuild engine input from stored lines. Lines priced off a master re-resolve
 * their rate (FR-231 — "re-prices through the current engine/rate versions");
 * an explicit line override is a captured input and is preserved.
 */
function storedLineToInput(l: QuoteLine): QuoteLineInput {
  const fromMaster = l.rateSource !== 'LINE_OVERRIDE' && (l.materialId !== null || l.rateCardId !== null);
  const spec = (l.specJson ?? null) as unknown as QuoteLineInput['spec'];
  const discountPct = D(l.discountPct.toString());
  const discountAmt = D(l.discountAmt.toString());

  return {
    lineNo: l.lineNo,
    kind: l.heightFt !== null && l.widthFt !== null ? 'AREA' : 'QTY',
    description: l.description,
    isService: l.isService,
    qty: l.qty.toString(),
    uomCode: l.uomCode,
    heightFt: l.heightFt === null ? undefined : l.heightFt.toString(),
    widthFt: l.widthFt === null ? undefined : l.widthFt.toString(),
    materialId: l.materialId,
    rateCardId: l.rateCardId,
    // Masters re-supply rate / HSN / GST / min-charge; overrides are kept.
    ...(fromMaster
      ? {}
      : {
          rate: l.rate.toString(),
          hsnSac: l.hsnSac,
          gstPct: l.gstPct.toString(),
          minCharge: l.minCharge.toString(),
        }),
    ...(l.costRate !== null && l.rateSource === 'LINE_OVERRIDE' ? { costRate: l.costRate.toString() } : {}),
    markupPct: l.markupPct.toString(),
    markupMode: l.markupMode,
    addOnRate: l.addOnRate.toString(),
    addOnFlat: l.addOnFlat.toString(),
    // FR-214 — a percentage discount stays a percentage so it re-applies to a new base.
    ...(discountPct.isZero()
      ? discountAmt.isZero()
        ? {}
        : { discountAmt: l.discountAmt.toString() }
      : { discountPct: l.discountPct.toString() }),
    spec,
  };
}

function storedDocDiscount(q: Quote): { docDiscountPct?: string; docDiscountAmt?: string } {
  const pct = D(q.docDiscountPct.toString());
  if (!pct.isZero()) return { docDiscountPct: q.docDiscountPct.toString() };
  const amt = D(q.docDiscountAmt.toString());
  return amt.isZero() ? {} : { docDiscountAmt: q.docDiscountAmt.toString() };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-210 / FR-222 — stateless price preview
// ─────────────────────────────────────────────────────────────────────────────

/** What the web quote builder calls on every keystroke. Persists nothing. */
export async function previewPrice(auth: AuthContext, input: PricePreviewInput) {
  const ctx = await loadPricingContext(auth, input.branchId);

  let placeOfSupplyState = input.placeOfSupplyState ?? null;
  let customer: Customer | null = null;
  if (input.customerId) {
    customer = await loadCustomer(auth, input.customerId);
    // FR-224 — "place_of_supply defaults from the customer's state".
    if (!placeOfSupplyState) placeOfSupplyState = customer.placeOfSupplyState;
  }

  const isInterstate = resolveTreatment(ctx, placeOfSupplyState, { required: true });
  const resolved = await resolveLines(auth, input.lines);
  const result = priceDocument(
    buildDocumentInput(ctx, resolved, {
      isInterstate,
      docDiscountPct: input.docDiscountPct,
      docDiscountAmt: input.docDiscountAmt,
    }),
  );

  return {
    // The engine's own serialisation, verbatim (FR-210).
    ...serializePricing(result),
    branchId: ctx.branch.id,
    supplierStateCode: ctx.branch.stateCode,
    placeOfSupplyState,
    placeOfSupplyStateName: stateName(placeOfSupplyState),
    taxTreatment: isInterstate ? ('IGST' as const) : ('CGST_SGST' as const),
    customerId: customer?.id ?? null,
    /** FR-212 / FR-221 — what the adapter resolved, so the builder can echo it. */
    resolvedLines: resolved.map((r) => ({
      lineNo: r.lineNo,
      description: r.description,
      spec: r.spec,
      uomCode: r.uomCode,
      hsnSac: r.hsnSac,
      materialId: r.materialId,
      rateCardId: r.rateCardId,
      rateSource: r.rateSource,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

export interface Paged<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export async function listQuotes(auth: AuthContext, query: QuoteListQuery) {
  const where: Prisma.QuoteWhereInput = {
    tenantId: auth.tenantId, // BR-4
    ...(auth.allBranches || auth.branchIds.length === 0 ? {} : { branchId: { in: auth.branchIds } }),
    ...(query.status ? { status: query.status } : {}),
    ...(query.customerId ? { customerId: query.customerId } : {}),
    ...(query.enquiryId ? { enquiryId: query.enquiryId } : {}),
    ...(query.branchId ? { branchId: query.branchId } : {}),
    ...(query.from || query.to
      ? {
          quoteDate: {
            ...(query.from ? { gte: parseIsoDate(query.from) } : {}),
            ...(query.to ? { lte: parseIsoDate(query.to) } : {}),
          },
        }
      : {}),
    ...(query.q
      ? {
          OR: [
            { quoteNo: { contains: query.q, mode: 'insensitive' } },
            { customer: { name: { contains: query.q, mode: 'insensitive' } } },
            { customer: { phone: { contains: query.q } } },
            { notes: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  if (query.branchId) assertBranchAccess(auth, query.branchId);

  const [rows, total] = await Promise.all([
    prisma.quote.findMany({
      where,
      include: QUOTE_INCLUDE,
      orderBy: [{ quoteDate: 'desc' }, { createdAt: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.quote.count({ where }),
  ]);

  return { data: rows.map(serializeQuote), page: query.page, pageSize: query.pageSize, total };
}

export async function getQuote(auth: AuthContext, id: string) {
  return serializeQuote(await loadQuote(auth, id));
}

export async function createQuote(auth: AuthContext, input: QuoteCreateInput) {
  const ctx = await loadPricingContext(auth, input.branchId ?? undefined);
  const customer = await loadCustomer(auth, input.customerId);
  const quoteDate = input.quoteDate ? parseIsoDate(input.quoteDate) : tenantToday();
  const fy = await resolveFy(auth.tenantId, quoteDate);

  // FR-224 — default from the customer; an explicit null clears it.
  const placeOfSupplyState =
    input.placeOfSupplyState !== undefined ? input.placeOfSupplyState : customer.placeOfSupplyState;

  const lines = input.lines ?? [];
  const { result, resolved, isInterstate } = await price(auth, ctx, lines, {
    placeOfSupplyState,
    docDiscountPct: input.docDiscountPct,
    docDiscountAmt: input.docDiscountAmt,
  });

  const docDiscountPct = input.docDiscountPct ?? '0';
  const totals = result ? headerTotals(result, docDiscountPct) : emptyTotals(isInterstate, docDiscountPct);

  // FR-230 — validity defaults from the tenant setting and stays editable.
  const validUntil = input.validUntil
    ? parseIsoDate(input.validUntil)
    : addDays(toDateOnly(quoteDate), ctx.tenant.quoteValidityDays);

  const created = await prisma.$transaction(async (tx) => {
    if (input.enquiryId) await assertEnquiry(tx, auth.tenantId, input.enquiryId);

    const quote = await tx.quote.create({
      data: {
        tenantId: auth.tenantId,
        branchId: ctx.branch.id,
        fyId: fy.id,
        // BR-3 — no number on a draft.
        quoteNo: null,
        quoteDate: toDateOnly(quoteDate),
        customerId: customer.id,
        enquiryId: input.enquiryId ?? null,
        placeOfSupplyState,
        supplierStateCode: ctx.branch.stateCode,
        status: 'DRAFT',
        validUntil,
        notes: nullable(input.notes),
        terms: nullable(input.terms),
        createdBy: auth.userId,
        ...totals,
      },
    });

    await writeLines(tx, auth.tenantId, quote.id, result, resolved);

    // FR-220 — "Converting sets the enquiry status to Quoted."
    if (input.enquiryId) {
      await tx.enquiry.updateMany({
        where: { id: input.enquiryId, tenantId: auth.tenantId, status: { in: ['NEW', 'CONTACTED'] } },
        data: { status: 'QUOTED' },
      });
    }

    return tx.quote.findFirstOrThrow({ where: { id: quote.id }, include: QUOTE_INCLUDE });
  });

  const dto = serializeQuote(created);
  await recordAudit({
    tenantId: auth.tenantId,
    branchId: ctx.branch.id,
    actorId: auth.userId,
    entityType: 'Quote',
    entityId: created.id,
    action: 'CREATE',
    after: dto,
  });
  return dto;
}

async function assertEnquiry(tx: Client, tenantId: string, enquiryId: string): Promise<void> {
  const enquiry = await tx.enquiry.findFirst({ where: { id: enquiryId, tenantId }, select: { id: true } });
  if (!enquiry) throw unprocessable('Unknown enquiry', 'UNKNOWN_ENQUIRY');
}

/** FR-230 — "Won/Lost are terminal for that quote." */
function assertEditable(quote: Quote): void {
  if (quote.status === 'WON' || quote.status === 'LOST') {
    throw conflict(
      `This quotation is ${quote.status} and can no longer be edited — clone it to re-quote (FR-231)`,
      'QUOTE_TERMINAL',
    );
  }
}

export async function updateQuote(auth: AuthContext, id: string, patch: QuoteUpdateInput) {
  const existing = await loadQuote(auth, id);
  assertEditable(existing);
  const before = serializeQuote(existing);

  const ctx = await loadPricingContext(auth, patch.branchId ?? existing.branchId);
  const customer =
    patch.customerId && patch.customerId !== existing.customerId
      ? await loadCustomer(auth, patch.customerId)
      : existing.customer;

  const quoteDate = patch.quoteDate ? parseIsoDate(patch.quoteDate) : existing.quoteDate;
  const fy = patch.quoteDate ? await resolveFy(auth.tenantId, quoteDate) : existing.fy;

  const placeOfSupplyState =
    patch.placeOfSupplyState !== undefined
      ? patch.placeOfSupplyState
      : patch.customerId && patch.customerId !== existing.customerId
        ? customer.placeOfSupplyState
        : existing.placeOfSupplyState;

  const lines = patch.lines !== undefined ? patch.lines : existing.lines.map(storedLineToInput);
  const stored = storedDocDiscount(existing);
  const docDiscountPct =
    patch.docDiscountPct !== undefined
      ? patch.docDiscountPct
      : patch.docDiscountAmt !== undefined
        ? null
        : stored.docDiscountPct ?? null;
  const docDiscountAmt =
    patch.docDiscountAmt !== undefined
      ? patch.docDiscountAmt
      : patch.docDiscountPct !== undefined
        ? null
        : stored.docDiscountAmt ?? null;

  // FR-222 — recompute on every mutation; client totals are never trusted.
  const { result, resolved, isInterstate } = await price(auth, ctx, lines, {
    placeOfSupplyState,
    docDiscountPct,
    docDiscountAmt,
  });
  const totals = result
    ? headerTotals(result, docDiscountPct ?? '0')
    : emptyTotals(isInterstate, docDiscountPct ?? '0');

  const updated = await prisma.$transaction(async (tx) => {
    if (patch.enquiryId) await assertEnquiry(tx, auth.tenantId, patch.enquiryId);

    await tx.quote.update({
      where: { id },
      data: {
        branchId: ctx.branch.id,
        fyId: fy.id,
        quoteDate: toDateOnly(quoteDate),
        customerId: customer.id,
        ...(patch.enquiryId !== undefined ? { enquiryId: patch.enquiryId } : {}),
        placeOfSupplyState,
        supplierStateCode: ctx.branch.stateCode,
        ...(patch.validUntil !== undefined
          ? { validUntil: patch.validUntil ? parseIsoDate(patch.validUntil) : null }
          : {}),
        ...(patch.notes !== undefined ? { notes: nullable(patch.notes) } : {}),
        ...(patch.terms !== undefined ? { terms: nullable(patch.terms) } : {}),
        ...totals,
      },
    });

    await writeLines(tx, auth.tenantId, id, result, resolved);

    if (patch.enquiryId) {
      await tx.enquiry.updateMany({
        where: { id: patch.enquiryId, tenantId: auth.tenantId, status: { in: ['NEW', 'CONTACTED'] } },
        data: { status: 'QUOTED' },
      });
    }

    return tx.quote.findFirstOrThrow({ where: { id }, include: QUOTE_INCLUDE });
  });

  const dto = serializeQuote(updated);
  await recordAudit({
    tenantId: auth.tenantId,
    branchId: updated.branchId,
    actorId: auth.userId,
    entityType: 'Quote',
    entityId: id,
    action: 'UPDATE',
    before,
    after: dto,
  });
  return dto;
}

/**
 * BR-3 / BR-11 — a numbered quotation is never destroyed (its number must stay
 * consumed); only an un-numbered draft can be removed.
 */
export async function deleteQuote(auth: AuthContext, id: string) {
  const existing = await loadQuote(auth, id);

  if (existing.status !== 'DRAFT' || existing.quoteNo !== null) {
    throw conflict(
      'A finalised quotation cannot be deleted — mark it Lost or let it expire so its number stays consumed',
      'QUOTE_NOT_DELETABLE',
    );
  }
  if ((existing.jobcards ?? []).length > 0) {
    throw conflict('This quotation has a jobcard and cannot be deleted', 'HAS_REFERENCES');
  }

  await prisma.quote.delete({ where: { id } });
  await recordAudit({
    tenantId: auth.tenantId,
    branchId: existing.branchId,
    actorId: auth.userId,
    entityType: 'Quote',
    entityId: id,
    action: 'DELETE',
    before: serializeQuote(existing),
  });
  return { id, deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-226 / FR-230 — share and finalise
// ─────────────────────────────────────────────────────────────────────────────

const CHANNEL_LABEL: Record<ShareChannel, string> = {
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
  SMS: 'SMS',
};

/** FR-226 — "an approved template with quote number, amount, validity and a link". */
function shareBody(quoteNo: string, grandTotal: string, validUntil: Date | null, customerName: string): string {
  const validity = validUntil ? ` It is valid until ${isoDate(validUntil)}.` : '';
  return (
    `Hello ${customerName}, your quotation ${quoteNo} for ${formatCurrency(grandTotal)} is ready.` +
    `${validity} Please review the attached estimate and reply to confirm.`
  );
}

export async function sendQuote(auth: AuthContext, id: string, input: QuoteSendInput) {
  const loaded = await loadQuote(auth, id);
  const before = serializeQuote(loaded);

  if (loaded.status === 'WON' || loaded.status === 'LOST' || loaded.status === 'EXPIRED') {
    throw unprocessable(
      `A ${loaded.status} quotation cannot be sent — clone it to re-quote`,
      'INVALID_TRANSITION',
      { from: loaded.status, to: 'SENT' },
    );
  }
  // FR-224 AC 3 — "no place_of_supply … Send is blocked".
  if (!loaded.placeOfSupplyState) {
    throw unprocessable(
      'Place of supply is required before this quotation can be sent',
      'PLACE_OF_SUPPLY_MISSING',
    );
  }
  if (loaded.lines.length === 0) {
    throw unprocessable('Add at least one line before sending this quotation', 'NO_LINES');
  }

  // FR-226 AC 3 — "a customer with no email … prompts for an email".
  const toAddress =
    input.toAddress ??
    (input.channel === 'EMAIL' ? loaded.customer.email ?? null : loaded.customer.phone ?? null);
  if (!toAddress) {
    if (input.channel === 'EMAIL') {
      throw unprocessable(
        `${loaded.customer.name} has no email address on file — add one or share on WhatsApp instead`,
        'EMAIL_REQUIRED',
      );
    }
    throw unprocessable(
      `${loaded.customer.name} has no phone number on file`,
      'PHONE_REQUIRED',
    );
  }

  const sentAt = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.quote.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!current) throw notFound('Quotation not found');

    // BR-3 / FR-230 — gap-free, FY-resetting number allocated at finalisation only.
    let quoteNo = current.quoteNo;
    if (!quoteNo) {
      const scope = await resolveSeriesScope(tx, auth.tenantId, current.branchId, current.fyId);
      const allocated = await allocateNumber({
        tx,
        tenantId: auth.tenantId,
        docType: 'QUOTATION',
        branchId: scope.branchId,
        fyId: scope.fyId,
        branchCode: loaded.branch.branchCode,
        fyLabel: loaded.fy.fyLabel,
      });
      quoteNo = allocated.number;
    }

    // FR-230 — "valid_until defaults from a tenant 'validity days' setting".
    const resolvedValidUntil = input.validUntil
      ? parseIsoDate(input.validUntil)
      : current.validUntil ?? addDays(tenantToday(sentAt), await tenantValidityDays(tx, auth.tenantId));

    await tx.quote.update({
      where: { id },
      data: {
        quoteNo,
        status: 'SENT',
        sentAt,
        sentVia: input.channel,
        validUntil: resolvedValidUntil,
      },
    });

    // FR-226 — "delivery/send status is logged".
    await tx.messageLog.create({
      data: {
        tenantId: auth.tenantId,
        channel: input.channel,
        toAddress,
        entityType: 'Quote',
        entityId: id,
        quoteId: id,
        body: input.message ?? shareBody(quoteNo, m2(current.grandTotal), resolvedValidUntil, loaded.customer.name),
        status: 'SENT',
        sentAt,
      },
    });

    return tx.quote.findFirstOrThrow({ where: { id }, include: QUOTE_INCLUDE });
  });

  const dto = serializeQuote(updated);
  await recordAudit({
    tenantId: auth.tenantId,
    branchId: updated.branchId,
    actorId: auth.userId,
    entityType: 'Quote',
    entityId: id,
    action: 'UPDATE',
    before,
    after: dto,
  });

  return {
    ...dto,
    share: {
      channel: input.channel,
      channelLabel: CHANNEL_LABEL[input.channel],
      toAddress,
      sentAt: isoTs(sentAt),
      status: 'SENT',
    },
  };
}

async function tenantValidityDays(tx: Client, tenantId: string): Promise<number> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { quoteValidityDays: true } });
  return tenant?.quoteValidityDays ?? 15;
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-230 — status pipeline
// ─────────────────────────────────────────────────────────────────────────────

/** "Allowed transitions: Draft→Sent→(Won|Lost|Expired)". Won/Lost are terminal. */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT'],
  SENT: ['WON', 'LOST', 'EXPIRED'],
  WON: [],
  LOST: [],
  EXPIRED: [],
};

export async function changeStatus(auth: AuthContext, id: string, input: QuoteStatusChangeInput) {
  const loaded = await loadQuote(auth, id);
  const before = serializeQuote(loaded);

  if (loaded.status === input.status) {
    return { ...before, openFollowUps: [] as ReturnType<typeof serializeOpenFollowUp>[] };
  }
  if (!(ALLOWED_TRANSITIONS[loaded.status] ?? []).includes(input.status)) {
    throw unprocessable(
      `A quotation cannot move from ${loaded.status} to ${input.status}`,
      'INVALID_TRANSITION',
      { from: loaded.status, to: input.status, allowed: ALLOWED_TRANSITIONS[loaded.status] ?? [] },
    );
  }

  // FR-230 — "Lost requires a reason."
  const lostReason = nullable(input.lostReason);
  if (input.status === 'LOST' && !lostReason) {
    throw unprocessable('A reason is required when a quotation is marked Lost', 'LOST_REASON_REQUIRED');
  }

  if (input.status === 'SENT') {
    if (!loaded.placeOfSupplyState) {
      throw unprocessable(
        'Place of supply is required before this quotation can be finalised',
        'PLACE_OF_SUPPLY_MISSING',
      );
    }
    if (loaded.lines.length === 0) {
      throw unprocessable('Add at least one line before finalising this quotation', 'NO_LINES');
    }
  }

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.quote.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!current) throw notFound('Quotation not found');

    let quoteNo = current.quoteNo;
    // BR-3 — finalisation is what consumes a number.
    if (input.status === 'SENT' && !quoteNo) {
      const scope = await resolveSeriesScope(tx, auth.tenantId, current.branchId, current.fyId);
      const allocated = await allocateNumber({
        tx,
        tenantId: auth.tenantId,
        docType: 'QUOTATION',
        branchId: scope.branchId,
        fyId: scope.fyId,
        branchCode: loaded.branch.branchCode,
        fyLabel: loaded.fy.fyLabel,
      });
      quoteNo = allocated.number;
    }

    await tx.quote.update({
      where: { id },
      data: {
        status: input.status,
        quoteNo,
        ...(input.status === 'LOST' ? { lostReason } : {}),
        ...(input.status === 'WON' ? { wonAt: now } : {}),
        ...(input.status === 'SENT' && !current.sentAt ? { sentAt: now } : {}),
        ...(input.status === 'SENT' && !current.validUntil
          ? { validUntil: addDays(tenantToday(now), await tenantValidityDays(tx, auth.tenantId)) }
          : {}),
      },
    });

    return tx.quote.findFirstOrThrow({ where: { id }, include: QUOTE_INCLUDE });
  });

  const dto = serializeQuote(updated);
  await recordAudit({
    tenantId: auth.tenantId,
    branchId: updated.branchId,
    actorId: auth.userId,
    entityType: 'Quote',
    entityId: id,
    action: 'UPDATE',
    before,
    after: dto,
  });

  // FR-203 — "marking parent Won/Lost auto-prompts to close open follow-ups".
  const openFollowUps =
    input.status === 'WON' || input.status === 'LOST' ? await openFollowUpsForQuote(auth.tenantId, id) : [];

  return { ...dto, openFollowUps };
}

function serializeOpenFollowUp(f: {
  id: string;
  dueAt: Date;
  note: string;
  assignedTo: string;
  status: string;
}) {
  return {
    id: f.id,
    dueAt: isoTs(f.dueAt),
    note: f.note,
    assignedTo: f.assignedTo,
    status: f.status,
  };
}

async function openFollowUpsForQuote(tenantId: string, quoteId: string) {
  const rows = await prisma.followUp.findMany({
    where: { tenantId, quoteId, status: 'OPEN' },
    orderBy: { dueAt: 'asc' },
  });
  return rows.map(serializeOpenFollowUp);
}

/**
 * FR-230 — the scheduled sweep: "when now > valid_until and status is Sent,
 * status auto-moves to Expired". Dates are compared on the tenant's calendar day.
 */
export async function expireDue(auth: AuthContext) {
  const today = tenantToday();
  const due = await prisma.quote.findMany({
    where: { tenantId: auth.tenantId, status: 'SENT', validUntil: { lt: today } },
    select: { id: true, quoteNo: true, branchId: true, validUntil: true },
  });

  if (due.length === 0) return { asOn: isoDate(today), expired: 0, quotes: [] };

  const result = await prisma.quote.updateMany({
    where: { tenantId: auth.tenantId, status: 'SENT', validUntil: { lt: today }, id: { in: due.map((q) => q.id) } },
    data: { status: 'EXPIRED' },
  });

  for (const q of due) {
    await recordAudit({
      tenantId: auth.tenantId,
      branchId: q.branchId,
      actorId: auth.userId,
      entityType: 'Quote',
      entityId: q.id,
      action: 'UPDATE',
      before: { status: 'SENT' },
      after: { status: 'EXPIRED', validUntil: isoDateN(q.validUntil) },
    });
  }

  return {
    asOn: isoDate(today),
    expired: result.count,
    quotes: due.map((q) => ({ id: q.id, quoteNo: q.quoteNo, validUntil: isoDateN(q.validUntil) })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-231 / FR-232 — clone / revive
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Clone creates a new Draft … it re-prices through the current engine/rate
 * versions (so updated rates apply), while preserving the spec." Works from any
 * status, including Expired (FR-232).
 */
export async function cloneQuote(auth: AuthContext, id: string, input: QuoteCloneInput) {
  const source = await loadQuote(auth, id);
  const ctx = await loadPricingContext(auth, source.branchId);

  const quoteDate = input.quoteDate ? parseIsoDate(input.quoteDate) : tenantToday();
  const fy = await resolveFy(auth.tenantId, quoteDate);
  const validUntil = input.validUntil
    ? parseIsoDate(input.validUntil)
    : addDays(toDateOnly(quoteDate), ctx.tenant.quoteValidityDays);

  const lines = source.lines.map(storedLineToInput);
  const docDiscount = storedDocDiscount(source);
  const { result, resolved, isInterstate } = await price(auth, ctx, lines, {
    placeOfSupplyState: source.placeOfSupplyState,
    ...docDiscount,
  });
  const docDiscountPct = docDiscount.docDiscountPct ?? '0';
  const totals = result ? headerTotals(result, docDiscountPct) : emptyTotals(isInterstate, docDiscountPct);

  const created = await prisma.$transaction(async (tx) => {
    const quote = await tx.quote.create({
      data: {
        tenantId: auth.tenantId,
        branchId: ctx.branch.id,
        fyId: fy.id,
        quoteNo: null, // BR-3
        quoteDate: toDateOnly(quoteDate),
        customerId: source.customerId,
        enquiryId: source.enquiryId,
        placeOfSupplyState: source.placeOfSupplyState,
        supplierStateCode: ctx.branch.stateCode,
        status: 'DRAFT',
        validUntil,
        notes: input.notes !== undefined ? nullable(input.notes) : source.notes,
        terms: source.terms,
        /** FR-231 — "The clone links back to the source quote for traceability." */
        clonedFrom: source.id,
        createdBy: auth.userId,
        ...totals,
      },
    });
    await writeLines(tx, auth.tenantId, quote.id, result, resolved);
    return tx.quote.findFirstOrThrow({ where: { id: quote.id }, include: QUOTE_INCLUDE });
  });

  const dto = serializeQuote(created);
  await recordAudit({
    tenantId: auth.tenantId,
    branchId: created.branchId,
    actorId: auth.userId,
    entityType: 'Quote',
    entityId: created.id,
    action: 'CREATE',
    before: { clonedFrom: source.id, sourceStatus: source.status },
    after: dto,
  });
  return dto;
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-225 — branded quotation document model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A deterministic JSON document model for the branded PDF. Everything comes
 * from stored quote data, so regenerating yields identical content; nothing
 * here reads a clock. FR-225: "clearly labelled Quotation/Estimate, not Tax
 * Invoice".
 */
export async function quoteDocument(auth: AuthContext, id: string) {
  const quote = await loadQuote(auth, id);
  const [tenant, terms] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: auth.tenantId } }),
    quote.terms
      ? Promise.resolve(null)
      : prisma.termsBlock.findFirst({
          where: { tenantId: auth.tenantId, active: true, appliesTo: { has: 'QUOTATION' } },
          orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
        }),
  ]);
  if (!tenant) throw notFound('Tenant not found');

  const address = [tenant.addressLine1, tenant.addressLine2, tenant.city, tenant.pincode]
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0)
    .join(', ');

  const branchAddress = [quote.branch.addressLine1, quote.branch.addressLine2, quote.branch.city, quote.branch.pincode]
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0)
    .join(', ');

  const totalTax = sum([
    quote.cgst.toString(),
    quote.sgst.toString(),
    quote.igst.toString(),
    quote.cess.toString(),
  ]);

  return {
    /** FR-225 — never "Tax Invoice". */
    documentTitle: 'Quotation / Estimate',
    documentType: 'QUOTATION' as const,
    isTaxInvoice: false,
    engineVersion: quote.engineVersion,

    tenant: {
      legalName: tenant.legalName,
      tradeName: tenant.tradeName,
      logoUrl: tenant.logoUrl,
      gstin: tenant.gstin,
      pan: tenant.pan,
      address,
      stateCode: tenant.stateCode,
      stateName: stateName(tenant.stateCode),
      email: tenant.email,
      phone: tenant.phone,
      website: tenant.website,
      gstRegistered: tenant.gstRegistered,
    },
    branch: {
      branchCode: quote.branch.branchCode,
      name: quote.branch.name,
      gstin: quote.branch.gstin,
      stateCode: quote.branch.stateCode,
      stateName: stateName(quote.branch.stateCode),
      address: branchAddress,
      phone: quote.branch.phone,
    },
    quote: {
      id: quote.id,
      quoteNo: quote.quoteNo,
      quoteDate: isoDate(quote.quoteDate),
      validUntil: isoDateN(quote.validUntil),
      status: quote.status,
      fyLabel: quote.fy.fyLabel,
      placeOfSupplyState: quote.placeOfSupplyState,
      placeOfSupplyStateName: stateName(quote.placeOfSupplyState),
      taxTreatment: quote.isInterstate ? ('IGST' as const) : ('CGST_SGST' as const),
      reference: quote.enquiryId ? { enquiryId: quote.enquiryId } : null,
    },
    customer: {
      name: quote.customer.name,
      gstin: quote.customer.gstin,
      customerType: quote.customer.customerType,
      address: [quote.customer.billingAddress, quote.customer.billingCity, quote.customer.billingPincode]
        .map((p) => (p ?? '').trim())
        .filter((p) => p.length > 0)
        .join(', '),
      placeOfSupplyState: quote.customer.placeOfSupplyState,
      placeOfSupplyStateName: stateName(quote.customer.placeOfSupplyState),
      phone: quote.customer.phone,
      email: quote.customer.email,
    },

    /** FR-225 — "each line's human-readable spec, HSN/SAC, qty/area, rate, discount, taxable and tax". */
    lines: quote.lines.map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      spec: l.specJson,
      hsnSac: l.hsnSac,
      uomCode: l.uomCode,
      qty: r4(l.qty),
      heightFt: r4n(l.heightFt),
      widthFt: r4n(l.widthFt),
      areaSqft: r4n(l.areaSqft),
      rate: r4(l.rate),
      addOnRate: r4(l.addOnRate),
      addOnFlat: m2(l.addOnFlat),
      grossAmount: m2(l.grossAmount),
      minChargeApplied: l.minChargeApplied,
      minCharge: m2(l.minCharge),
      discount: m2(D(l.discountAmt.toString()).plus(D(l.docDiscountShare.toString()))),
      lineDiscount: m2(l.discountAmt),
      docDiscountShare: m2(l.docDiscountShare),
      taxable: m2(l.lineTaxable),
      gstPct: r4(l.gstPct),
      cgst: m2(l.cgst),
      sgst: m2(l.sgst),
      igst: m2(l.igst),
      tax: m2(l.lineTax),
      total: m2(l.lineTotal),
    })),

    rateWiseSummary: rateWiseSummary(quote.lines),
    hsnSummary: hsnSummary(quote.lines),

    totals: {
      subtotal: m2(quote.subtotal),
      discountTotal: m2(quote.discountTotal),
      docDiscountAmt: m2(quote.docDiscountAmt),
      taxableValue: m2(quote.taxableValue),
      cgst: m2(quote.cgst),
      sgst: m2(quote.sgst),
      igst: m2(quote.igst),
      cess: m2(quote.cess),
      totalTax: money(totalTax),
      roundOff: m2(quote.roundOff),
      grandTotal: m2(quote.grandTotal),
      grandTotalFormatted: formatCurrency(quote.grandTotal.toString()),
      /** FR-223 — Indian-format amount in words. */
      amountInWords: quote.amountInWords ?? amountInWords(quote.grandTotal.toString()),
    },

    notes: quote.notes,
    terms: quote.terms ?? terms?.body ?? null,
    termsTitle: quote.terms ? null : terms?.title ?? null,
    declaration: 'This is a quotation / estimate and not a tax invoice. Prices are valid until the date shown above.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-233 — one-click quote → jobcard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Conversion is allowed only from status Won … re-conversion is blocked once a
 * jobcard exists, with a link to the existing jobcard." The jobcard itself is
 * built by the production module so specs/pricing are carried by one owner.
 */
export async function convertToJobcard(auth: AuthContext, id: string) {
  const quote = await loadQuote(auth, id);

  if (quote.status !== 'WON') {
    throw unprocessable(
      `Only a Won quotation can be converted to a jobcard (this one is ${quote.status})`,
      'QUOTE_NOT_WON',
      { status: quote.status },
    );
  }

  const existing = await prisma.jobcard.findFirst({
    where: { tenantId: auth.tenantId, sourceQuoteId: id },
    select: { id: true, jobcardNo: true },
  });
  if (existing) {
    throw new AppError('This quotation has already been converted to a jobcard', 409, 'ALREADY_CONVERTED', {
      jobcardId: existing.id,
      jobcardNo: existing.jobcardNo,
    });
  }

  const jobcard = await prisma.$transaction(async (tx) => {
    const duplicate = await tx.jobcard.findFirst({
      where: { tenantId: auth.tenantId, sourceQuoteId: id },
      select: { id: true, jobcardNo: true },
    });
    if (duplicate) {
      throw new AppError('This quotation has already been converted to a jobcard', 409, 'ALREADY_CONVERTED', {
        jobcardId: duplicate.id,
        jobcardNo: duplicate.jobcardNo,
      });
    }

    const fresh = await tx.quote.findFirst({ where: { id, tenantId: auth.tenantId }, include: QUOTE_INCLUDE });
    if (!fresh) throw notFound('Quotation not found');

    return createJobcardFromQuote({ tx, auth, quote: fresh });
  });

  await recordAudit({
    tenantId: auth.tenantId,
    branchId: quote.branchId,
    actorId: auth.userId,
    entityType: 'Quote',
    entityId: id,
    action: 'UPDATE',
    before: { status: quote.status, jobcard: null },
    after: { status: quote.status, jobcardId: jobcard.id },
  });

  return { quote: serializeQuote(await loadQuote(auth, id)), jobcard };
}
