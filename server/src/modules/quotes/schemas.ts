/**
 * Request validation for the quotation module (zod v4).
 *
 * FRD §4.2/§4.3/§4.4 — FR-210 … FR-233.
 *
 * BR-1 — money and rates travel as decimal *strings*; a JS float never touches
 * a monetary value. Every computed figure (taxable value, tax heads, totals) is
 * rejected on input: the shared engine is the only thing allowed to produce it.
 */
import { z } from 'zod';
import { isValidStateCode } from '../../lib/gstin.js';
import { unprocessable } from '../../http/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

const DECIMAL_RE = /^-?\d{1,15}(\.\d{1,6})?$/;

function decimalInput(label: string) {
  return z
    .union([z.string().trim(), z.number()])
    .transform((v) => (typeof v === 'number' ? String(v) : v))
    .refine((v) => DECIMAL_RE.test(v), { message: `${label} must be a decimal number` });
}

function nonNegativeDecimal(label: string) {
  return decimalInput(label).refine((v) => !v.startsWith('-'), { message: `${label} cannot be negative` });
}

/** BR-2 — the 2-digit GST state code that drives CGST/SGST vs IGST. */
export const stateCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{2}$/, 'State code must be the 2-digit GST state code (e.g. 27)')
  .refine((c) => isValidStateCode(c), { message: 'Unknown GST state code' });

export const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD form');

const slug = (value: string): string => value.trim().toUpperCase().replace(/[\s\-/.]+/g, '_');

export const lineKindSchema = z
  .string()
  .transform((v) => slug(v))
  .pipe(z.enum(['AREA', 'QTY']));

export const markupModeSchema = z
  .string()
  .transform((v) => slug(v))
  .pipe(z.enum(['MARKUP', 'MARGIN']));

export const quoteStatusSchema = z
  .string()
  .transform((v) => slug(v))
  .pipe(z.enum(['DRAFT', 'SENT', 'WON', 'LOST', 'EXPIRED']));

const CHANNEL_ALIASES: Record<string, 'WHATSAPP' | 'EMAIL' | 'SMS'> = {
  WHATSAPP: 'WHATSAPP',
  WA: 'WHATSAPP',
  EMAIL: 'EMAIL',
  MAIL: 'EMAIL',
  SMS: 'SMS',
  TEXT: 'SMS',
};

/** FR-226 — WhatsApp (primary), Email, SMS. */
export const shareChannelSchema = z
  .string()
  .transform((v) => CHANNEL_ALIASES[slug(v)] ?? slug(v))
  .pipe(z.enum(['WHATSAPP', 'EMAIL', 'SMS']));

// ─────────────────────────────────────────────────────────────────────────────
// FR-221 — guided job-spec wizard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FR-221 — "size (height × width / qty), substrate/media & GSM, colours (4/0,
 * 4/4, etc.), sides (single/double), lamination, and finishing options."
 */
export const jobSpecSchema = z.object({
  size: z.string().trim().max(80).optional().nullable(),
  substrate: z.string().trim().max(120).optional().nullable(),
  gsm: z.coerce.number().int().min(1).max(5000).optional().nullable(),
  colours: z.string().trim().max(20).optional().nullable(),
  sides: z.coerce.number().int().min(1).max(2).optional().nullable(),
  lamination: z.string().trim().max(40).optional().nullable(),
  finishing: z.array(z.string().trim().min(1).max(40)).max(20).optional().nullable(),
});
export type JobSpecInput = z.output<typeof jobSpecSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Quote lines
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nothing here carries a zod `.default()`: an absent field must stay absent so
 * the pricing adapter can apply the FR-212 resolution order (line override →
 * material master → rate card) and the FR-213 tenant markup fallback.
 */
export const quoteLineSchema = z.object({
  lineNo: z.coerce.number().int().min(1).max(9999).optional(),
  /** AREA ⇒ FR-211 square-foot pricing; QTY ⇒ piece/sheet pricing. */
  kind: lineKindSchema,
  description: z.string().trim().max(500).optional().nullable(),
  hsnSac: z.string().trim().max(10).optional().nullable(),
  isService: z.boolean().optional(),

  qty: nonNegativeDecimal('qty').optional(),
  uomCode: z.string().trim().max(20).optional(),
  heightFt: nonNegativeDecimal('heightFt').optional().nullable(),
  widthFt: nonNegativeDecimal('widthFt').optional().nullable(),

  /** FR-212 — rate sources, in resolution order. */
  rate: nonNegativeDecimal('rate').optional().nullable(),
  materialId: z.uuid().optional().nullable(),
  rateCardId: z.uuid().optional().nullable(),

  /** FR-213 — explicit cost + markup, when the line is priced off cost. */
  costRate: nonNegativeDecimal('costRate').optional().nullable(),
  markupPct: nonNegativeDecimal('markupPct').optional().nullable(),
  markupMode: markupModeSchema.optional(),

  /** FR-221 — lamination / finishing add-ons. */
  addOnRate: nonNegativeDecimal('addOnRate').optional().nullable(),
  addOnFlat: nonNegativeDecimal('addOnFlat').optional().nullable(),

  /** FR-211 / FR-215 — per-line minimum charge override. */
  minCharge: nonNegativeDecimal('minCharge').optional().nullable(),

  /** FR-214 — line discount, pre-GST. */
  discountPct: nonNegativeDecimal('discountPct').optional().nullable(),
  discountAmt: nonNegativeDecimal('discountAmt').optional().nullable(),

  gstPct: nonNegativeDecimal('gstPct').optional().nullable(),
  cessPct: nonNegativeDecimal('cessPct').optional().nullable(),

  /** FR-221 — the captured wizard spec, persisted to QuoteLine.specJson. */
  spec: jobSpecSchema.optional().nullable(),
});
export type QuoteLineInput = z.output<typeof quoteLineSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// FR-210 / FR-222 — stateless price preview
// ─────────────────────────────────────────────────────────────────────────────

