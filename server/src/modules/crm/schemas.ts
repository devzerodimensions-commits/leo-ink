/**
 * Request validation for the CRM module (zod v4).
 *
 * FRD §4.1 — FR-200 (unified enquiry/lead inbox), FR-203 (follow-up reminders
 * and to-dos) and the FR-220 enquiry → quotation conversion payload.
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** `walk-in`, `Walk In`, `WALK_IN` all mean the same channel to a web form. */
const slug = (value: string): string => value.trim().toUpperCase().replace(/[\s\-/.]+/g, '_');

const SOURCE_VALUES = ['WALK_IN', 'PHONE', 'WHATSAPP', 'EMAIL', 'WEB_FORM'] as const;
export type EnquirySourceValue = (typeof SOURCE_VALUES)[number];

/** FR-200 — "source (walk-in | phone | whatsapp | email | web_form)". */
const SOURCE_ALIASES: Record<string, EnquirySourceValue> = {
  WALK_IN: 'WALK_IN',
  WALKIN: 'WALK_IN',
  WALK: 'WALK_IN',
  COUNTER: 'WALK_IN',
  PHONE: 'PHONE',
  CALL: 'PHONE',
  TELEPHONE: 'PHONE',
  MOBILE: 'PHONE',
  WHATSAPP: 'WHATSAPP',
  WA: 'WHATSAPP',
  EMAIL: 'EMAIL',
  MAIL: 'EMAIL',
  WEB_FORM: 'WEB_FORM',
  WEBFORM: 'WEB_FORM',
  WEB: 'WEB_FORM',
  WEBSITE: 'WEB_FORM',
  FORM: 'WEB_FORM',
};

export const enquirySourceSchema = z
  .string()
  .transform((v) => SOURCE_ALIASES[slug(v)] ?? slug(v))
  .pipe(z.enum(SOURCE_VALUES));

const VERTICAL_VALUES = ['FLEX_LARGE_FORMAT', 'OFFSET', 'DIGITAL', 'SCREEN'] as const;
export type VerticalValue = (typeof VERTICAL_VALUES)[number];

/** FR-200 — "product type (flex/large-format | offset | digital | screen)". */
const VERTICAL_ALIASES: Record<string, VerticalValue> = {
  FLEX_LARGE_FORMAT: 'FLEX_LARGE_FORMAT',
  FLEX: 'FLEX_LARGE_FORMAT',
  FLEX_LARGEFORMAT: 'FLEX_LARGE_FORMAT',
  LARGE_FORMAT: 'FLEX_LARGE_FORMAT',
  LARGEFORMAT: 'FLEX_LARGE_FORMAT',
  OFFSET: 'OFFSET',
  DIGITAL: 'DIGITAL',
  SCREEN: 'SCREEN',
  SCREEN_PRINT: 'SCREEN',
};

export const verticalSchema = z
  .string()
  .transform((v) => VERTICAL_ALIASES[slug(v)] ?? slug(v))
  .pipe(z.enum(VERTICAL_VALUES));

const STATUS_VALUES = ['NEW', 'CONTACTED', 'QUOTED', 'WON', 'LOST'] as const;
export type EnquiryStatusValue = (typeof STATUS_VALUES)[number];

/** FR-200 — "New → Contacted → Quoted → Won → Lost". */
export const enquiryStatusSchema = z
  .string()
  .transform((v) => slug(v))
  .pipe(z.enum(STATUS_VALUES));

export const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD form');

const phoneSchema = z.string().trim().min(4).max(20);
const nameSchema = z.string().trim().min(1).max(120);
const descriptionSchema = z.string().trim().max(4000);

const pagingSchema = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
};

// ─────────────────────────────────────────────────────────────────────────────
// FR-200 — enquiry inbox
// ─────────────────────────────────────────────────────────────────────────────

