/**
 * Request validation for FRD §3 (FR-100 … FR-119) and §9.6 (FR-722 … FR-725).
 * Every route body passes through one of these before it reaches the service.
 */
import { z } from 'zod';
import { D } from '../../lib/money.js';

// ── enum literals ────────────────────────────────────────────────────────────
// Declared as literal tuples rather than pulled from the Prisma runtime so the
// schemas stay usable without a generated client at type-check time.

export const DOC_TYPES = [
  'QUOTATION',
  'JOBCARD',
  'INVOICE',
  'PROFORMA',
  'DELIVERY_CHALLAN',
  'PURCHASE_ORDER',
  'GRN',
  'CREDIT_NOTE',
  'DEBIT_NOTE',
  'RECEIPT',
  'PAYMENT',
] as const;

export const USER_ROLES = [
  'OWNER_ADMIN',
  'ACCOUNTS',
  'SALES_COUNTER',
  'PRODUCTION_MANAGER',
  'OPERATOR',
  'DELIVERY',
] as const;

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'DISABLED'] as const;
export const HSN_TYPES = ['HSN', 'SAC'] as const;
export const ROUNDING_MODES = ['NORMAL', 'UP', 'DOWN', 'NONE'] as const;
export const RESET_POLICIES = ['YEARLY', 'NEVER'] as const;
export const FY_STATUSES = ['OPEN', 'CLOSED'] as const;

export const docTypeSchema = z.enum(DOC_TYPES);
export const userRoleSchema = z.enum(USER_ROLES);
export const userStatusSchema = z.enum(USER_STATUSES);
export const hsnTypeSchema = z.enum(HSN_TYPES);
export const roundingModeSchema = z.enum(ROUNDING_MODES);
export const resetPolicySchema = z.enum(RESET_POLICIES);
export const fyStatusSchema = z.enum(FY_STATUSES);

// ── primitives ───────────────────────────────────────────────────────────────

export const id = z.string().trim().min(1, 'An id is required');

export const shortText = (max = 160) => z.string().trim().min(1).max(max);
export const optionalText = (max = 240) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim())
    .optional()
    .nullable();

export const emailSchema = z
  .string()
  .min(3)
  .max(160)
  .transform((v) => v.trim().toLowerCase())
  .refine((v) => /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(v), { message: 'Enter a valid email address' });

const numericLike = z.union([z.string(), z.number()]);

/**
 * BR-1 — accept money/rate input as a string or number but hand the service a
 * `Decimal`. A JS float never reaches the database.
 */
export const decimalLike = numericLike
  .refine(
    (v) =>
      typeof v === 'number'
        ? Number.isFinite(v)
        : /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v.trim()),
    { message: 'Must be a valid decimal number' },
  )
  .transform((v) => D(v));

export const percent = decimalLike.refine((d) => d.greaterThanOrEqualTo(0) && d.lessThanOrEqualTo(100), {
  message: 'Must be between 0 and 100',
});

export const positiveDecimal = decimalLike.refine((d) => d.greaterThan(0), {
  message: 'Must be greater than zero',
});

export const isoDate = z
  .string()
  .trim()
  .min(4)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: 'Must be a valid date' })
  .transform((v) => new Date(v));

export const stateCode = z
  .string()
  .trim()
  .regex(/^[0-9]{2}$/, 'State code must be the two-digit GST state code');

// ── FR-100 wizard ────────────────────────────────────────────────────────────

export const WIZARD_STEPS = ['firm', 'branch', 'financial_year', 'numbering', 'bank', 'complete'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const wizardUpdateSchema = z.object({
  step: z.enum(WIZARD_STEPS).optional(),
  complete: z.boolean().optional(),
});

// ── FR-101 firm profile ──────────────────────────────────────────────────────

export const firmUpdateSchema = z.object({
  legalName: shortText(160).optional(),
  tradeName: optionalText(160),
  constitution: optionalText(60),
  /** Empty string clears the GSTIN. */
  gstin: z.string().max(20).transform((v) => v.trim().toUpperCase()).optional().nullable(),
  pan: z.string().max(15).transform((v) => v.trim().toUpperCase()).optional().nullable(),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(80),
  stateCode: stateCode.optional().nullable(),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'PIN code must be 6 digits').optional().nullable(),
  email: z.string().max(160).transform((v) => v.trim().toLowerCase()).optional().nullable(),
  phone: optionalText(20),
  website: optionalText(200),
  logoUrl: optionalText(500),
  gstRegistered: z.boolean().optional(),
  baseCurrency: z.string().trim().length(3).optional(),
  decimalPrecision: z.coerce.number().int().min(0).max(4).optional(),
  timezone: optionalText(60),
});

