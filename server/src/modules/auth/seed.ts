/**
 * Tenant bootstrap data written the moment a firm signs up (FR-723), so the
 * setup wizard can be finished by accepting defaults (FR-100: "System pre-seeds
 * standard GST rate slabs (0/5/12/18/28%), the standard UOM list, and default
 * numbering series so the user can accept defaults and finish without manual
 * config").
 */
import type { Prisma, Vertical } from '@prisma/client';
import { DEFAULT_SERIES } from '../../lib/numbering.js';
import { fyRangeForDate, tenantToday } from '../../lib/fy.js';

/** FR-100 / FR-108 — the five statutory slabs. */
export const STANDARD_GST_SLABS: Array<{ name: string; gstPct: string }> = [
  { name: 'GST 0%', gstPct: '0.0000' },
  { name: 'GST 5%', gstPct: '5.0000' },
  { name: 'GST 12%', gstPct: '12.0000' },
  { name: 'GST 18%', gstPct: '18.0000' },
  { name: 'GST 28%', gstPct: '28.0000' },
];

export interface SeedUom {
  uomCode: string;
  name: string;
  symbol: string;
  baseUomCode?: string;
  factorToBase?: string;
}

/**
 * FR-110 — "Standard print UOMs are pre-seeded; sq.ft is available for flex/
 * large-format area pricing" and "1 ream = 500 sheet" as the single-factor
 * conversion. SHEET is listed before REAM so the base link resolves.
 */
export const STANDARD_UOMS: SeedUom[] = [
  { uomCode: 'SQFT', name: 'Square Feet', symbol: 'sq.ft' },
  { uomCode: 'NOS', name: 'Numbers', symbol: 'nos' },
  { uomCode: 'SHEET', name: 'Sheet', symbol: 'sheet' },
  { uomCode: 'KG', name: 'Kilogram', symbol: 'kg' },
  { uomCode: 'REAM', name: 'Ream', symbol: 'ream', baseUomCode: 'SHEET', factorToBase: '500.000000' },
  { uomCode: 'ROLL', name: 'Roll', symbol: 'roll' },
  { uomCode: 'METRE', name: 'Metre', symbol: 'm' },
  { uomCode: 'PIECE', name: 'Piece', symbol: 'pc' },
];

export interface SeedWorkflow {
  vertical: Vertical;
  name: string;
  stages: Array<{ name: string; department: string }>;
}

/**
 * FR-306 — "a sensible default template is seeded per vertical on tenant setup".
 * The last stage of each template is the terminal one.
 */
export const DEFAULT_WORKFLOWS: SeedWorkflow[] = [
  {
    vertical: 'FLEX_LARGE_FORMAT',
    name: 'Flex / Large Format — Standard',
    stages: [
      { name: 'Design', department: 'DESIGN' },
      { name: 'Print', department: 'PRINTING' },
      { name: 'Finishing', department: 'FINISHING' },
      { name: 'QC', department: 'QC' },
      { name: 'Dispatch', department: 'DISPATCH' },
    ],
  },
  {
    vertical: 'OFFSET',
    name: 'Offset — Standard',
    stages: [
      { name: 'Design', department: 'DESIGN' },
      { name: 'Prepress', department: 'PREPRESS' },
      { name: 'Plate', department: 'PREPRESS' },
      { name: 'Print', department: 'PRINTING' },
      { name: 'Finishing', department: 'FINISHING' },
      { name: 'QC', department: 'QC' },
      { name: 'Packing', department: 'PACKING' },
      { name: 'Dispatch', department: 'DISPATCH' },
    ],
  },
  {
    vertical: 'DIGITAL',
    name: 'Digital — Standard',
    stages: [
      { name: 'Design', department: 'DESIGN' },
      { name: 'Print', department: 'PRINTING' },
      { name: 'Finishing', department: 'FINISHING' },
      { name: 'QC', department: 'QC' },
      { name: 'Dispatch', department: 'DISPATCH' },
    ],
  },
  {
    vertical: 'SCREEN',
    name: 'Screen — Standard',
    stages: [
      { name: 'Design', department: 'DESIGN' },
      { name: 'Screen Making', department: 'PREPRESS' },
      { name: 'Print', department: 'PRINTING' },
      { name: 'Finishing', department: 'FINISHING' },
      { name: 'QC', department: 'QC' },
      { name: 'Dispatch', department: 'DISPATCH' },
    ],
  },
];

/** FR-722 — plan tiers differentiated by seats and branches. */
export interface SeedPlan {
  code: string;
  name: string;
  maxUsers: number;
  maxBranches: number;
  pricePerYear: string;
  features: string[];
}

export const DEFAULT_PLAN_CODE = 'STARTER';

