/**
 * Request validation for the master-data module (zod v4).
 *
 * Covers FRD §3.5 (FR-113 customer, FR-114 supplier, FR-115 product/SKU,
 * FR-116 material item), §3.6 (FR-120 bulk import, FR-121 opening balances),
 * §4.1 (FR-201 customer & contact master, FR-202 ledger view) and FR-216
 * (published rate card).
 */
import { z } from 'zod';
import { isValidStateCode } from '../../lib/gstin.js';

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** BR-1 — money/rates never travel as JS floats; accept a decimal string or a number and keep the string form. */
const DECIMAL_RE = /^-?\d{1,15}(\.\d{1,6})?$/;

export function decimalInput(label: string) {
  return z
    .union([z.string().trim(), z.number()])
    .transform((v) => (typeof v === 'number' ? String(v) : v))
    .refine((v) => DECIMAL_RE.test(v), { message: `${label} must be a decimal number` });
}

export function nonNegativeDecimal(label: string) {
  return decimalInput(label).refine((v) => !v.startsWith('-'), { message: `${label} cannot be negative` });
}

/** BR-2 — the 2-digit GST state code that drives CGST/SGST vs IGST. */
export const stateCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{2}$/, 'State code must be the 2-digit GST state code (e.g. 27)')
  .refine((c) => isValidStateCode(c), { message: 'Unknown GST state code' });

export const pincodeSchema = z.string().trim().regex(/^[0-9]{6}$/, 'PIN code must be 6 digits');

export const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD form');

export const customerTypeSchema = z.enum(['REGISTERED', 'UNREGISTERED', 'COMPOSITION', 'SEZ', 'EXPORT']);
export const verticalSchema = z.enum(['FLEX_LARGE_FORMAT', 'OFFSET', 'DIGITAL', 'SCREEN']);
export const materialCategorySchema = z.enum(['PAPER', 'BOARD', 'MEDIA', 'INK', 'PLATE', 'OTHER']);

// ─────────────────────────────────────────────────────────────────────────────
// List / paging (every list endpoint supports q, active, page, pageSize)
// ─────────────────────────────────────────────────────────────────────────────

export const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  active: z.enum(['true', 'false', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type ListQuery = z.output<typeof listQuerySchema>;

/** FR-114 — the supplier list can compute due dates against a caller-supplied bill date. */
export const supplierListQuerySchema = listQuerySchema.extend({
  billDate: isoDateSchema.optional(),
});

export const supplierDetailQuerySchema = z.object({ billDate: isoDateSchema.optional() });

/** FR-216 — a picker must never offer a deactivated rate card. */
export const rateCardListQuerySchema = listQuerySchema.extend({
  forPicker: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
});

/** FR-202 — read-only ledger as of a selectable date. */
export const ledgerQuerySchema = z.object({ asOn: isoDateSchema.optional() });

// ─────────────────────────────────────────────────────────────────────────────
// FR-113 / FR-201 — Customer
// ─────────────────────────────────────────────────────────────────────────────

export const customerContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(4).max(20).optional().nullable(),
  email: z.email().max(160).optional().nullable(),
  role: z.string().trim().max(60).optional().nullable(),
  isPrimary: z.boolean().default(false),
});

export const shippingAddressSchema = z.object({
  label: z.string().trim().max(60).optional().nullable(),
  address: z.string().trim().min(1).max(500),
  city: z.string().trim().max(80).optional().nullable(),
  stateCode: stateCodeSchema,
  pincode: pincodeSchema.optional().nullable(),
});

export const customerCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  customerType: customerTypeSchema.default('UNREGISTERED'),
  gstin: z.string().trim().toUpperCase().max(15).optional().nullable(),
  pan: z.string().trim().toUpperCase().max(10).optional().nullable(),
  /** FR-201 — mandatory always: it drives CGST/SGST vs IGST downstream. */
  placeOfSupplyState: stateCodeSchema,
  billingAddress: z.string().trim().max(500).optional().nullable(),
  billingCity: z.string().trim().max(80).optional().nullable(),
  billingPincode: pincodeSchema.optional().nullable(),
  phone: z.string().trim().min(4).max(20),
  email: z.email().max(160).optional().nullable(),
  creditDays: z.coerce.number().int().min(0).max(365).default(0),
  creditLimit: nonNegativeDecimal('creditLimit').default('0'),
  openingBalance: decimalInput('openingBalance').default('0'),
  active: z.boolean().default(true),
  contacts: z.array(customerContactSchema).max(50).default([]),
  shippingAddresses: z.array(shippingAddressSchema).max(50).default([]),
  /** FR-201 — "duplicate names blocked unless user confirms". */
  confirmDuplicateName: z.boolean().default(false),
});