export const enquiryCreateSchema = z.object({
  source: enquirySourceSchema,
  contactName: nameSchema,
  /** FR-200 — "phone is mandatory, email optional". */
  phone: phoneSchema,
  email: z.email().max(160).optional().nullable(),
  vertical: verticalSchema,
  description: descriptionSchema.optional().nullable(),
  /** FR-200 — "an enquiry may exist before a Customer record". */
  customerId: z.uuid().optional().nullable(),
  assignedTo: z.uuid().optional().nullable(),
  receivedAt: z.coerce.date().optional(),
  status: enquiryStatusSchema.optional(),
  lostReason: z.string().trim().max(500).optional().nullable(),
});
export type EnquiryCreateInput = z.output<typeof enquiryCreateSchema>;

export const enquiryUpdateSchema = enquiryCreateSchema.partial();
export type EnquiryUpdateInput = z.output<typeof enquiryUpdateSchema>;

/**
 * FR-200 — inbound web-form / WhatsApp intake. Public-*shaped* (loose field
 * names, minimal required data) but still authenticated in Phase 1.
 */
export const enquiryIntakeSchema = z
  .object({
    source: enquirySourceSchema.optional(),
    name: nameSchema.optional(),
    contactName: nameSchema.optional(),
    phone: phoneSchema,
    email: z.email().max(160).optional().nullable(),
    vertical: verticalSchema.optional(),
    productType: verticalSchema.optional(),
    description: descriptionSchema.optional().nullable(),
    message: descriptionSchema.optional().nullable(),
    assignedTo: z.uuid().optional().nullable(),
    receivedAt: z.coerce.date().optional(),
  })
  .refine((v) => Boolean(v.contactName ?? v.name), {
    message: 'contactName is required',
    path: ['contactName'],
  });
export type EnquiryIntakeInput = z.output<typeof enquiryIntakeSchema>;

export const enquiryListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  source: enquirySourceSchema.optional(),
  status: enquiryStatusSchema.optional(),
  vertical: verticalSchema.optional(),
  assignedTo: z.uuid().optional(),
  customerId: z.uuid().optional(),
  /** Only enquiries that have not reached Won/Lost. */
  open: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  ...pagingSchema,
});
export type EnquiryListQuery = z.output<typeof enquiryListQuerySchema>;

/** FR-220 — one-click enquiry → quotation. */
export const convertToQuoteSchema = z.object({
  /** Supplied when the enquiry carries no customer yet (FR-220 AC 2). */
  customerId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  quoteDate: isoDateSchema.optional(),
  placeOfSupplyState: z
    .string()
    .trim()
    .regex(/^[0-9]{2}$/, 'State code must be the 2-digit GST state code')
    .optional(),
  validUntil: isoDateSchema.optional(),
});
export type ConvertToQuoteInput = z.output<typeof convertToQuoteSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// FR-203 — follow-ups
// ─────────────────────────────────────────────────────────────────────────────

export const followUpCreateSchema = z.object({
  /** FR-203 — "belongs to exactly one parent (enquiry or quote)". */
  enquiryId: z.uuid().optional().nullable(),
  quoteId: z.uuid().optional().nullable(),
  dueAt: z.coerce.date(),
  note: z.string().trim().min(1).max(2000),
  assignedTo: z.uuid().optional(),
});
export type FollowUpCreateInput = z.output<typeof followUpCreateSchema>;

export const followUpListQuerySchema = z.object({
  status: z
    .string()
    .transform((v) => slug(v))
    .pipe(z.enum(['OPEN', 'CLOSED', 'ALL']))
    .optional(),
  assignedTo: z.uuid().optional(),
  enquiryId: z.uuid().optional(),
  quoteId: z.uuid().optional(),
  overdue: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
  ...pagingSchema,
});
export type FollowUpListQuery = z.output<typeof followUpListQuerySchema>;

/** FR-203 — "Closing a follow-up requires an outcome note." */
export const followUpCloseSchema = z.object({
  outcome: z.string().trim().max(2000).optional().nullable(),
});
export type FollowUpCloseInput = z.output<typeof followUpCloseSchema>;

/** Phase-1 notification path: stamp notifiedAt and log the WhatsApp message. */
export const followUpNotifySchema = z.object({
  message: z.string().trim().max(1000).optional(),
  toAddress: z.string().trim().max(160).optional(),
});
export type FollowUpNotifyInput = z.output<typeof followUpNotifySchema>;