export const DEFAULT_PLANS: SeedPlan[] = [
  {
    code: 'STARTER',
    name: 'Starter',
    maxUsers: 3,
    maxBranches: 1,
    pricePerYear: '0.00',
    features: ['setup', 'crm', 'quotation', 'jobcard', 'production', 'invoice', 'reports'],
  },
  {
    code: 'GROWTH',
    name: 'Growth',
    maxUsers: 10,
    maxBranches: 3,
    pricePerYear: '14999.00',
    features: [
      'setup',
      'crm',
      'quotation',
      'jobcard',
      'production',
      'inventory',
      'procurement',
      'invoice',
      'payments',
      'reports',
      'communication',
    ],
  },
  {
    code: 'SCALE',
    name: 'Scale',
    maxUsers: 25,
    maxBranches: 10,
    pricePerYear: '29999.00',
    features: [
      'setup',
      'crm',
      'quotation',
      'jobcard',
      'production',
      'inventory',
      'procurement',
      'invoice',
      'edocs',
      'payments',
      'ledgers',
      'dispatch',
      'reports',
      'communication',
    ],
  },
];

export function planCatalogEntry(code: string): SeedPlan | undefined {
  return DEFAULT_PLANS.find((p) => p.code === code.trim().toUpperCase());
}

/** Idempotently materialise the published plan catalogue (Plan.code is globally unique). */
export async function ensureDefaultPlans(tx: Prisma.TransactionClient): Promise<void> {
  for (const plan of DEFAULT_PLANS) {
    await tx.plan.upsert({
      where: { code: plan.code },
      update: {},
      create: {
        code: plan.code,
        name: plan.name,
        maxUsers: plan.maxUsers,
        maxBranches: plan.maxBranches,
        features: plan.features,
        pricePerYear: plan.pricePerYear,
        active: true,
      },
    });
  }
}

export interface SeedResult {
  fyId: string;
  fyLabel: string;
}

/**
 * Everything a brand-new tenant needs before the wizard runs. Must be called
 * inside the sign-up transaction so a failed sign-up leaves nothing behind.
 */
export async function seedTenantDefaults(
  tx: Prisma.TransactionClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<SeedResult> {
  // FR-104 — "current FY from system date", start 1-Apr / end 31-Mar, label YYYY-YY.
  const range = fyRangeForDate(tenantToday(now));
  const fy = await tx.financialYear.create({
    data: {
      tenantId,
      fyLabel: range.fyLabel,
      startDate: range.startDate,
      endDate: range.endDate,
      status: 'OPEN',
      isCurrent: true,
    },
  });

  // FR-100 / FR-108 — standard GST slabs, effective from the start of the current FY.
  await tx.taxRate.createMany({
    data: STANDARD_GST_SLABS.map((slab) => ({
      tenantId,
      name: slab.name,
      gstPct: slab.gstPct,
      cessPct: '0.0000',
      effectiveFrom: range.startDate,
      active: true,
    })),
  });

  // FR-110 — standard print UOM list, base units first so REAM → SHEET resolves.
  const uomIds = new Map<string, string>();
  for (const uom of STANDARD_UOMS) {
    const created = await tx.unitOfMeasure.create({
      data: {
        tenantId,
        uomCode: uom.uomCode,
        name: uom.name,
        symbol: uom.symbol,
        factorToBase: uom.factorToBase ?? '1.000000',
        baseUomId: uom.baseUomCode ? uomIds.get(uom.baseUomCode) ?? null : null,
        active: true,
      },
    });
    uomIds.set(uom.uomCode, created.id);
  }

  // FR-100 / FR-107 — default numbering series. A series whose prefix carries the
  // {FY} token can safely reset yearly; one without it must never reset or the
  // rendered number would repeat across financial years.
  await tx.numberingSeries.createMany({
    data: DEFAULT_SERIES.map((series) => ({
      tenantId,
      docType: series.docType,
      branchId: null,
      fyId: null,
      prefix: series.prefix,
      suffix: '',
      startNumber: 1,
      nextNumber: 1,
      padding: series.padding,
      resetPolicy: series.prefix.includes('{FY}') ? ('YEARLY' as const) : ('NEVER' as const),
      active: true,
    })),
  });

  // FR-112 — global default rounding rule (normal, whole rupee).
  await tx.roundingRule.create({
    data: { tenantId, scope: null, mode: 'NORMAL', precision: 0 },
  });

  // FR-306 — one default workflow template per vertical.
  for (const workflow of DEFAULT_WORKFLOWS) {
    await tx.workflowTemplate.create({
      data: {
        tenantId,
        vertical: workflow.vertical,
        name: workflow.name,
        isDefault: true,
        active: true,
        stages: {
          create: workflow.stages.map((stage, index) => ({
            tenantId,
            name: stage.name,
            sequence: index + 1,
            department: stage.department,
            isTerminal: index === workflow.stages.length - 1,
          })),
        },
      },
    });
  }

  return { fyId: fy.id, fyLabel: fy.fyLabel };
}