export const customerUpdateSchema = customerCreateSchema.partial();

// ─────────────────────────────────────────────────────────────────────────────
// FR-114 — Supplier
// ─────────────────────────────────────────────────────────────────────────────

export const supplierCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  gstin: z.string().trim().toUpperCase().max(15).optional().nullable(),
  pan: z.string().trim().toUpperCase().max(10).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
  placeOfSupplyState: stateCodeSchema,
  paymentTermDays: z.coerce.number().int().min(0).max(365).default(0),
  openingBalance: decimalInput('openingBalance').default('0'),
  phone: z.string().trim().min(4).max(20).optional().nullable(),
  email: z.email().max(160).optional().nullable(),
  active: z.boolean().default(true),
  confirmDuplicateName: z.boolean().default(false),
});

export const supplierUpdateSchema = supplierCreateSchema.partial();

// ─────────────────────────────────────────────────────────────────────────────
// FR-115 — Finished product / SKU
// ─────────────────────────────────────────────────────────────────────────────

export const productCreateSchema = z.object({
  skuCode: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  vertical: verticalSchema,
  defaultSpecs: z.record(z.string(), z.unknown()).optional().nullable(),
  hsnSacId: z.uuid().optional().nullable(),
  defaultUomId: z.uuid().optional().nullable(),
  /** Omitted on create ⇒ inherited from the HSN's default tax rate (FR-115). */
  taxRateId: z.uuid().optional().nullable(),
  defaultRate: nonNegativeDecimal('defaultRate').default('0'),
  active: z.boolean().default(true),
});

export const productUpdateSchema = productCreateSchema.partial();

// ─────────────────────────────────────────────────────────────────────────────
// FR-116 / FR-212 — Material item
// ─────────────────────────────────────────────────────────────────────────────

export const materialCreateSchema = z.object({
  itemCode: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  category: materialCategorySchema,
  gsm: z.coerce.number().int().min(1).max(5000).optional().nullable(),
  size: z.string().trim().max(80).optional().nullable(),
  rollWidthFt: nonNegativeDecimal('rollWidthFt').optional().nullable(),
  /** FR-116 — UOM and HSN are mandatory on every item. */
  uomId: z.uuid(),
  hsnSacId: z.uuid(),
  /** FR-212 — null means "no active rate": auto-pricing must refuse. */
  sellingRate: nonNegativeDecimal('sellingRate').optional().nullable(),
  costRate: nonNegativeDecimal('costRate').optional().nullable(),
  minCharge: nonNegativeDecimal('minCharge').default('0'),
  gstPct: nonNegativeDecimal('gstPct').optional().nullable(),
  reorderLevel: nonNegativeDecimal('reorderLevel').default('0'),
  active: z.boolean().default(true),
});

export const materialUpdateSchema = materialCreateSchema.partial();

// ─────────────────────────────────────────────────────────────────────────────
// FR-216 — Rate card
// ─────────────────────────────────────────────────────────────────────────────

export const rateCardCreateSchema = z.object({
  itemName: z.string().trim().min(1).max(200),
  uomId: z.uuid(),
  publishedRate: nonNegativeDecimal('publishedRate'),
  hsnSac: z.string().trim().max(10).optional().nullable(),
  gstPct: nonNegativeDecimal('gstPct').default('0'),
  minCharge: nonNegativeDecimal('minCharge').default('0'),
  active: z.boolean().default(true),
});

export const rateCardUpdateSchema = rateCardCreateSchema.partial();

// ─────────────────────────────────────────────────────────────────────────────
// FR-120 / FR-121 — Bulk import
// ─────────────────────────────────────────────────────────────────────────────

export const importEntitySchema = z.enum(['customers', 'suppliers', 'products', 'materials']);
export type ImportEntity = z.output<typeof importEntitySchema>;

export const templateEntitySchema = z.enum([
  'customers',
  'suppliers',
  'products',
  'materials',
  'opening-balances',
]);
export type TemplateEntity = z.output<typeof templateEntitySchema>;

/**
 * FR-120 — the web client parses the .xlsx/.csv and posts the rows; the server
 * validates and partially commits them.
 */
export const importBodySchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
  onDuplicate: z.enum(['skip', 'update']).default('skip'),
  fileName: z.string().trim().max(255).optional(),
});

/** FR-121 — opening balances land in one FY and are replaced on re-import. */
export const openingBalanceImportSchema = importBodySchema.extend({
  fyLabel: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, 'fyLabel must look like 2026-27')
    .optional(),
});

export const importBatchListQuerySchema = z.object({
  entity: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