// ── FR-103 / FR-118 branches ─────────────────────────────────────────────────

export const branchCreateSchema = z.object({
  branchCode: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z0-9-]+$/.test(v), { message: 'Branch code may use letters, digits and hyphens only' }),
  name: shortText(120),
  gstin: z.string().max(20).transform((v) => v.trim().toUpperCase()).optional().nullable(),
  stateCode: stateCode.optional().nullable(),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(80),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'PIN code must be 6 digits').optional().nullable(),
  phone: optionalText(20),
  isHeadOffice: z.boolean().optional(),
  active: z.boolean().optional(),
  defaultBankAccount: id.optional().nullable(),
});

export const branchUpdateSchema = branchCreateSchema.partial();

// ── FR-102 bank accounts ─────────────────────────────────────────────────────

export const bankAccountCreateSchema = z.object({
  accountName: shortText(120),
  accountNo: z
    .string()
    .trim()
    .min(6, 'Account number looks too short')
    .max(20)
    .regex(/^[0-9]+$/, 'Account number must be digits only'),
  ifsc: z.string().trim().max(11).transform((v) => v.toUpperCase()),
  bankName: shortText(120),
  branchName: optionalText(120),
  upiVpa: z
    .string()
    .trim()
    .max(80)
    .refine((v) => v === '' || /^[\w.\-]{2,}@[A-Za-z]{2,}$/.test(v), { message: 'UPI VPA must look like name@bank' })
    .optional()
    .nullable(),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
});

export const bankAccountUpdateSchema = bankAccountCreateSchema.partial();

// ── FR-104 / FR-105 financial years ──────────────────────────────────────────

export const fyCreateSchema = z
  .object({
    startYear: z.coerce.number().int().min(1990).max(2199).optional(),
    startDate: isoDate.optional(),
    isCurrent: z.boolean().optional(),
  })
  .refine((v) => v.startYear !== undefined || v.startDate !== undefined, {
    message: 'Provide startYear (e.g. 2026) or startDate',
    path: ['startYear'],
  });

export const fyUpdateSchema = z.object({
  status: fyStatusSchema.optional(),
  isCurrent: z.boolean().optional(),
});

export const fyRolloverSchema = z.object({
  setCurrent: z.boolean().optional(),
});

// ── FR-106 / FR-107 numbering series ─────────────────────────────────────────

export const seriesCreateSchema = z.object({
  docType: docTypeSchema,
  branchId: id.optional().nullable(),
  fyId: id.optional().nullable(),
  prefix: z.string().max(40).optional(),
  suffix: z.string().max(40).optional(),
  startNumber: z.coerce.number().int().min(1).max(9_999_999).optional(),
  padding: z.coerce.number().int().min(0).max(10).optional(),
  resetPolicy: resetPolicySchema.optional(),
  active: z.boolean().optional(),
});

export const seriesUpdateSchema = seriesCreateSchema.partial().extend({
  nextNumber: z.coerce.number().int().min(1).max(9_999_999).optional(),
});

export const seriesPreviewSchema = z.object({
  seriesId: id.optional(),
  docType: docTypeSchema.optional(),
  prefix: z.string().max(40).optional(),
  suffix: z.string().max(40).optional(),
  padding: z.coerce.number().int().min(0).max(10).optional(),
  seq: z.coerce.number().int().min(1).max(9_999_999).optional(),
  branchId: id.optional(),
  branchCode: z.string().trim().max(10).optional(),
  fyId: id.optional(),
  fyLabel: z.string().trim().max(10).optional(),
});

