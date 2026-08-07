/**
 * Jobcard & production services — FRD §5 (FR-300 … FR-313).
 *
 * BR-1  every decimal is handled as a fixed-precision value and serialised as a
 *       string; Prisma decimal columns receive `.toFixed(2)` / `.toFixed(4)`.
 * BR-4  every query filters on `tenantId`; a branch-scoped document also runs
 *       through `assertBranchAccess`, so a foreign record 404s/403s rather than
 *       leaking.
 * BR-11 workflow templates are deactivated, never hard-deleted once referenced.
 */
import crypto from 'node:crypto';
import type { EventSource, JobStatus, Prisma, StageStatus, UserRole, Vertical } from '@prisma/client';
import { prisma } from '../../db.js';
import { env } from '../../env.js';
import type { AuthContext } from '../../auth/middleware.js';
import { assertBranchAccess } from '../../auth/middleware.js';
import { ASSIGNABLE_ROLES, can } from '../../auth/permissions.js';
import { conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { D, money, rate } from '../../lib/money.js';
import { addDays, tenantToday, toDateOnly } from '../../lib/fy.js';
import { allocateNumber } from '../../lib/numbering.js';
import { recordAudit } from '../setup/audit.js';
import {
  activeProgress,
  branchScope,
  boardJobcardInclude,
  compareCards,
  dueFlags,
  rollUpStatus,
  toCard,
  type BoardCard,
  type StageProgressLike,
} from './board.js';
import { specFieldIssues } from './schemas.js';
import type { z } from 'zod';
import type {
  JobcardListQuery,
  MyJobsQuery,
  SpecItemInput,
  TatAlertInput,
  TatQuery,
  advanceSchema,
  assignSchema,
  jobcardCreateSchema,
  jobcardUpdateSchema,
  quickJobcardSchema,
  revertSchema,
  scanSchema,
  workflowStageInputSchema,
  workflowTemplateCreateSchema,
  workflowTemplateListQuerySchema,
  workflowTemplateUpdateSchema,
} from './schemas.js';

type Db = Prisma.TransactionClient;

type JobcardCreateInput = z.output<typeof jobcardCreateSchema>;
type JobcardUpdateInput = z.output<typeof jobcardUpdateSchema>;
type QuickJobcardInput = z.output<typeof quickJobcardSchema>;
type WorkflowTemplateCreateInput = z.output<typeof workflowTemplateCreateSchema>;
type WorkflowTemplateUpdateInput = z.output<typeof workflowTemplateUpdateSchema>;
type WorkflowTemplateListQuery = z.output<typeof workflowTemplateListQuerySchema>;
type WorkflowStageInput = z.output<typeof workflowStageInputSchema>;
type AdvanceInput = z.output<typeof advanceSchema>;
type RevertInput = z.output<typeof revertSchema>;
type AssignInput = z.output<typeof assignSchema>;
type ScanInput = z.output<typeof scanSchema>;

/** FR-308 — "skipping/moving backward is allowed only for authorized roles." */
const MOVE_AUTHORISED_ROLES: UserRole[] = ['OWNER_ADMIN', 'PRODUCTION_MANAGER'];

// ─────────────────────────────────────────────────────────────────────────────
// Serialisation helpers (BR-1 — decimals leave as strings, never JS numbers)
// ─────────────────────────────────────────────────────────────────────────────

type DecimalLike = { toString(): string } | string | number | null | undefined;

const m2n = (v: DecimalLike): string | null => (v === null || v === undefined ? null : money(v.toString()));
const r4 = (v: DecimalLike): string => rate(v === null || v === undefined ? '0' : v.toString());
const r4n = (v: DecimalLike): string | null => (v === null || v === undefined ? null : rate(v.toString()));

const isoTs = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

function parseDateInput(value: string): Date {
  const iso = value.length === 10 ? `${value}T00:00:00.000Z` : value;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) throw unprocessable(`"${value}" is not a valid date`, 'INVALID_DATE');
  return parsed;
}

