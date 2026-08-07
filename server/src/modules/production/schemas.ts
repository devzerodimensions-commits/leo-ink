/**
 * Request validation for the jobcard & production module (zod v4).
 *
 * Covers FRD §5.1 (FR-300 multi-vertical jobcard, FR-301 quick jobcard,
 * FR-303 numbering, FR-304 delivery date / priority / rush), §5.2 (FR-305 job
 * bag), §5.3 (FR-306 workflow templates), §5.4 (FR-307 board, FR-308 stage
 * progression), §5.5 (FR-310 assignment, FR-311 my-jobs), §5.6 (FR-312 scan)
 * and §5.7 (FR-313 TAT & alerts).
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

export const verticalSchema = z.enum(['FLEX_LARGE_FORMAT', 'OFFSET', 'DIGITAL', 'SCREEN']);
export const prioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH']);
export const jobStatusSchema = z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']);

/** FR-300 — "size (width × height + unit, e.g. ft/inch/mm)"; a simple factor, not a conversion engine. */
export const sizeUnitSchema = z.enum(['ft', 'inch', 'mm']);

/** BR-1 — decimals never travel as JS floats; keep the string form. */
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

export function positiveDecimal(label: string) {
  return decimalInput(label).refine((v) => Number(v) > 0, { message: `${label} must be greater than zero` });
}

/** Accepts `YYYY-MM-DD` or a full ISO date-time; both resolve to a calendar day (BR-10). */
export const dateInputSchema = z
  .string()
  .trim()
  .refine((v) => /^\d{4}-\d{2}-\d{2}([T ][0-9:.+\-Z]*)?$/.test(v) && !Number.isNaN(Date.parse(v.length === 10 ? `${v}T00:00:00.000Z` : v)), {
    message: 'Date must be YYYY-MM-DD or an ISO date-time',
  });

/** Query strings arrive as text; accept the boolean form too so JSON bodies work. */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');

export const idSchema = z.uuid();

// ─────────────────────────────────────────────────────────────────────────────
// FR-306 — workflow templates
// ─────────────────────────────────────────────────────────────────────────────

export const workflowStageInputSchema = z.object({
  name: z.string().trim().min(1, 'Stage name is required').max(80),
  sequence: z.coerce.number().int().min(1).max(500).optional(),
  department: z.string().trim().max(60).optional().nullable(),
  isTerminal: z.boolean().default(false),
});

export const workflowTemplateCreateSchema = z.object({
  vertical: verticalSchema,
  name: z.string().trim().min(1, 'Template name is required').max(120),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
  stages: z.array(workflowStageInputSchema).min(1, 'A workflow needs at least one stage').max(40),
});

export const workflowTemplateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
  stages: z.array(workflowStageInputSchema).min(1, 'A workflow needs at least one stage').max(40).optional(),
});