// ── FR-108 tax rates ─────────────────────────────────────────────────────────

export const taxRateCreateSchema = z.object({
  name: shortText(60),
  gstPct: percent,
  cessPct: percent.optional(),
  effectiveFrom: isoDate.optional(),
  active: z.boolean().optional(),
});

export const taxRateUpdateSchema = taxRateCreateSchema.partial();

export const taxSplitQuerySchema = z.object({
  gstPct: percent,
  supplierState: stateCode,
  placeOfSupply: stateCode,
  taxableValue: decimalLike.optional(),
  cessPct: percent.optional(),
});

// ── FR-109 / FR-117 HSN & SAC ────────────────────────────────────────────────

export const hsnCreateSchema = z.object({
  code: z.string().trim().min(2).max(10),
  type: hsnTypeSchema,
  description: optionalText(240),
  defaultTaxRateId: id.optional().nullable(),
  defaultUomId: id.optional().nullable(),
  active: z.boolean().optional(),
});

export const hsnUpdateSchema = hsnCreateSchema.partial();

// ── FR-110 units of measure ──────────────────────────────────────────────────

export const uomCreateSchema = z.object({
  uomCode: z
    .string()
    .trim()
    .min(1)
    .max(12)
    .transform((v) => v.toUpperCase()),
  name: shortText(60),
  symbol: optionalText(12),
  baseUomId: id.optional().nullable(),
  baseUomCode: z.string().trim().max(12).transform((v) => v.toUpperCase()).optional().nullable(),
  factorToBase: positiveDecimal.optional(),
  active: z.boolean().optional(),
});

export const uomUpdateSchema = uomCreateSchema.partial();

// ── FR-111 terms & notes blocks ──────────────────────────────────────────────

export const termsCreateSchema = z.object({
  title: shortText(120),
  body: z.string().trim().min(1).max(8000),
  appliesTo: z.array(docTypeSchema).optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
});

export const termsUpdateSchema = termsCreateSchema.partial();

// ── FR-112 rounding rules ────────────────────────────────────────────────────

const roundingRuleSchema = z.object({
  scope: docTypeSchema.optional().nullable(),
  mode: roundingModeSchema,
  precision: z.coerce.number().int().refine((v) => v === 0 || v === 2, {
    message: 'Precision must be 0 (whole rupee) or 2 (paise)',
  }),
});

export const roundingUpsertSchema = z.union([
  roundingRuleSchema,
  z.object({ rules: z.array(roundingRuleSchema).min(1) }),
]);

export type RoundingRuleInput = z.infer<typeof roundingRuleSchema>;

// ── FR-119 / FR-715 / FR-725 users ───────────────────────────────────────────

export const userCreateSchema = z.object({
  name: shortText(120),
  email: emailSchema,
  phone: optionalText(20),
  role: userRoleSchema,
  password: z.string().min(8, 'Password must be at least 8 characters').max(72).optional(),
  branchIds: z.array(id).optional(),
  allBranches: z.boolean().optional(),
  status: userStatusSchema.optional(),
});

export const userUpdateSchema = z.object({
  name: shortText(120).optional(),
  phone: optionalText(20),
  role: userRoleSchema.optional(),
  password: z.string().min(8).max(72).optional(),
  branchIds: z.array(id).optional(),
  allBranches: z.boolean().optional(),
  status: userStatusSchema.optional(),
});

// ── FR-722 / FR-724 subscription ─────────────────────────────────────────────

export const planChangeSchema = z.object({
  planCode: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .transform((v) => v.toUpperCase()),
  seats: z.coerce.number().int().min(1).max(1000).optional(),
});

// ── FR-718 audit log ─────────────────────────────────────────────────────────

export const auditQuerySchema = z.object({
  entityType: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(60).optional(),
  action: z.string().trim().max(30).transform((v) => v.toUpperCase()).optional(),
  actorId: z.string().trim().max(60).optional(),
  actor: z.string().trim().max(160).optional(),
  branchId: z.string().trim().max(60).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