function jsonOrUndefined(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const serialised = JSON.stringify(value);
    if (serialised === undefined) return undefined;
    return JSON.parse(serialised) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-300 — vertical-conditional spec maths
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FR-300 — "area (sq ft) is auto-derived from width × height × quantity using a
 * simple unit factor (no unit-conversion engine)". 1 sq.ft = 144 sq.in =
 * 92903.04 sq.mm.
 */
const SQFT_PER_UNIT_SQUARED: Record<string, string> = {
  ft: '1',
  inch: '0.00694444444444444444',
  mm: '0.00001076391041670972',
};

export function deriveAreaSqft(
  width: string | null | undefined,
  height: string | null | undefined,
  unit: string | null | undefined,
  quantity: string,
): string | null {
  if (!width || !height || !unit) return null;
  const factor = SQFT_PER_UNIT_SQUARED[unit];
  if (!factor) return null;
  return D(width).times(D(height)).times(D(factor)).times(D(quantity)).toDecimalPlaces(4).toFixed(4);
}

/** "4/4" ⇒ printed both sides, "4/0" ⇒ single side. Explicit input always wins. */
function deriveSides(colours: string | null | undefined, sides: number | null | undefined): number | null {
  if (sides !== null && sides !== undefined) return sides;
  if (!colours) return null;
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(colours.trim());
  if (!match) return null;
  return Number(match[2]) > 0 ? 2 : 1;
}

/** FR-300 — reject a spec set that does not satisfy its vertical's mandatory fields. */
function assertVerticalSpecs(vertical: Vertical, specs: SpecItemInput[]): void {
  const issues = specFieldIssues(vertical, specs);
  if (issues.length === 0) return;
  throw unprocessable(
    `The ${vertical} specification is incomplete`,
    'SPEC_INCOMPLETE',
    { fields: issues.map((i) => ({ field: `specs.${i.index}.${i.field}`, message: i.message })) },
  );
}

/** FR-304 — "a past date is rejected on create (allowed only via explicit override with reason)." */
function assertDeliveryDate(
  deliveryDate: Date,
  override: boolean,
  overrideReason: string | null | undefined,
  today: Date = tenantToday(),
): void {
  if (toDateOnly(deliveryDate).getTime() >= today.getTime()) return;
  if (override && overrideReason && overrideReason.trim().length >= 3) return;
  throw unprocessable(
    'The delivery date is in the past. Set override:true with an overrideReason to book it anyway.',
    'PAST_DELIVERY_DATE',
    { deliveryDate: isoDay(toDateOnly(deliveryDate)), today: isoDay(today) },
  );
}

function specRowData(
  tenantId: string,
  spec: SpecItemInput,
  lineNo: number,
): Prisma.JobcardSpecItemCreateManyJobcardInput {
  const quantity = spec.quantity ?? '1';
  const area = deriveAreaSqft(spec.width, spec.height, spec.unit, quantity);
  return {
    tenantId,
    lineNo,
    description: spec.description,
    width: spec.width ? D(spec.width).toDecimalPlaces(4).toFixed(4) : null,
    height: spec.height ? D(spec.height).toDecimalPlaces(4).toFixed(4) : null,
    unit: spec.unit ?? null,
    areaSqft: area,
    substrate: spec.substrate ?? null,
    gsm: spec.gsm ?? null,
    colours: spec.colours ?? null,
    sides: deriveSides(spec.colours, spec.sides),
    quantity: D(quantity).toDecimalPlaces(4).toFixed(4),
    finishing: spec.finishing ?? [],
    instructions: spec.instructions ?? null,
    rate: spec.rate ? D(spec.rate).toDecimalPlaces(4).toFixed(4) : null,
    lineTaxable: spec.lineTaxable ? D(spec.lineTaxable).toDecimalPlaces(2).toFixed(2) : null,
    gstPct: spec.gstPct ? D(spec.gstPct).toDecimalPlaces(4).toFixed(4) : null,
    hsnSac: spec.hsnSac ?? null,
    specJson: jsonOrUndefined(spec.specJson),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Context resolution (branch / FY / numbering / template)
// ─────────────────────────────────────────────────────────────────────────────

async function resolveBranch(db: Db, auth: AuthContext, requested?: string): Promise<{ id: string; branchCode: string }> {
  if (requested) {
    const branch = await db.branch.findFirst({
      where: { id: requested, tenantId: auth.tenantId },
      select: { id: true, branchCode: true },
    });
    if (!branch) throw notFound('Branch not found');
    assertBranchAccess(auth, branch.id); // FR-717
    return branch;
  }

  if (!auth.allBranches && auth.branchIds.length > 0) {
    const mine = await db.branch.findFirst({
      where: { id: { in: auth.branchIds }, tenantId: auth.tenantId, active: true },
      select: { id: true, branchCode: true },
      orderBy: [{ isHeadOffice: 'desc' }, { branchCode: 'asc' }],
    });
    if (mine) return mine;
  }

  const fallback = await db.branch.findFirst({
    where: { tenantId: auth.tenantId, active: true },
    select: { id: true, branchCode: true },
    orderBy: [{ isHeadOffice: 'desc' }, { branchCode: 'asc' }],
  });
  if (!fallback) throw unprocessable('No active branch is configured for this firm', 'BRANCH_MISSING');
  assertBranchAccess(auth, fallback.id);
  return fallback;
}

async function resolveFy(db: Db, tenantId: string, on: Date): Promise<{ id: string; fyLabel: string }> {
  const day = toDateOnly(on);
  const containing = await db.financialYear.findFirst({
    where: { tenantId, startDate: { lte: day }, endDate: { gte: day } },
    select: { id: true, fyLabel: true },
  });
  if (containing) return containing;

  const current = await db.financialYear.findFirst({
    where: { tenantId, isCurrent: true },
    select: { id: true, fyLabel: true },
  });
  if (current) return current;

  throw unprocessable('No financial year is configured — add one in Settings → Financial Year', 'FY_MISSING');
}

/**
 * FR-303 — allocate the jobcard number from the most specific active series
 * (branch+FY → branch → FY → tenant-wide) inside the caller's transaction so
 * the sequence stays gap-free under concurrency.
 */
async function allocateJobcardNo(
  tx: Db,
  tenantId: string,
  branchId: string,
  fyId: string,
  branchCode: string,
  fyLabel: string,
): Promise<string> {
  const series = await tx.numberingSeries.findMany({
    where: { tenantId, docType: 'JOBCARD', active: true },
    select: { branchId: true, fyId: true },
  });
  const match =
    series.find((s) => s.branchId === branchId && s.fyId === fyId) ??
    series.find((s) => s.branchId === branchId && s.fyId === null) ??
    series.find((s) => s.branchId === null && s.fyId === fyId) ??
    series.find((s) => s.branchId === null && s.fyId === null);
  if (!match) {
    throw unprocessable(
      'No active numbering series configured for JOBCARD. Add one in Settings → Document Numbering.',
      'NUMBERING_SERIES_MISSING',
    );
  }
  const allocated = await allocateNumber({
    tx,
    tenantId,
    docType: 'JOBCARD',
    branchId: match.branchId,
    fyId: match.fyId,
    branchCode,
    fyLabel,
  });
  return allocated.number;
}

interface ResolvedTemplate {
  id: string;
  vertical: Vertical;
  name: string;
  stages: Array<{ id: string; name: string; sequence: number; department: string | null; isTerminal: boolean }>;
}

async function resolveTemplate(
  db: Db,
  tenantId: string,
  vertical: Vertical,
  templateId?: string,
): Promise<ResolvedTemplate> {
  const stageSelect = {
    select: { id: true, name: true, sequence: true, department: true, isTerminal: true },
    orderBy: { sequence: 'asc' as const },
  };

  if (templateId) {
    const chosen = await db.workflowTemplate.findFirst({
      where: { id: templateId, tenantId },
      select: { id: true, vertical: true, name: true, active: true, stages: stageSelect },
    });
    if (!chosen) throw notFound('Workflow template not found');
    if (!chosen.active) throw unprocessable('That workflow template is no longer active', 'TEMPLATE_INACTIVE');
    if (chosen.stages.length === 0) throw unprocessable('That workflow template has no stages', 'TEMPLATE_EMPTY');
    return chosen;
  }

  // FR-306 — "Each vertical has one active default workflow template".
  const template = await db.workflowTemplate.findFirst({
    where: { tenantId, vertical, active: true },
    select: { id: true, vertical: true, name: true, stages: stageSelect },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  if (!template || template.stages.length === 0) {
    throw unprocessable(
      `No active workflow template is configured for ${vertical}. Add one in Settings → Production Workflow.`,
      'WORKFLOW_TEMPLATE_MISSING',
    );
  }
  return template;
}

/** FR-306 — the stages are snapshotted onto the jobcard so a later template edit cannot strand it. */
function progressRowsFor(tenantId: string, template: ResolvedTemplate): Prisma.JobStageProgressCreateManyJobcardInput[] {
  return template.stages.map((stage) => ({
    tenantId,
    stageId: stage.id,
    stageName: stage.name,
    sequence: stage.sequence,
    department: stage.department,
    isTerminal: stage.isTerminal,
    status: 'PENDING' as StageStatus,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading & serialising
// ─────────────────────────────────────────────────────────────────────────────

const jobcardDetailInclude = {
  customer: {
    select: { id: true, name: true, phone: true, email: true, gstin: true, billingAddress: true, billingCity: true, billingPincode: true, placeOfSupplyState: true },
  },
  branch: { select: { id: true, branchCode: true, name: true } },
  specs: { orderBy: { lineNo: 'asc' } },
  progress: { orderBy: { sequence: 'asc' }, include: { operator: { select: { id: true, name: true } } } },
  template: { select: { id: true, name: true, vertical: true } },
  qrToken: { select: { token: true, printedAt: true } },
} satisfies Prisma.JobcardInclude;

type JobcardDetail = Prisma.JobcardGetPayload<{ include: typeof jobcardDetailInclude }>;

/** BR-4 — a jobcard belonging to another tenant is simply not found. */
async function loadJobcard(db: Db, auth: AuthContext, id: string): Promise<JobcardDetail> {
  const jobcard = await db.jobcard.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: jobcardDetailInclude,
  });
  if (!jobcard) throw notFound('Jobcard not found');
  assertBranchAccess(auth, jobcard.branchId); // FR-717
  return jobcard;
}

function serializeSpec(spec: JobcardDetail['specs'][number]) {
  return {
    id: spec.id,
    lineNo: spec.lineNo,
    description: spec.description,
    width: r4n(spec.width),
    height: r4n(spec.height),
    unit: spec.unit,
    areaSqft: r4n(spec.areaSqft),
    substrate: spec.substrate,
    gsm: spec.gsm,
    colours: spec.colours,
    sides: spec.sides,
    quantity: r4(spec.quantity),
    finishing: spec.finishing,
    instructions: spec.instructions,
    specJson: spec.specJson,
    rate: r4n(spec.rate),
    lineTaxable: m2n(spec.lineTaxable),
    gstPct: r4n(spec.gstPct),
    hsnSac: spec.hsnSac,
  };
}

function serializeStage(row: JobcardDetail['progress'][number]) {
  return {
    id: row.id,
    stageId: row.stageId,
    name: row.stageName,
    stageName: row.stageName,
    sequence: row.sequence,
    department: row.department,
    isTerminal: row.isTerminal,
    status: row.status,
    assignedOperatorId: row.assignedOperatorId,
    assignedOperatorName: row.operator?.name ?? null,
    operator: row.operator ? { id: row.operator.id, name: row.operator.name } : null,
    startedAt: isoTs(row.startedAt),
    completedAt: isoTs(row.completedAt),
    updatedBy: row.updatedBy,
  };
}

function serializeJobcard(jobcard: JobcardDetail, today: Date = tenantToday()) {
  const active = activeProgress(jobcard.progress);
  const flags = dueFlags(jobcard.deliveryDate, jobcard.overallStatus, today);
  const totalQuantity = jobcard.specs.reduce((acc, s) => acc.plus(D(s.quantity.toString())), D(0));

  return {
    id: jobcard.id,
    jobcardNo: jobcard.jobcardNo,
    vertical: jobcard.vertical,
    title: jobcard.title,
    branchId: jobcard.branchId,
    branch: jobcard.branch,
    customerId: jobcard.customerId,
    customer: jobcard.customer,
    sourceQuoteId: jobcard.sourceQuoteId,
    templateId: jobcard.templateId,
    template: jobcard.template,
    deliveryDate: jobcard.deliveryDate.toISOString(),
    priority: jobcard.priority,
    rushFlag: jobcard.rushFlag,
    overallStatus: jobcard.overallStatus,
    specIncomplete: jobcard.specIncomplete,
    isQuick: jobcard.isQuick,
    completedAt: isoTs(jobcard.completedAt),
    notes: jobcard.notes,
    createdBy: jobcard.createdBy,
    createdAt: jobcard.createdAt.toISOString(),
    updatedAt: jobcard.updatedAt.toISOString(),
    dueToday: flags.dueToday,
    overdue: flags.overdue,
    totalQuantity: totalQuantity.toDecimalPlaces(4).toFixed(4),
    currentStage: active ? serializeStage(active) : null,
    specs: jobcard.specs.map(serializeSpec),
    /** FR-306 — the stage snapshot this jobcard is running on. */
    progress: jobcard.progress.map(serializeStage),
    qrToken: jobcard.qrToken?.token ?? null,
    printedAt: isoTs(jobcard.qrToken?.printedAt ?? null),
    qr: jobcard.qrToken ? qrPayload(jobcard.qrToken.token, jobcard.qrToken.printedAt) : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-306 — workflow templates
// ─────────────────────────────────────────────────────────────────────────────

interface NormalStage {
  name: string;
  sequence: number;
  department: string | null;
  isTerminal: boolean;
}

/**
 * FR-306 — "stages are ordered and must include at least one terminal
 * (completion) stage"; a template without one is rejected.
 */
function normaliseStages(stages: WorkflowStageInput[]): NormalStage[] {
  const ordered = stages
    .map((stage, index) => ({ stage, sortKey: stage.sequence ?? index + 1, index }))
    .sort((a, b) => a.sortKey - b.sortKey || a.index - b.index);

  if (!ordered.some((s) => s.stage.isTerminal)) {
    throw unprocessable(
      'A workflow must include at least one terminal (completion) stage',
      'NO_TERMINAL_STAGE',
      { fields: [{ field: 'stages', message: 'Mark the completing stage with isTerminal: true' }] },
    );
  }

  const names = new Set<string>();
  return ordered.map((entry, position) => {
    const key = entry.stage.name.toLowerCase();
    if (names.has(key)) throw conflict(`Stage "${entry.stage.name}" is listed twice`, 'DUPLICATE_STAGE');
    names.add(key);
    return {
      name: entry.stage.name,
      sequence: position + 1,
      department: entry.stage.department ?? null,
      isTerminal: entry.stage.isTerminal,
    };
  });
}

const templateSelect = {
  id: true,
  vertical: true,
  name: true,
  isDefault: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  stages: {
    select: { id: true, name: true, sequence: true, department: true, isTerminal: true },
    orderBy: { sequence: 'asc' as const },
  },
} satisfies Prisma.WorkflowTemplateSelect;

type TemplateRow = Prisma.WorkflowTemplateGetPayload<{ select: typeof templateSelect }>;

function serializeTemplate(template: TemplateRow, jobcardCount?: number) {
  return {
    id: template.id,
    vertical: template.vertical,
    name: template.name,
    isDefault: template.isDefault,
    active: template.active,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
    jobcardCount: jobcardCount ?? undefined,
    stages: template.stages.map((s) => ({
      id: s.id,
      name: s.name,
      sequence: s.sequence,
      department: s.department,
      isTerminal: s.isTerminal,
    })),
  };
}

export async function listWorkflowTemplates(auth: AuthContext, query: WorkflowTemplateListQuery) {
  const where: Prisma.WorkflowTemplateWhereInput = { tenantId: auth.tenantId };
  if (query.vertical) where.vertical = query.vertical;
  if (query.active !== 'all') where.active = query.active === 'true';

  const templates = await prisma.workflowTemplate.findMany({
    where,
    select: templateSelect,
    orderBy: [{ vertical: 'asc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  return { data: templates.map((t) => serializeTemplate(t)), total: templates.length };
}

export async function getWorkflowTemplate(auth: AuthContext, id: string) {
  const template = await prisma.workflowTemplate.findFirst({
    where: { id, tenantId: auth.tenantId },
    select: templateSelect,
  });
  if (!template) throw notFound('Workflow template not found');
  const jobcardCount = await prisma.jobcard.count({ where: { tenantId: auth.tenantId, templateId: id } });
  return serializeTemplate(template, jobcardCount);
}

export async function createWorkflowTemplate(auth: AuthContext, input: WorkflowTemplateCreateInput) {
  const stages = normaliseStages(input.stages);

  const created = await prisma.$transaction(async (tx) => {
    const existingActive = await tx.workflowTemplate.count({
      where: { tenantId: auth.tenantId, vertical: input.vertical, active: true },
    });
    // FR-306 — each vertical carries one active default template.
    const isDefault = input.isDefault || existingActive === 0;
    if (isDefault) {
      await tx.workflowTemplate.updateMany({
        where: { tenantId: auth.tenantId, vertical: input.vertical, isDefault: true },
        data: { isDefault: false },
      });
    }

    const template = await tx.workflowTemplate.create({
      data: {
        tenantId: auth.tenantId,
        vertical: input.vertical,
        name: input.name,
        isDefault,
        active: input.active,
        stages: { create: stages.map((s) => ({ tenantId: auth.tenantId, ...s })) },
      },
      select: templateSelect,
    });

    await recordAudit({
      tenantId: auth.tenantId,
      entityType: 'WorkflowTemplate',
      entityId: template.id,
      action: 'CREATE',
      actorId: auth.userId,
      after: { vertical: template.vertical, name: template.name, isDefault: template.isDefault, stages: stages.length },
      tx,
    });

    return template;
  });

  return serializeTemplate(created);
}

export async function updateWorkflowTemplate(auth: AuthContext, id: string, input: WorkflowTemplateUpdateInput) {
  const stages = input.stages ? normaliseStages(input.stages) : null;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.workflowTemplate.findFirst({
      where: { id, tenantId: auth.tenantId },
      select: { id: true, vertical: true, name: true, isDefault: true, active: true },
    });
    if (!existing) throw notFound('Workflow template not found');

    const inFlight = stages
      ? await tx.jobcard.count({ where: { tenantId: auth.tenantId, templateId: id } })
      : 0;

    const wantsDefault = input.isDefault ?? existing.isDefault;

    /**
     * FR-306 — "Editing a template affects newly created jobcards; in-flight
     * jobcards retain the template they started on (snapshot)." Once a jobcard
     * has run on this template its stage rows must survive, so a structural
     * edit supersedes the template with a new revision instead of rewriting it.
     */
    if (stages && inFlight > 0) {
      await tx.workflowTemplate.update({ where: { id }, data: { isDefault: false, active: false } });
      if (wantsDefault) {
        await tx.workflowTemplate.updateMany({
          where: { tenantId: auth.tenantId, vertical: existing.vertical, isDefault: true },
          data: { isDefault: false },
        });
      }
      const revision = await tx.workflowTemplate.create({
        data: {
          tenantId: auth.tenantId,
          vertical: existing.vertical,
          name: input.name ?? existing.name,
          isDefault: wantsDefault,
          active: input.active ?? true,
          stages: { create: stages.map((s) => ({ tenantId: auth.tenantId, ...s })) },
        },
        select: templateSelect,
      });

      await recordAudit({
        tenantId: auth.tenantId,
        entityType: 'WorkflowTemplate',
        entityId: revision.id,
        action: 'UPDATE',
        actorId: auth.userId,
        before: { supersededTemplateId: id, inFlightJobcards: inFlight },
        after: { vertical: revision.vertical, name: revision.name, stages: stages.length },
        tx,
      });

      return { ...serializeTemplate(revision), supersededTemplateId: id, inFlightJobcards: inFlight };
    }

    if (stages) {
      await tx.workflowStage.deleteMany({ where: { templateId: id } });
      await tx.workflowStage.createMany({
        data: stages.map((s) => ({ tenantId: auth.tenantId, templateId: id, ...s })),
      });
    }

    if (wantsDefault && !existing.isDefault) {
      await tx.workflowTemplate.updateMany({
        where: { tenantId: auth.tenantId, vertical: existing.vertical, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }

    const updated = await tx.workflowTemplate.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        isDefault: input.isDefault ?? undefined,
        active: input.active ?? undefined,
      },
      select: templateSelect,
    });

    await recordAudit({
      tenantId: auth.tenantId,
      entityType: 'WorkflowTemplate',
      entityId: id,
      action: 'UPDATE',
      actorId: auth.userId,
      before: { name: existing.name, isDefault: existing.isDefault, active: existing.active },
      after: { name: updated.name, isDefault: updated.isDefault, active: updated.active, stages: updated.stages.length },
      tx,
    });

    return { ...serializeTemplate(updated), supersededTemplateId: null, inFlightJobcards: 0 };
  });
}

/** BR-11 — a referenced template is deactivated, never hard-deleted. */
export async function deleteWorkflowTemplate(auth: AuthContext, id: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.workflowTemplate.findFirst({
      where: { id, tenantId: auth.tenantId },
      select: { id: true, vertical: true, isDefault: true, active: true, name: true },
    });
    if (!existing) throw notFound('Workflow template not found');

    const jobcardCount = await tx.jobcard.count({ where: { tenantId: auth.tenantId, templateId: id } });

    const deactivated = await tx.workflowTemplate.update({
      where: { id },
      data: { active: false, isDefault: false },
      select: templateSelect,
    });

    // Keep the vertical usable: promote the next active template to default.
    let promotedTemplateId: string | null = null;
    if (existing.isDefault) {
      const next = await tx.workflowTemplate.findFirst({
        where: { tenantId: auth.tenantId, vertical: existing.vertical, active: true, id: { not: id } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (next) {
        await tx.workflowTemplate.update({ where: { id: next.id }, data: { isDefault: true } });
        promotedTemplateId = next.id;
      }
    }

    await recordAudit({
      tenantId: auth.tenantId,
      entityType: 'WorkflowTemplate',
      entityId: id,
      action: 'DELETE',
      actorId: auth.userId,
      before: { name: existing.name, active: existing.active, isDefault: existing.isDefault },
      after: { active: false, isDefault: false, promotedTemplateId },
      tx,
    });

    return { ...serializeTemplate(deactivated), deactivated: true, jobcardCount, promotedTemplateId };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-300 / FR-301 / FR-302 — jobcard creation
// ─────────────────────────────────────────────────────────────────────────────

interface CreateArgs {
  tx: Db;
  auth: AuthContext;
  vertical: Vertical;
  customerId: string;
  branchId: string;
  branchCode: string;
  fyId: string;
  fyLabel: string;
  templateId?: string;
  title: string | null;
  deliveryDate: Date;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  rushFlag: boolean;
  notes: string | null;
  specs: SpecItemInput[];
  sourceQuoteId?: string | null;
  isQuick?: boolean;
  specIncomplete?: boolean;
  source: EventSource;
  eventNote?: string | null;
}

/** The one place a Jobcard row is born — FR-303 numbering + FR-306 stage snapshot + `created` event. */
async function insertJobcard(args: CreateArgs): Promise<{ id: string; jobcardNo: string }> {
  const { tx, auth } = args;
  const template = await resolveTemplate(tx, auth.tenantId, args.vertical, args.templateId);

  const customer = await tx.customer.findFirst({
    where: { id: args.customerId, tenantId: auth.tenantId },
    select: { id: true, active: true },
  });
  if (!customer) throw notFound('Customer not found');

  const jobcardNo = await allocateJobcardNo(
    tx,
    auth.tenantId,
    args.branchId,
    args.fyId,
    args.branchCode,
    args.fyLabel,
  );

  const jobcard = await tx.jobcard.create({
    data: {
      tenantId: auth.tenantId,
      branchId: args.branchId,
      fyId: args.fyId,
      jobcardNo,
      vertical: args.vertical,
      customerId: args.customerId,
      sourceQuoteId: args.sourceQuoteId ?? null,
      templateId: template.id,
      title: args.title,
      deliveryDate: args.deliveryDate,
      priority: args.priority,
      rushFlag: args.rushFlag,
      overallStatus: 'OPEN', // FR-309 — derived, never supplied
      specIncomplete: args.specIncomplete ?? false,
      isQuick: args.isQuick ?? false,
      notes: args.notes,
      createdBy: auth.userId,
      specs: { createMany: { data: args.specs.map((spec, i) => specRowData(auth.tenantId, spec, spec.lineNo ?? i + 1)) } },
      progress: { createMany: { data: progressRowsFor(auth.tenantId, template) } },
    },
    select: { id: true, jobcardNo: true },
  });

  await tx.jobEvent.create({
    data: {
      tenantId: auth.tenantId,
      jobcardId: jobcard.id,
      eventType: 'CREATED',
      actorId: auth.userId,
      source: args.source,
      newValue: jobcard.jobcardNo,
      note: args.eventNote ?? null,
    },
  });

  await recordAudit({
    tenantId: auth.tenantId,
    branchId: args.branchId,
    entityType: 'Jobcard',
    entityId: jobcard.id,
    action: 'CREATE',
    actorId: auth.userId,
    after: {
      jobcardNo: jobcard.jobcardNo,
      vertical: args.vertical,
      customerId: args.customerId,
      deliveryDate: args.deliveryDate.toISOString(),
      priority: args.priority,
      rushFlag: args.rushFlag,
      specs: args.specs.length,
    },
    tx,
  });

  return jobcard;
}

/** FR-300 — full multi-vertical jobcard. */
export async function createJobcard(auth: AuthContext, input: JobcardCreateInput) {
  assertVerticalSpecs(input.vertical, input.specs);
  const deliveryDate = parseDateInput(input.deliveryDate);
  assertDeliveryDate(deliveryDate, input.override, input.overrideReason); // FR-304

  const created = await prisma.$transaction(async (tx) => {
    const branch = await resolveBranch(tx, auth, input.branchId);
    const fy = await resolveFy(tx, auth.tenantId, tenantToday());

    return insertJobcard({
      tx,
      auth,
      vertical: input.vertical,
      customerId: input.customerId,
      branchId: branch.id,
      branchCode: branch.branchCode,
      fyId: fy.id,
      fyLabel: fy.fyLabel,
      templateId: input.templateId,
      title: input.title ?? null,
      deliveryDate,
      priority: input.priority,
      rushFlag: input.rushFlag,
      notes: input.notes ?? null,
      specs: input.specs,
      sourceQuoteId: input.sourceQuoteId ?? null,
      source: 'WEB',
      eventNote: input.override && input.overrideReason ? `Past delivery date override: ${input.overrideReason}` : null,
    });
  });

  return getJobcard(auth, created.id);
}

/** FR-301 — the 15-second quick jobcard for a walk-in. */
export async function createQuickJobcard(auth: AuthContext, input: QuickJobcardInput) {
  const deliveryDate = parseDateInput(input.deliveryDate);
  assertDeliveryDate(deliveryDate, input.override, input.overrideReason); // FR-304

  const created = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { id: auth.tenantId },
      select: { defaultVertical: true, homeStateCode: true },
    });
    if (!tenant) throw notFound('Tenant not found');

    const branch = await resolveBranch(tx, auth, input.branchId);
    const fy = await resolveFy(tx, auth.tenantId, tenantToday());

    // FR-301 — "Customer may be created inline with name + mobile only".
    let customerId = input.customerId ?? null;
    if (!customerId && input.customer) {
      const branchRow = await tx.branch.findFirst({
        where: { id: branch.id, tenantId: auth.tenantId },
        select: { stateCode: true },
      });
      const existing = await tx.customer.findFirst({
        where: { tenantId: auth.tenantId, phone: input.customer.phone, active: true },
        select: { id: true },
      });
      if (existing) {
        customerId = existing.id;
      } else {
        const customer = await tx.customer.create({
          data: {
            tenantId: auth.tenantId,
            name: input.customer.name,
            phone: input.customer.phone,
            customerType: 'UNREGISTERED',
            placeOfSupplyState:
              input.customer.placeOfSupplyState ?? tenant.homeStateCode ?? branchRow?.stateCode ?? '27',
          },
          select: { id: true },
        });
        customerId = customer.id;
      }
    }
    if (!customerId) throw unprocessable('A customer is required', 'CUSTOMER_REQUIRED');

    // FR-301 — vertical defaults to the tenant's configured default.
    const vertical = input.vertical ?? tenant.defaultVertical;

    return insertJobcard({
      tx,
      auth,
      vertical,
      customerId,
      branchId: branch.id,
      branchCode: branch.branchCode,
      fyId: fy.id,
      fyLabel: fy.fyLabel,
      title: input.description,
      deliveryDate,
      priority: input.priority,
      rushFlag: input.rushFlag,
      notes: input.notes ?? null,
      specs: [
        {
          description: input.description,
          quantity: input.quantity,
          finishing: [],
        } as SpecItemInput,
      ],
      isQuick: true,
      specIncomplete: true, // FR-301 — flagged for spec completion
      source: 'WEB',
      eventNote: 'quick',
    });
  });

  return getJobcard(auth, created.id);
}

/**
 * FR-302 / FR-233 — build a jobcard straight off an approved quote, carrying all
 * line specs and the quoted pricing so production starts with no re-entry.
 * Runs inside the caller's transaction so quote conversion stays atomic.
 */
export async function createJobcardFromQuote(args: {
  tx: Prisma.TransactionClient;
  auth: AuthContext;
  quote: { id: string; branchId: string; fyId: string; customerId: string; lines: unknown[] } & Record<string, unknown>;
}): Promise<{ id: string; jobcardNo: string }> {
  const { tx, auth, quote } = args;

  assertBranchAccess(auth, quote.branchId); // FR-717

  const [branch, fy, tenant] = await Promise.all([
    tx.branch.findFirst({ where: { id: quote.branchId, tenantId: auth.tenantId }, select: { id: true, branchCode: true } }),
    tx.financialYear.findFirst({ where: { id: quote.fyId, tenantId: auth.tenantId }, select: { id: true, fyLabel: true } }),
    tx.tenant.findUnique({ where: { id: auth.tenantId }, select: { defaultVertical: true } }),
  ]);
  if (!branch) throw notFound('Branch not found');
  if (!fy) throw notFound('Financial year not found');
  if (!tenant) throw notFound('Tenant not found');

  const lines = Array.isArray(quote.lines) ? quote.lines : [];
  if (lines.length === 0) throw unprocessable('This quotation has no lines to produce', 'QUOTE_HAS_NO_LINES');

  const specs = lines.map((line, index) => quoteLineToSpec(line, index));
  const vertical = verticalFromLines(lines) ?? tenant.defaultVertical;

  const today = tenantToday();
  const promised = readDate(quote.deliveryDate) ?? readDate(quote.validUntil) ?? addDays(today, 7);
  const deliveryDate = toDateOnly(promised).getTime() < today.getTime() ? today : promised;

  const quoteNo = readString(quote.quoteNo);

  return insertJobcard({
    tx,
    auth,
    vertical,
    customerId: quote.customerId,
    branchId: branch.id,
    branchCode: branch.branchCode,
    fyId: fy.id,
    fyLabel: fy.fyLabel,
    title: quoteNo ? `From quotation ${quoteNo}` : null,
    deliveryDate,
    priority: 'NORMAL',
    rushFlag: false,
    notes: quoteNo ? `Auto-generated from quotation ${quoteNo}` : 'Auto-generated from quotation',
    specs,
    sourceQuoteId: quote.id,
    source: 'SYSTEM',
    eventNote: quoteNo ? `quote ${quoteNo}` : 'quote',
  });
}

// — quote-line reading helpers (the quote row arrives loosely typed) —————————

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return null;
}

function readInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** Prisma Decimal, string and number all land here as a plain decimal string (BR-1). */
function readDecimal(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'string') return /^-?\d+(\.\d+)?$/.test(value.trim()) ? value.trim() : null;
  if (typeof value === 'object' && 'toString' in value) {
    const asText = String(value);
    return /^-?\d+(\.\d+)?$/.test(asText) ? asText : null;
  }
  return null;
}

function readDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

const VERTICALS: Vertical[] = ['FLEX_LARGE_FORMAT', 'OFFSET', 'DIGITAL', 'SCREEN'];

/** FR-302 — "Vertical is inherited from the source line where available". */
function verticalFromLines(lines: unknown[]): Vertical | null {
  for (const line of lines) {
    const spec = readRecord(readRecord(line).specJson);
    const candidate = readString(spec.vertical) ?? readString(readRecord(line).vertical);
    if (candidate && (VERTICALS as string[]).includes(candidate)) return candidate as Vertical;
  }
  return null;
}

/** FR-233 — carry description, spec and the quoted pricing onto the jobcard spec item. */
function quoteLineToSpec(line: unknown, index: number): SpecItemInput {
  const row = readRecord(line);
  const spec = readRecord(row.specJson);

  const width = readDecimal(row.widthFt) ?? readDecimal(spec.width);
  const height = readDecimal(row.heightFt) ?? readDecimal(spec.height);
  const unit = width && height ? readString(spec.unit) ?? 'ft' : readString(spec.unit);
  const quantity = readDecimal(row.qty) ?? readDecimal(spec.quantity) ?? '1';

  return {
    lineNo: readInt(row.lineNo) ?? index + 1,
    description: readString(row.description) ?? readString(spec.description) ?? `Line ${index + 1}`,
    width: width ?? undefined,
    height: height ?? undefined,
    unit: (unit === 'ft' || unit === 'inch' || unit === 'mm' ? unit : undefined) as SpecItemInput['unit'],
    substrate: readString(spec.substrate) ?? readString(spec.media),
    gsm: readInt(spec.gsm),
    colours: readString(spec.colours),
    sides: readInt(spec.sides),
    quantity,
    finishing: readStringArray(spec.finishing),
    instructions: readString(spec.instructions) ?? readString(row.notes),
    specJson: Object.keys(spec).length > 0 ? spec : null,
    rate: readDecimal(row.rate),
    lineTaxable: readDecimal(row.lineTaxable),
    gstPct: readDecimal(row.gstPct),
    hsnSac: readString(row.hsnSac),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads & updates
// ─────────────────────────────────────────────────────────────────────────────

export async function getJobcard(auth: AuthContext, id: string) {
  const jobcard = await loadJobcard(prisma, auth, id);
  return serializeJobcard(jobcard);
}

export async function listJobcards(auth: AuthContext, query: JobcardListQuery) {
  const today = tenantToday();
  const tomorrow = addDays(today, 1);

  const where: Prisma.JobcardWhereInput = { tenantId: auth.tenantId, ...branchScope(auth) };
  if (query.vertical) where.vertical = query.vertical;
  if (query.status) where.overallStatus = query.status;
  if (query.customerId) where.customerId = query.customerId;
  if (query.priority) where.priority = query.priority;
  if (query.rush !== undefined) where.rushFlag = query.rush;
  if (query.dueToday) {
    where.deliveryDate = { gte: today, lt: tomorrow };
    where.overallStatus = { in: ['OPEN', 'IN_PROGRESS'] };
  }
  if (query.overdue) {
    where.deliveryDate = { lt: today };
    where.overallStatus = { in: ['OPEN', 'IN_PROGRESS'] };
  }
  if (query.q) {
    where.OR = [
      { jobcardNo: { contains: query.q, mode: 'insensitive' } },
      { title: { contains: query.q, mode: 'insensitive' } },
      { customer: { name: { contains: query.q, mode: 'insensitive' } } },
      { specs: { some: { description: { contains: query.q, mode: 'insensitive' } } } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.jobcard.findMany({
      where,
      include: boardJobcardInclude,
      orderBy: [{ deliveryDate: 'asc' }, { createdAt: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.jobcard.count({ where }),
  ]);

  return {
    data: rows.map((row) => toCard(row, today)),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

export async function updateJobcard(auth: AuthContext, id: string, input: JobcardUpdateInput) {
  const updatedId = await prisma.$transaction(async (tx) => {
    const existing = await loadJobcard(tx, auth, id);

    // FR-303 — "A jobcard number, once assigned, is immutable."
    if (input.jobcardNo !== undefined && input.jobcardNo !== existing.jobcardNo) {
      throw unprocessable('The jobcard number cannot be changed once assigned', 'JOBCARD_NO_IMMUTABLE');
    }
    // FR-309 — overall status is computed from stage progress, never set by hand.
    if (input.overallStatus !== undefined && input.overallStatus !== existing.overallStatus) {
      throw unprocessable(
        'Overall status is derived from stage progress — advance or revert the job instead',
        'STATUS_NOT_SETTABLE',
      );
    }

    const effectiveVertical = input.vertical ?? existing.vertical;
    if (input.specs) assertVerticalSpecs(effectiveVertical, input.specs);

    const startedRows = existing.progress.filter((r) => r.startedAt !== null || r.status !== 'PENDING');
    if (input.vertical && input.vertical !== existing.vertical && startedRows.length > 0) {
      throw unprocessable(
        'The vertical cannot change once production has started on this jobcard',
        'VERTICAL_LOCKED',
      );
    }

    const data: Prisma.JobcardUpdateInput = {};
    const events: Prisma.JobEventCreateManyInput[] = [];
    const now = new Date();

    if (input.deliveryDate !== undefined) {
      const next = parseDateInput(input.deliveryDate);
      assertDeliveryDate(next, input.override, input.overrideReason); // FR-304
      if (next.getTime() !== existing.deliveryDate.getTime()) {
        data.deliveryDate = next;
        events.push({
          tenantId: auth.tenantId,
          jobcardId: id,
          eventType: 'DELIVERY_DATE_CHANGED',
          actorId: auth.userId,
          source: 'WEB',
          oldValue: existing.deliveryDate.toISOString(),
          newValue: next.toISOString(),
          note: input.overrideReason ?? null,
        });
      }
    }

    if (input.priority !== undefined && input.priority !== existing.priority) {
      data.priority = input.priority;
      events.push({
        tenantId: auth.tenantId,
        jobcardId: id,
        eventType: 'PRIORITY_CHANGED',
        actorId: auth.userId,
        source: 'WEB',
        oldValue: existing.priority,
        newValue: input.priority,
      });
    }

    if (input.rushFlag !== undefined && input.rushFlag !== existing.rushFlag) {
      data.rushFlag = input.rushFlag;
      events.push({
        tenantId: auth.tenantId,
        jobcardId: id,
        eventType: 'PRIORITY_CHANGED',
        actorId: auth.userId,
        source: 'WEB',
        oldValue: String(existing.rushFlag),
        newValue: String(input.rushFlag),
        note: 'rushFlag',
      });
    }

    if (input.title !== undefined) data.title = input.title;
    if (input.notes !== undefined) data.notes = input.notes;

    if (input.customerId && input.customerId !== existing.customerId) {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, tenantId: auth.tenantId },
        select: { id: true },
      });
      if (!customer) throw notFound('Customer not found');
      data.customer = { connect: { id: customer.id } };
    }

    // FR-301 AC 2 — a quick jobcard's full spec is completed in place, never recreated.
    if (input.specs) {
      await tx.jobcardSpecItem.deleteMany({ where: { jobcardId: id, tenantId: auth.tenantId } });
      await tx.jobcardSpecItem.createMany({
        data: input.specs.map((spec, i) => ({
          jobcardId: id,
          ...specRowData(auth.tenantId, spec, spec.lineNo ?? i + 1),
        })),
      });
      data.specIncomplete = false;
      events.push({
        tenantId: auth.tenantId,
        jobcardId: id,
        eventType: 'SPEC_UPDATED',
        actorId: auth.userId,
        source: 'WEB',
        newValue: String(input.specs.length),
      });
    }

    if (input.vertical && input.vertical !== existing.vertical) {
      const template = await resolveTemplate(tx, auth.tenantId, input.vertical);
      await tx.jobStageProgress.deleteMany({ where: { jobcardId: id, tenantId: auth.tenantId } });
      await tx.jobStageProgress.createMany({
        data: progressRowsFor(auth.tenantId, template).map((row) => ({ jobcardId: id, ...row })),
      });
      data.vertical = input.vertical;
      data.template = { connect: { id: template.id } };
    }

    if (Object.keys(data).length > 0) {
      await tx.jobcard.update({ where: { id }, data });
    }
    if (events.length > 0) await tx.jobEvent.createMany({ data: events });

    await recordAudit({
      tenantId: auth.tenantId,
      branchId: existing.branchId,
      entityType: 'Jobcard',
      entityId: id,
      action: 'UPDATE',
      actorId: auth.userId,
      before: {
        deliveryDate: existing.deliveryDate.toISOString(),
        priority: existing.priority,
        rushFlag: existing.rushFlag,
        vertical: existing.vertical,
      },
      after: {
        deliveryDate: (data.deliveryDate as Date | undefined)?.toISOString() ?? existing.deliveryDate.toISOString(),
        priority: input.priority ?? existing.priority,
        rushFlag: input.rushFlag ?? existing.rushFlag,
        vertical: effectiveVertical,
        at: now.toISOString(),
      },
      tx,
    });

    return id;
  });

  return getJobcard(auth, updatedId);
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-305 — digital job bag & printable ticket
// ─────────────────────────────────────────────────────────────────────────────

function qrPayload(token: string, printedAt: Date | null) {
  const base = env.corsOrigin.split(',')[0].trim().replace(/\/+$/, '');
  return {
    token,
    /** What the printed QR encodes — resolved by POST /api/production/scan. */
    payload: `leoink://jobcard/${token}`,
    scanUrl: `${base}/scan/${token}`,
    printedAt: isoTs(printedAt),
  };
}

/**
 * FR-305 — the token is non-guessable (192 bits of CSPRNG) and, once minted,
 * stable for the jobcard's life. Created lazily on first job-bag/print.
 */
async function ensureQrToken(db: Db, tenantId: string, jobcardId: string): Promise<{ token: string; printedAt: Date | null }> {
  const existing = await db.qRToken.findUnique({
    where: { jobcardId },
    select: { token: true, printedAt: true },
  });
  if (existing) return existing;

  try {
    return await db.qRToken.create({
      data: { tenantId, jobcardId, token: crypto.randomBytes(24).toString('base64url') },
      select: { token: true, printedAt: true },
    });
  } catch (err) {
    // Two concurrent first-opens race on the unique jobcardId; the loser re-reads.
    const raced = await db.qRToken.findUnique({ where: { jobcardId }, select: { token: true, printedAt: true } });
    if (raced) return raced;
    throw err;
  }
}

export async function jobBag(auth: AuthContext, id: string) {
  const jobcard = await loadJobcard(prisma, auth, id);
  const qr = await ensureQrToken(prisma, auth.tenantId, jobcard.id);
  const today = tenantToday();
  const serialised = serializeJobcard(jobcard, today);

  return {
    ...serialised,
    qrToken: qr.token,
    printedAt: isoTs(qr.printedAt),
    qr: qrPayload(qr.token, qr.printedAt),
    /** FR-304 — the badges the board and the printed ticket both render. */
    badges: {
      rush: jobcard.rushFlag,
      priority: jobcard.priority,
      dueToday: serialised.dueToday,
      overdue: serialised.overdue,
      specIncomplete: jobcard.specIncomplete,
    },
  };
}

/** FR-305 — stamp `printed_at` and return the printable ticket model. */
export async function printTicket(auth: AuthContext, id: string) {
  const result = await prisma.$transaction(async (tx) => {
    const jobcard = await loadJobcard(tx, auth, id);
    const qr = await ensureQrToken(tx, auth.tenantId, jobcard.id);
    const printedAt = new Date();
    await tx.qRToken.update({ where: { jobcardId: jobcard.id }, data: { printedAt } });

    await tx.jobEvent.create({
      data: {
        tenantId: auth.tenantId,
        jobcardId: jobcard.id,
        eventType: 'TICKET_PRINTED',
        actorId: auth.userId,
        source: 'WEB',
        newValue: printedAt.toISOString(),
      },
    });

    return { jobcard, token: qr.token, printedAt };
  });

  const today = tenantToday();
  const serialised = serializeJobcard(result.jobcard, today);
  return {
    id: serialised.id,
    jobcardNo: serialised.jobcardNo,
    title: serialised.title,
    vertical: serialised.vertical,
    branch: serialised.branch,
    customer: serialised.customer,
    deliveryDate: serialised.deliveryDate,
    priority: serialised.priority,
    rushFlag: serialised.rushFlag,
    overallStatus: serialised.overallStatus,
    currentStage: serialised.currentStage,
    progress: serialised.progress,
    totalQuantity: serialised.totalQuantity,
    specs: serialised.specs,
    qrToken: result.token,
    qr: qrPayload(result.token, result.printedAt),
    printedAt: result.printedAt.toISOString(),
    printedBy: auth.name,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-308 / FR-309 — stage progression
// ─────────────────────────────────────────────────────────────────────────────

async function applyRollUp(
  tx: Db,
  auth: AuthContext,
  jobcardId: string,
  previousStatus: JobStatus,
  now: Date,
): Promise<JobStatus> {
  const rows = await tx.jobStageProgress.findMany({
    where: { tenantId: auth.tenantId, jobcardId },
    orderBy: { sequence: 'asc' },
  });
  const status = rollUpStatus(rows);
  if (status === previousStatus) return status;

  await tx.jobcard.update({
    where: { id: jobcardId },
    data: { overallStatus: status, completedAt: status === 'DONE' ? now : null },
  });
  await tx.jobEvent.create({
    data: {
      tenantId: auth.tenantId,
      jobcardId,
      eventType: 'STATUS_CHANGED',
      actorId: auth.userId,
      source: 'SYSTEM',
      oldValue: previousStatus,
      newValue: status,
    },
  });
  return status;
}

function findTargetRow<T extends StageProgressLike>(rows: T[], id: string): T | null {
  return rows.find((r) => r.stageId === id || r.id === id) ?? null;
}

/**
 * FR-308 — completes the current stage (timestamp + operator) and starts the
 * next; FR-309 — recomputes the roll-up status. `source` is WEB for a board move
 * and SCAN for FR-312.
 */
export async function advanceJobcard(
  auth: AuthContext,
  id: string,
  input: AdvanceInput,
  source: EventSource = 'WEB',
) {
  await prisma.$transaction(async (tx) => {
    const jobcard = await loadJobcard(tx, auth, id);
    if (jobcard.overallStatus === 'CANCELLED') {
      throw unprocessable('This jobcard is cancelled', 'JOBCARD_CANCELLED');
    }

    const rows = [...jobcard.progress].sort((a, b) => a.sequence - b.sequence);
    if (rows.length === 0) throw unprocessable('This jobcard has no workflow stages', 'NO_STAGES');

    const current = activeProgress(rows);
    if (!current) throw unprocessable('Every stage on this jobcard is already complete', 'ALREADY_COMPLETE');

    let target: StageProgressLike | null;
    if (input.toStageId) {
      target = findTargetRow(rows, input.toStageId);
      if (!target) throw notFound('That stage is not part of this jobcard');
      if (target.sequence <= current.sequence) {
        throw unprocessable('Use revert to move a jobcard backwards', 'NOT_A_FORWARD_MOVE');
      }
      // FR-308 — "skipping … is allowed only for authorized roles and is logged".
      if (target.sequence > current.sequence + 1 && !MOVE_AUTHORISED_ROLES.includes(auth.role)) {
        throw forbidden('Only an owner/admin or production manager may skip production stages');
      }
    } else {
      target = rows.find((r) => r.sequence > current.sequence) ?? null;
    }

    const now = new Date();

    await tx.jobStageProgress.update({
      where: { id: current.id },
      data: {
        status: 'COMPLETED',
        startedAt: current.startedAt ?? now,
        completedAt: now,
        // FR-308 — the acting user is the recorded responsible operator.
        assignedOperatorId: current.assignedOperatorId ?? auth.userId,
        updatedBy: auth.userId,
      },
    });

    if (target) {
      const skipped = rows.filter(
        (r) => r.sequence > current.sequence && r.sequence < target!.sequence && r.status !== 'COMPLETED',
      );
      for (const row of skipped) {
        await tx.jobStageProgress.update({
          where: { id: row.id },
          data: { status: 'SKIPPED', updatedBy: auth.userId },
        });
      }
      await tx.jobStageProgress.update({
        where: { id: target.id },
        data: {
          status: 'IN_PROGRESS',
          startedAt: target.startedAt ?? now,
          completedAt: null,
          updatedBy: auth.userId,
        },
      });
    }

    await tx.jobEvent.create({
      data: {
        tenantId: auth.tenantId,
        jobcardId: id,
        stageId: target?.stageId ?? current.stageId,
        eventType: 'STAGE_ADVANCED',
        fromStage: current.stageName,
        toStage: target?.stageName ?? null,
        actorId: auth.userId,
        source,
        note: input.note ?? null,
      },
    });

    await applyRollUp(tx, auth, id, jobcard.overallStatus, now);
  });

  return getJobcard(auth, id);
}

/** FR-308 AC 2 — a backward move is refused for anyone but Owner/Admin or Production Manager. */
export async function revertJobcard(auth: AuthContext, id: string, input: RevertInput, source: EventSource = 'WEB') {
  if (!MOVE_AUTHORISED_ROLES.includes(auth.role)) {
    throw forbidden('Only an owner/admin or production manager may move a jobcard backwards');
  }

  await prisma.$transaction(async (tx) => {
    const jobcard = await loadJobcard(tx, auth, id);
    const rows = [...jobcard.progress].sort((a, b) => a.sequence - b.sequence);
    if (rows.length === 0) throw unprocessable('This jobcard has no workflow stages', 'NO_STAGES');

    const current = activeProgress(rows) ?? rows[rows.length - 1];

    let target: StageProgressLike | null;
    if (input.toStageId) {
      target = findTargetRow(rows, input.toStageId);
      if (!target) throw notFound('That stage is not part of this jobcard');
      if (target.sequence >= current.sequence) {
        throw unprocessable('Revert must move the jobcard to an earlier stage', 'NOT_A_BACKWARD_MOVE');
      }
    } else {
      const earlier = rows.filter((r) => r.sequence < current.sequence);
      target = earlier.length > 0 ? earlier[earlier.length - 1] : null;
      if (!target) throw unprocessable('This jobcard is already at its first stage', 'AT_FIRST_STAGE');
    }

    const now = new Date();
    for (const row of rows.filter((r) => r.sequence > target!.sequence)) {
      await tx.jobStageProgress.update({
        where: { id: row.id },
        data: { status: 'PENDING', startedAt: null, completedAt: null, updatedBy: auth.userId },
      });
    }
    await tx.jobStageProgress.update({
      where: { id: target.id },
      data: {
        status: 'IN_PROGRESS',
        startedAt: target.startedAt ?? now,
        completedAt: null,
        updatedBy: auth.userId,
      },
    });

    await tx.jobEvent.create({
      data: {
        tenantId: auth.tenantId,
        jobcardId: id,
        stageId: target.stageId,
        eventType: 'STAGE_REVERTED',
        fromStage: current.stageName,
        toStage: target.stageName,
        actorId: auth.userId,
        source,
        note: input.note ?? null,
      },
    });

    await applyRollUp(tx, auth, id, jobcard.overallStatus, now);
  });

  return getJobcard(auth, id);
}

export async function listJobEvents(auth: AuthContext, id: string, pageSize: number) {
  await loadJobcard(prisma, auth, id);
  const events = await prisma.jobEvent.findMany({
    where: { tenantId: auth.tenantId, jobcardId: id },
    include: { actor: { select: { id: true, name: true, role: true } } },
    orderBy: { createdAt: 'asc' },
    take: pageSize,
  });

  return {
    data: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      stageId: e.stageId,
      fromStage: e.fromStage,
      toStage: e.toStage,
      oldValue: e.oldValue,
      newValue: e.newValue,
      source: e.source,
      note: e.note,
      actorId: e.actorId,
      actorName: e.actor?.name ?? null,
      actorRole: e.actor?.role ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
    total: events.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-310 — operator assignment
// ─────────────────────────────────────────────────────────────────────────────

export async function assignStage(auth: AuthContext, jobcardId: string, stageProgressId: string, input: AssignInput) {
  await prisma.$transaction(async (tx) => {
    await loadJobcard(tx, auth, jobcardId);

    const row = await tx.jobStageProgress.findFirst({
      where: { id: stageProgressId, jobcardId, tenantId: auth.tenantId },
      select: { id: true, stageId: true, stageName: true, assignedOperatorId: true },
    });
    if (!row) throw notFound('That stage is not part of this jobcard');

    const operator = await tx.user.findFirst({
      where: { id: input.operatorId, tenantId: auth.tenantId },
      select: { id: true, name: true, role: true, status: true },
    });
    if (!operator) throw notFound('User not found');
    if (operator.status === 'DISABLED') {
      throw unprocessable('That user account is disabled', 'OPERATOR_DISABLED');
    }
    // FR-310 — "only tenant users with an operator/production role may be assigned".
    if (!ASSIGNABLE_ROLES.includes(operator.role)) {
      throw unprocessable(
        `Only ${ASSIGNABLE_ROLES.join(' / ')} users may be assigned to a production stage`,
        'ROLE_NOT_ASSIGNABLE',
      );
    }

    if (row.assignedOperatorId === operator.id) return;

    const previousId = row.assignedOperatorId;
    const previous = previousId
      ? await tx.user.findFirst({ where: { id: previousId, tenantId: auth.tenantId }, select: { name: true } })
      : null;

    await tx.jobStageProgress.update({
      where: { id: row.id },
      data: { assignedOperatorId: operator.id, updatedBy: auth.userId },
    });

    await tx.jobEvent.create({
      data: {
        tenantId: auth.tenantId,
        jobcardId,
        stageId: row.stageId,
        eventType: previousId ? 'REASSIGNED' : 'ASSIGNED',
        toStage: row.stageName,
        actorId: auth.userId,
        source: 'WEB',
        oldValue: previous ? `${previousId} (${previous.name})` : previousId,
        newValue: `${operator.id} (${operator.name})`,
        note: input.note ?? null,
      },
    });
  });

  return getJobcard(auth, jobcardId);
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-311 — per-operator work queue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The schema carries no department on User, so an operator's departments are
 * inferred from the stages they hold (or are supplied with `?department=`).
 */
async function departmentsFor(auth: AuthContext, explicit?: string): Promise<string[]> {
  if (explicit) return [explicit];
  const rows = await prisma.jobStageProgress.findMany({
    where: { tenantId: auth.tenantId, assignedOperatorId: auth.userId, department: { not: null } },
    select: { department: true },
    distinct: ['department'],
  });
  return rows.map((r) => r.department).filter((d): d is string => d !== null);
}

export async function myJobs(auth: AuthContext, query: MyJobsQuery) {
  const today = tenantToday();
  const departments = await departmentsFor(auth, query.department);
  const managerLike = auth.role === 'OWNER_ADMIN' || auth.role === 'PRODUCTION_MANAGER';

  const or: Prisma.JobStageProgressWhereInput[] = [{ assignedOperatorId: auth.userId }];
  if (departments.length > 0) or.push({ assignedOperatorId: null, department: { in: departments } });
  else if (managerLike) or.push({ assignedOperatorId: null });

  const rows = await prisma.jobStageProgress.findMany({
    where: {
      tenantId: auth.tenantId,
      status: { in: ['PENDING', 'IN_PROGRESS'] },
      jobcard: { tenantId: auth.tenantId, overallStatus: { in: ['OPEN', 'IN_PROGRESS'] }, ...branchScope(auth) },
      OR: or,
    },
    include: {
      operator: { select: { id: true, name: true } },
      jobcard: { include: boardJobcardInclude },
    },
    orderBy: [{ jobcard: { deliveryDate: 'asc' } }, { sequence: 'asc' }],
    take: query.pageSize * 4,
  });

  const entries: Array<{ card: BoardCard; stage: ReturnType<typeof stageSummary> }> = [];
  for (const row of rows) {
    const active = activeProgress(row.jobcard.progress);
    // FR-311 — only the job's actionable (active) stage belongs on the queue.
    if (!query.includeUpcoming && active?.id !== row.id) continue;
    entries.push({ card: toCard(row.jobcard, today), stage: stageSummary(row) });
  }

  entries.sort((a, b) => compareCards(a.card, b.card));

  const page = entries.slice(0, query.pageSize);
  return {
    today: isoDay(today),
    departments,
    count: page.length,
    total: entries.length,
    data: page.map((e) => ({
      ...e.stage,
      jobcardId: e.card.jobcardId,
      jobcardNo: e.card.jobcardNo,
      customerName: e.card.customerName,
      deliveryDate: e.card.deliveryDate,
      priority: e.card.priority,
      rushFlag: e.card.rushFlag,
      dueToday: e.card.dueToday,
      overdue: e.card.overdue,
      jobcard: e.card,
    })),
  };
}

function stageSummary(row: StageProgressLike & { operator?: { id: string; name: string } | null }) {
  return {
    stageProgressId: row.id,
    stageId: row.stageId,
    stageName: row.stageName,
    sequence: row.sequence,
    department: row.department,
    isTerminal: row.isTerminal,
    status: row.status,
    startedAt: isoTs(row.startedAt),
    assignedOperatorId: row.assignedOperatorId,
    assignedOperatorName: row.operator?.name ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-312 — scan to status
// ─────────────────────────────────────────────────────────────────────────────

export async function scan(auth: AuthContext, input: ScanInput) {
  const record = await prisma.qRToken.findUnique({
    where: { token: input.token },
    select: { tenantId: true, jobcardId: true },
  });
  if (!record) throw notFound('This QR code is not recognised');
  // FR-312 — "invalid/foreign tokens are rejected"; a foreign token is denied, not disowned.
  if (record.tenantId !== auth.tenantId) {
    throw forbidden('This QR code belongs to another organisation');
  }

  if (input.action === 'advance') {
    // FR-312 — "Role/permission checks apply identically to board moves."
    if (!can(auth.role, 'production', 'U')) {
      throw forbidden(`Your role (${auth.role}) may not advance production stages`);
    }
    const advanced = await advanceJobcard(auth, record.jobcardId, { note: input.note ?? null }, 'SCAN');
    return { action: 'advance' as const, ...advanced };
  }

  const bag = await jobBag(auth, record.jobcardId);
  return { action: 'open' as const, ...bag };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-313 — TAT: due-today / overdue lists and the alert sweep
// ─────────────────────────────────────────────────────────────────────────────

const OPEN_STATUSES: JobStatus[] = ['OPEN', 'IN_PROGRESS'];

export async function tat(auth: AuthContext, query: TatQuery) {
  const today = tenantToday();
  const tomorrow = addDays(today, 1);

  const base: Prisma.JobcardWhereInput = {
    tenantId: auth.tenantId,
    // FR-313 — "a `done` jobcard never appears".
    overallStatus: { in: OPEN_STATUSES },
    ...branchScope(auth),
    ...(query.vertical ? { vertical: query.vertical } : {}),
  };

  const wantDueToday = query.filter === 'all' || query.filter === 'due-today';
  const wantOverdue = query.filter === 'all' || query.filter === 'overdue';

  const [dueTodayRows, overdueRows] = await Promise.all([
    wantDueToday
      ? prisma.jobcard.findMany({
          where: { ...base, deliveryDate: { gte: today, lt: tomorrow } },
          include: boardJobcardInclude,
          orderBy: [{ rushFlag: 'desc' }, { deliveryDate: 'asc' }],
          take: query.pageSize,
        })
      : Promise.resolve([]),
    wantOverdue
      ? prisma.jobcard.findMany({
          where: { ...base, deliveryDate: { lt: today } },
          include: boardJobcardInclude,
          orderBy: [{ rushFlag: 'desc' }, { deliveryDate: 'asc' }],
          take: query.pageSize,
        })
      : Promise.resolve([]),
  ]);

  const dueTodayCards = dueTodayRows.map((row) => toCard(row, today)).sort(compareCards);
  const overdueCards = overdueRows.map((row) => toCard(row, today)).sort(compareCards);

  return {
    today: isoDay(today),
    filter: query.filter,
    counts: { dueToday: dueTodayCards.length, overdue: overdueCards.length },
    dueToday: dueTodayCards,
    overdue: overdueCards,
  };
}

const TAT_TEMPLATES = { DUE_TODAY: 'JOB_TAT_DUE_TODAY', OVERDUE: 'JOB_TAT_OVERDUE' } as const;

/**
 * FR-313 — "alerts are generated for the manager/assigned operators … WhatsApp
 * as the primary channel". Phase 1 queues MessageLog rows; the delivery worker
 * drains them.
 */
export async function runTatAlerts(auth: AuthContext, input: TatAlertInput) {
  const today = tenantToday();
  const tomorrow = addDays(today, 1);

  const base: Prisma.JobcardWhereInput = {
    tenantId: auth.tenantId,
    overallStatus: { in: OPEN_STATUSES },
    ...branchScope(auth),
  };

  const wantDueToday = input.filter === 'all' || input.filter === 'due-today';
  const wantOverdue = input.filter === 'all' || input.filter === 'overdue';

  const jobcards = await prisma.jobcard.findMany({
    where: {
      ...base,
      deliveryDate: wantOverdue && wantDueToday ? { lt: tomorrow } : wantOverdue ? { lt: today } : { gte: today, lt: tomorrow },
    },
    include: {
      customer: { select: { name: true } },
      progress: {
        orderBy: { sequence: 'asc' },
        include: { operator: { select: { id: true, name: true, phone: true, status: true } } },
      },
    },
  });

  if (jobcards.length === 0) {
    return { today: isoDay(today), scanned: 0, dueToday: 0, overdue: 0, alertsQueued: 0, skippedNoPhone: 0, alreadyAlerted: 0 };
  }

  const managers = await prisma.user.findMany({
    where: { tenantId: auth.tenantId, status: 'ACTIVE', role: { in: ['OWNER_ADMIN', 'PRODUCTION_MANAGER'] } },
    select: { id: true, name: true, phone: true },
  });
  const managerPhones = managers.filter((m): m is typeof m & { phone: string } => Boolean(m.phone));
  let skippedNoPhone = managers.length - managerPhones.length;

  const existing = input.force
    ? []
    : await prisma.messageLog.findMany({
        where: {
          tenantId: auth.tenantId,
          entityType: 'Jobcard',
          entityId: { in: jobcards.map((j) => j.id) },
          templateId: { in: [TAT_TEMPLATES.DUE_TODAY, TAT_TEMPLATES.OVERDUE] },
          createdAt: { gte: today },
        },
        select: { entityId: true, templateId: true, toAddress: true },
      });
  const alerted = new Set(existing.map((e) => `${e.entityId}|${e.templateId}|${e.toAddress}`));

  const rows: Prisma.MessageLogCreateManyInput[] = [];
  let dueTodayCount = 0;
  let overdueCount = 0;
  let alreadyAlerted = 0;

  for (const jobcard of jobcards) {
    const flags = dueFlags(jobcard.deliveryDate, jobcard.overallStatus, today);
    if (flags.overdue) overdueCount += 1;
    else if (flags.dueToday) dueTodayCount += 1;
    else continue;

    const templateId = flags.overdue ? TAT_TEMPLATES.OVERDUE : TAT_TEMPLATES.DUE_TODAY;
    const active = activeProgress(jobcard.progress);
    const stageName = active?.stageName ?? 'complete';
    const promised = isoDay(toDateOnly(jobcard.deliveryDate));
    const body = flags.overdue
      ? `Jobcard ${jobcard.jobcardNo} for ${jobcard.customer.name} is OVERDUE (promised ${promised}). Current stage: ${stageName}.`
      : `Jobcard ${jobcard.jobcardNo} for ${jobcard.customer.name} is due today (${promised}). Current stage: ${stageName}.`;

    // FR-313 — the manager plus every operator still holding an open stage.
    const recipients = new Map<string, string>(); // phone → userId
    for (const manager of managerPhones) recipients.set(manager.phone, manager.id);
    for (const row of jobcard.progress) {
      const operator = row.operator;
      if (!operator || operator.status === 'DISABLED') continue;
      if (row.status === 'COMPLETED' || row.status === 'SKIPPED') continue;
      if (operator.phone) recipients.set(operator.phone, operator.id);
      else skippedNoPhone += 1;
    }

    for (const [phone] of recipients) {
      const key = `${jobcard.id}|${templateId}|${phone}`;
      if (alerted.has(key)) {
        alreadyAlerted += 1;
        continue;
      }
      alerted.add(key);
      rows.push({
        tenantId: auth.tenantId,
        channel: 'WHATSAPP',
        toAddress: phone,
        templateId,
        body,
        entityType: 'Jobcard',
        entityId: jobcard.id,
        status: 'QUEUED',
      });
    }
  }

  if (rows.length > 0) await prisma.messageLog.createMany({ data: rows });

  return {
    today: isoDay(today),
    scanned: jobcards.length,
    dueToday: dueTodayCount,
    overdue: overdueCount,
    alertsQueued: rows.length,
    skippedNoPhone,
    alreadyAlerted,
  };
}