export const workflowTemplateListQuerySchema = z.object({
  vertical: verticalSchema.optional(),
  active: z.enum(['true', 'false', 'all']).default('all'),
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-300 — spec items
// ─────────────────────────────────────────────────────────────────────────────

export const specItemSchema = z.object({
  lineNo: z.coerce.number().int().min(1).max(999).optional(),
  description: z.string().trim().min(1, 'Description is required').max(500),
  width: positiveDecimal('Width').optional(),
  height: positiveDecimal('Height').optional(),
  unit: sizeUnitSchema.optional(),
  substrate: z.string().trim().max(120).optional().nullable(),
  gsm: z.coerce.number().int().min(1).max(5000).optional().nullable(),
  /** e.g. 4/0, 4/4, "spot" */
  colours: z.string().trim().max(60).optional().nullable(),
  sides: z.coerce.number().int().min(1).max(2).optional().nullable(),
  quantity: positiveDecimal('Quantity').default('1'),
  /** FR-300 — "unknown finishing captured as free text". */
  finishing: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
  instructions: z.string().trim().max(2000).optional().nullable(),
  specJson: z.record(z.string(), z.unknown()).optional().nullable(),
  /** FR-233 — pricing carried from the source quote line, never re-keyed. */
  rate: nonNegativeDecimal('Rate').optional().nullable(),
  lineTaxable: nonNegativeDecimal('Taxable value').optional().nullable(),
  gstPct: nonNegativeDecimal('GST %').optional().nullable(),
  hsnSac: z.string().trim().max(10).optional().nullable(),
});

export type SpecItemInput = z.output<typeof specItemSchema>;
export type Vertical = z.output<typeof verticalSchema>;

export interface SpecFieldIssue {
  index: number;
  field: string;
  message: string;
}

/**
 * FR-300 business rules — the vertical decides which spec fields are mandatory.
 * Reported per field so the UI can flag exactly what is missing (FR-300 AC 2).
 */
export function specFieldIssues(vertical: Vertical, specs: SpecItemInput[]): SpecFieldIssue[] {
  const issues: SpecFieldIssue[] = [];
  specs.forEach((spec, index) => {
    const flag = (field: string, message: string) => issues.push({ index, field, message });

    if (vertical === 'FLEX_LARGE_FORMAT') {
      if (!spec.width) flag('width', 'Width is mandatory for Flex / Large-format');
      if (!spec.height) flag('height', 'Height is mandatory for Flex / Large-format');
      if (!spec.unit) flag('unit', 'Size unit (ft / inch / mm) is mandatory for Flex / Large-format');
    }

    if (vertical === 'OFFSET' || vertical === 'DIGITAL') {
      if (!spec.colours) flag('colours', 'Colours (e.g. 4/4) are mandatory for Offset / Digital');
      if (!spec.quantity) flag('quantity', 'Quantity is mandatory for Offset / Digital');
    }

    if (vertical === 'SCREEN' && !spec.colours) {
      flag('colours', 'Colours (number of screens) are mandatory for Screen printing');
    }
  });
  return issues;
}

function refineSpecs(vertical: Vertical, specs: SpecItemInput[], ctx: z.RefinementCtx): void {
  for (const issue of specFieldIssues(vertical, specs)) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: ['specs', issue.index, issue.field] });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-300 / FR-304 — full jobcard create
// ─────────────────────────────────────────────────────────────────────────────

const jobcardCreateShape = z.object({
  vertical: verticalSchema,
  customerId: idSchema,
  branchId: idSchema.optional(),
  templateId: idSchema.optional(),
  sourceQuoteId: idSchema.optional(),
  title: z.string().trim().max(200).optional().nullable(),
  /** FR-304 — delivery date is mandatory. */
  deliveryDate: dateInputSchema,
  priority: prioritySchema.default('NORMAL'),
  rushFlag: z.boolean().default(false),
  notes: z.string().trim().max(2000).optional().nullable(),
  /** FR-304 — a past delivery date is allowed only with an explicit override + reason. */
  override: z.boolean().default(false),
  overrideReason: z.string().trim().min(3).max(300).optional().nullable(),
  specs: z.array(specItemSchema).min(1, 'At least one spec item is required').max(200),
});

export const jobcardCreateSchema = jobcardCreateShape.superRefine((body, ctx) => {
  refineSpecs(body.vertical, body.specs, ctx);
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-301 — 15-second quick jobcard
// ─────────────────────────────────────────────────────────────────────────────

export const quickJobcardSchema = z
  .object({
    /** Either an existing customer … */
    customerId: idSchema.optional(),
    /** … or a name + mobile for the inline walk-in create (FR-301). */
    customer: z
      .object({
        name: z.string().trim().min(1, 'Customer name is required').max(160),
        phone: z.string().trim().min(6, 'Mobile number is required').max(20),
        placeOfSupplyState: z
          .string()
          .trim()
          .regex(/^[0-9]{2}$/, 'State code must be the 2-digit GST state code')
          .optional(),
      })
      .optional(),
    description: z.string().trim().min(1, 'A one-line job description is required').max(500),
    quantity: positiveDecimal('Quantity'),
    deliveryDate: dateInputSchema,
    vertical: verticalSchema.optional(),
    priority: prioritySchema.default('NORMAL'),
    rushFlag: z.boolean().default(false),
    branchId: idSchema.optional(),
    notes: z.string().trim().max(2000).optional().nullable(),
    override: z.boolean().default(false),
    overrideReason: z.string().trim().min(3).max(300).optional().nullable(),
  })
  .superRefine((body, ctx) => {
    if (!body.customerId && !body.customer) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide either customerId or a customer { name, phone } to create inline',
        path: ['customerId'],
      });
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Jobcard update — FR-303 (number immutable) / FR-309 (status not settable)
// ─────────────────────────────────────────────────────────────────────────────

export const jobcardUpdateSchema = z
  .object({
    /** Accepted so the service can reject a change attempt with 422 rather than silently ignore it. */
    jobcardNo: z.string().trim().max(40).optional(),
    overallStatus: jobStatusSchema.optional(),
    vertical: verticalSchema.optional(),
    customerId: idSchema.optional(),
    title: z.string().trim().max(200).optional().nullable(),
    deliveryDate: dateInputSchema.optional(),
    priority: prioritySchema.optional(),
    rushFlag: z.boolean().optional(),
    notes: z.string().trim().max(2000).optional().nullable(),
    specs: z.array(specItemSchema).min(1).max(200).optional(),
    override: z.boolean().default(false),
    overrideReason: z.string().trim().min(3).max(300).optional().nullable(),
  })
  .superRefine((body, ctx) => {
    if (body.specs && body.vertical) refineSpecs(body.vertical, body.specs, ctx);
  });

// ─────────────────────────────────────────────────────────────────────────────
// Lists, board and queues
// ─────────────────────────────────────────────────────────────────────────────

export const jobcardListQuerySchema = z.object({
  vertical: verticalSchema.optional(),
  status: jobStatusSchema.optional(),
  customerId: idSchema.optional(),
  priority: prioritySchema.optional(),
  rush: booleanish.optional(),
  dueToday: booleanish.optional(),
  overdue: booleanish.optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type JobcardListQuery = z.output<typeof jobcardListQuerySchema>;

export const boardQuerySchema = z.object({
  vertical: verticalSchema.optional(),
  department: z.string().trim().max(60).optional(),
  operatorId: idSchema.optional(),
  priority: prioritySchema.optional(),
  rush: booleanish.optional(),
  dueToday: booleanish.optional(),
  overdue: booleanish.optional(),
  /** FR-309 — done jobcards drop off the active board unless explicitly asked for. */
  includeDone: booleanish.optional(),
  q: z.string().trim().max(120).optional(),
});
export type BoardQuery = z.output<typeof boardQuerySchema>;

export const myJobsQuerySchema = z.object({
  department: z.string().trim().max(60).optional(),
  /** Also list stages assigned to the caller that are not yet the job's active stage. */
  includeUpcoming: booleanish.optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type MyJobsQuery = z.output<typeof myJobsQuerySchema>;

export const eventsQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(500).default(200),
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-308 / FR-310 / FR-312 — transitions, assignment, scan
// ─────────────────────────────────────────────────────────────────────────────

export const advanceSchema = z.object({
  /** Optional forward skip — the WorkflowStage id (or stage-progress id) to jump to. */
  toStageId: idSchema.optional(),
  note: z.string().trim().max(300).optional().nullable(),
});

export const revertSchema = z.object({
  toStageId: idSchema.optional(),
  note: z.string().trim().max(300).optional().nullable(),
});

export const assignSchema = z.object({
  operatorId: idSchema,
  note: z.string().trim().max(300).optional().nullable(),
});

export const scanSchema = z.object({
  token: z.string().trim().min(8, 'A scan token is required').max(200),
  action: z.enum(['open', 'advance']).default('open'),
  note: z.string().trim().max(300).optional().nullable(),
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-313 — TAT
// ─────────────────────────────────────────────────────────────────────────────

export const tatQuerySchema = z.object({
  filter: z.enum(['due-today', 'overdue', 'all']).default('all'),
  vertical: verticalSchema.optional(),
  pageSize: z.coerce.number().int().min(1).max(500).default(200),
});
export type TatQuery = z.output<typeof tatQuerySchema>;

export const tatAlertSchema = z.object({
  filter: z.enum(['due-today', 'overdue', 'all']).default('all'),
  /** Re-send even when an alert of the same kind already went out today. */
  force: z.boolean().default(false),
});
export type TatAlertInput = z.output<typeof tatAlertSchema>;