export const pricePreviewSchema = z.object({
  customerId: z.uuid().optional().nullable(),
  /** FR-224 — defaults from the customer when omitted. */
  placeOfSupplyState: stateCodeSchema.optional().nullable(),
  branchId: z.uuid(),
  lines: z.array(quoteLineSchema).min(1).max(200),
  docDiscountPct: nonNegativeDecimal('docDiscountPct').optional().nullable(),
  docDiscountAmt: nonNegativeDecimal('docDiscountAmt').optional().nullable(),
});
export type PricePreviewInput = z.output<typeof pricePreviewSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Quote header
// ─────────────────────────────────────────────────────────────────────────────

export const quoteCreateSchema = z.object({
  customerId: z.uuid(),
  branchId: z.uuid().optional(),
  enquiryId: z.uuid().optional().nullable(),
  quoteDate: isoDateSchema.optional(),
  /** FR-224 — overridable per quote; mandatory before Send. */
  placeOfSupplyState: stateCodeSchema.optional().nullable(),
  validUntil: isoDateSchema.optional().nullable(),
  docDiscountPct: nonNegativeDecimal('docDiscountPct').optional().nullable(),
  docDiscountAmt: nonNegativeDecimal('docDiscountAmt').optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
  terms: z.string().trim().max(8000).optional().nullable(),
  /** FR-222 — "A draft can be saved incomplete and resumed." */
  lines: z.array(quoteLineSchema).max(200).optional(),
});
export type QuoteCreateInput = z.output<typeof quoteCreateSchema>;

export const quoteUpdateSchema = quoteCreateSchema.partial();
export type QuoteUpdateInput = z.output<typeof quoteUpdateSchema>;

export const quoteListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: quoteStatusSchema.optional(),
  customerId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  enquiryId: z.uuid().optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type QuoteListQuery = z.output<typeof quoteListQuerySchema>;

/** FR-226 — share the quote and move Draft → Sent. */
export const quoteSendSchema = z.object({
  channel: shareChannelSchema,
  /** Overrides the customer's stored phone/email for this share only. */
  toAddress: z.string().trim().max(160).optional(),
  validUntil: isoDateSchema.optional(),
  message: z.string().trim().max(2000).optional(),
});
export type QuoteSendInput = z.output<typeof quoteSendSchema>;

/** FR-230 — status pipeline. */
export const quoteStatusChangeSchema = z.object({
  status: quoteStatusSchema,
  lostReason: z.string().trim().max(500).optional().nullable(),
});
export type QuoteStatusChangeInput = z.output<typeof quoteStatusChangeSchema>;

/** FR-231 / FR-232 — clone / revive. */
export const quoteCloneSchema = z.object({
  validUntil: isoDateSchema.optional(),
  quoteDate: isoDateSchema.optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
});
export type QuoteCloneInput = z.output<typeof quoteCloneSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// FR-222 — "no manual override of computed tax"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FR-210 / FR-222 — totals always come from the shared engine. A client that
 * tries to post a taxable value, a tax head or a total is rejected outright
 * rather than having the value silently ignored.
 */
const COMPUTED_HEADER_FIELDS = [
  'subtotal',
  'discountTotal',
  'taxableValue',
  'cgst',
  'sgst',
  'igst',
  'cess',
  'totalTax',
  'roundOff',
  'grandTotal',
  'amountInWords',
  'engineVersion',
  'isInterstate',
  'needsApproval',
  'quoteNo',
  'status',
] as const;

const COMPUTED_LINE_FIELDS = [
  'areaSqft',
  'units',
  'grossAmount',
  'minChargeApplied',
  'minChargeUplift',
  'docDiscountShare',
  'lineTaxable',
  'cgst',
  'sgst',
  'igst',
  'cess',
  'lineTax',
  'lineTotal',
  'rateSource',
] as const;

function present(body: Record<string, unknown>, fields: readonly string[], prefix: string): string[] {
  return fields.filter((f) => body[f] !== undefined).map((f) => `${prefix}${f}`);
}

export function assertNoComputedFields(body: unknown): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  const record = body as Record<string, unknown>;

  const offenders = present(record, COMPUTED_HEADER_FIELDS, '');
  const lines = record.lines;
  if (Array.isArray(lines)) {
    lines.forEach((line, index) => {
      if (line !== null && typeof line === 'object' && !Array.isArray(line)) {
        offenders.push(...present(line as Record<string, unknown>, COMPUTED_LINE_FIELDS, `lines[${index}].`));
      }
    });
  }

  if (offenders.length > 0) {
    throw unprocessable(
      `These values are computed by the pricing engine and cannot be set directly: ${offenders.join(', ')}`,
      'COMPUTED_FIELD_READONLY',
      { fields: offenders },
    );
  }
}
