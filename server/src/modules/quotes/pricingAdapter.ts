/**
 * HTTP payload → `PricingDocumentInput`.
 *
 * This file resolves *inputs* only. Every rupee of arithmetic lives in
 * `src/engine/pricing.ts` (FR-210 / BR-7: "one shared, versioned pricing
 * service … no duplicated pricing math"). Nothing here adds, multiplies or
 * rounds a monetary value.
 *
 * Responsibilities:
 *   FR-212  rate resolution order — explicit line rate → active MaterialItem
 *           selling rate → RateCard published rate → RATE_UNAVAILABLE, with the
 *           source stamped on the line. HSN/SAC, GST % and minimum charge are
 *           pre-filled from the same master and overridable per line.
 *   FR-221  the job-spec wizard payload → `specJson` + a readable description.
 *   FR-224  place-of-supply vs the issuing branch's state → GST treatment.
 *   FR-213  tenant default markup / margin fed to the engine.
 */
import type { Branch, Prisma, RoundingRule, Tenant } from '@prisma/client';
import { prisma } from '../../db.js';
import { type AuthContext, assertBranchAccess } from '../../auth/middleware.js';
import { notFound, unprocessable } from '../../http/errors.js';
import { D } from '../../lib/money.js';
import {
  PricingError,
  type MarkupMode,
  type PricingDocumentInput,
  type PricingLineInput,
  type RateSource,
  resolveGstTreatment,
} from '../../engine/pricing.js';
import type { JobSpecInput, QuoteLineInput } from './schemas.js';

type Client = Prisma.TransactionClient;

type MaterialRow = Prisma.MaterialItemGetPayload<{
  include: { uom: true; hsnSac: { include: { defaultTaxRate: true } } };
}>;

type RateCardRow = Prisma.RateCardGetPayload<{ include: { uom: true } }>;

const MATERIAL_INCLUDE = {
  uom: true,
  hsnSac: { include: { defaultTaxRate: true } },
} satisfies Prisma.MaterialItemInclude;

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

export interface PricingContext {
  tenant: Tenant;
  /** FR-224 — the issuing branch supplies the supplier state code. */
  branch: Branch;
  roundingMode: 'NORMAL' | 'UP' | 'DOWN' | 'NONE';
  roundingPrecision: number;
}

/**
 * FR-118 / FR-717 — resolve the issuing branch. An explicit branch must be one
 * the caller may transact for; otherwise fall back to their only branch, then
 * to the tenant's head office.
 */
export async function resolveBranch(auth: AuthContext, branchId: string | undefined, client: Client = prisma): Promise<Branch> {
  if (branchId) {
    const branch = await client.branch.findFirst({ where: { id: branchId, tenantId: auth.tenantId } });
    if (!branch) throw notFound('Branch not found'); // BR-4 — never leak another tenant's branch
    assertBranchAccess(auth, branch.id);
    return branch;
  }

  if (!auth.allBranches && auth.branchIds.length > 0) {
    const own = await client.branch.findFirst({
      where: { id: { in: auth.branchIds }, tenantId: auth.tenantId, active: true },
      orderBy: [{ isHeadOffice: 'desc' }, { branchCode: 'asc' }],
    });
    if (own) return own;
  }

  const fallback = await client.branch.findFirst({
    where: { tenantId: auth.tenantId, active: true },
    orderBy: [{ isHeadOffice: 'desc' }, { branchCode: 'asc' }],
  });
  if (!fallback) throw unprocessable('No active branch is configured for this tenant', 'BRANCH_REQUIRED');
  assertBranchAccess(auth, fallback.id);
  return fallback;
}

export async function loadPricingContext(
  auth: AuthContext,
  branchId: string | undefined,
  client: Client = prisma,
): Promise<PricingContext> {
  const [tenant, branch] = await Promise.all([
    client.tenant.findUnique({ where: { id: auth.tenantId } }),
    resolveBranch(auth, branchId, client),
  ]);
  if (!tenant) throw notFound('Tenant not found');

  // FR-112 / FR-215 — a QUOTATION-scoped rule wins over the tenant-wide default.
  const rules: RoundingRule[] = await client.roundingRule.findMany({
    where: { tenantId: auth.tenantId, OR: [{ scope: 'QUOTATION' }, { scope: null }] },
  });
  const rule = rules.find((r) => r.scope === 'QUOTATION') ?? rules.find((r) => r.scope === null) ?? null;

  return {
    tenant,
    branch,
    roundingMode: rule?.mode ?? 'NORMAL',
    roundingPrecision: rule?.precision ?? 0,
  };
}

/**
 * FR-224 — "Comparison of place_of_supply state code vs tenant GSTIN state code
 * selects the tax split." A draft may not have one yet; Send is what enforces it.
 */
export function resolveTreatment(
  ctx: PricingContext,
  placeOfSupplyState: string | null | undefined,
  options: { required?: boolean } = {},
): boolean {
  if (!placeOfSupplyState) {
    if (options.required) {
      throw unprocessable(
        'Place of supply is required before this quotation can be sent',
        'PLACE_OF_SUPPLY_MISSING',
      );
    }
    return false;
  }
  return resolveGstTreatment(ctx.branch.stateCode, placeOfSupplyState).isInterstate;
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-221 — spec normalisation and readable descriptions
// ─────────────────────────────────────────────────────────────────────────────

export interface NormalisedSpec {
  size: string | null;
  substrate: string | null;
  gsm: number | null;
  colours: string | null;
  sides: number | null;
  lamination: string | null;
  finishing: string[];
}

/** Trailing zeros off, so 4.0000 ft reads "4" and 3.5000 ft reads "3.5". */
function feet(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return D(value).toDecimalPlaces(4).toString();
}

function normaliseSpec(
  spec: JobSpecInput | null | undefined,
  fallbackSubstrate: string | null,
  dimensions: string | null,
): NormalisedSpec {
  const finishing = (spec?.finishing ?? []).map((f) => f.trim()).filter((f) => f.length > 0);
  return {
    size: spec?.size ?? dimensions,
    substrate: spec?.substrate ?? fallbackSubstrate,
    gsm: spec?.gsm ?? null,
    colours: spec?.colours ?? null,
    sides: spec?.sides ?? null,
    lamination: spec?.lamination ?? null,
    finishing,
  };
}

/**
 * FR-221 — "a readable 'Star Flex 4×6 ft' description". Extras (gsm, colours,
 * sides, lamination, finishing) are appended only when captured, so a plain
 * flex line reads exactly as the acceptance criterion states.
 */
export function renderLineDescription(spec: NormalisedSpec, dimensions: string | null): string {
  const head: string[] = [];
  if (spec.substrate) head.push(spec.substrate);
  const size = dimensions ?? spec.size;
  if (size) head.push(size);

  const parts: string[] = [];
  if (head.length > 0) parts.push(head.join(' '));
  if (spec.gsm !== null) parts.push(`${spec.gsm} gsm`);
  if (spec.colours) parts.push(spec.colours);
  if (spec.sides !== null) parts.push(spec.sides === 2 ? 'double-sided' : 'single-sided');
  if (spec.lamination && spec.lamination.trim().toUpperCase() !== 'NONE') {
    parts.push(`${spec.lamination} lamination`);
  }
  if (spec.finishing.length > 0) parts.push(spec.finishing.join(', '));

  const rendered = parts.join(', ').trim();
  return rendered.length > 0 ? rendered : 'Item';
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-212 — line resolution
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedLine {
  lineNo: number;
  kind: 'AREA' | 'QTY';
  description: string;
  spec: NormalisedSpec;
  hsnSac: string | null;
  isService: boolean;
  uomCode: string;
  materialId: string | null;
  rateCardId: string | null;
  rateSource: RateSource;
  /** Exactly what the shared engine is handed for this line. */
  pricing: PricingLineInput;
}

async function loadMasters(
  tenantId: string,
  lines: QuoteLineInput[],
  client: Client,
): Promise<{ materials: Map<string, MaterialRow>; rateCards: Map<string, RateCardRow> }> {
  const materialIds = [...new Set(lines.map((l) => l.materialId).filter((id): id is string => Boolean(id)))];
  const rateCardIds = [...new Set(lines.map((l) => l.rateCardId).filter((id): id is string => Boolean(id)))];

  const [materials, rateCards] = await Promise.all([
    materialIds.length > 0
      ? client.materialItem.findMany({ where: { tenantId, id: { in: materialIds } }, include: MATERIAL_INCLUDE })
      : Promise.resolve([] as MaterialRow[]),
    rateCardIds.length > 0
      ? client.rateCard.findMany({ where: { tenantId, id: { in: rateCardIds } }, include: { uom: true } })
      : Promise.resolve([] as RateCardRow[]),
  ]);

  return {
    materials: new Map(materials.map((m) => [m.id, m])),
    rateCards: new Map(rateCards.map((rc) => [rc.id, rc])),
  };
}

const dec = (value: { toString(): string } | null | undefined): string | undefined =>
  value === null || value === undefined ? undefined : value.toString();

/**
 * FR-212 — "Rate resolution order: explicit line override → active Material
 * master rate → error if none. The source of the rate is recorded on the line."
 * A published RateCard item (FR-216) sits between the master and the error.
 */
export async function resolveLines(
  auth: AuthContext,
  lines: QuoteLineInput[],
  client: Client = prisma,
): Promise<ResolvedLine[]> {
  const { materials, rateCards } = await loadMasters(auth.tenantId, lines, client);

  return lines.map((line, index) => {
    const lineNo = line.lineNo ?? index + 1;

    // BR-4 — a master id from another tenant simply does not resolve.
    const material = line.materialId ? materials.get(line.materialId) ?? null : null;
    if (line.materialId && !material) {
      throw unprocessable('Unknown material item on this line', 'UNKNOWN_MATERIAL', { lineNo });
    }
    const rateCard = line.rateCardId ? rateCards.get(line.rateCardId) ?? null : null;
    if (line.rateCardId && !rateCard) {
      throw unprocessable('Unknown rate card item on this line', 'UNKNOWN_RATE_CARD', { lineNo });
    }

    const explicitRate = line.rate ?? undefined;
    const explicitCost = line.costRate ?? undefined;

    let rate: string | undefined;
    let rateSource: RateSource;

    if (explicitRate !== undefined) {
      rate = explicitRate;
      rateSource = 'LINE_OVERRIDE';
    } else if (explicitCost !== undefined) {
      // FR-213 — cost + markup supplied on the line; the engine derives selling.
      rateSource = 'LINE_OVERRIDE';
    } else if (material && material.active && material.sellingRate !== null) {
      rate = material.sellingRate.toString();
      rateSource = 'MATERIAL_MASTER';
    } else if (rateCard && rateCard.active) {
      rate = rateCard.publishedRate.toString();
      rateSource = 'RATE_CARD';
    } else {
      // FR-212 AC 3 — "a media item with no active rate … blocks auto-pricing".
      throw new PricingError(
        material
          ? `"${material.name}" has no active selling rate — set one on the material master or override the rate on this line`
          : 'No rate available for this line — pick a material or rate-card item, or enter a rate',
        'RATE_UNAVAILABLE',
        lineNo,
      );
    }

    // FR-212 — the master also supplies HSN/SAC, GST% and minimum charge.
    const hsnSac = line.hsnSac ?? material?.hsnSac?.code ?? rateCard?.hsnSac ?? null;
    const gstPct =
      line.gstPct ??
      dec(material?.gstPct) ??
      dec(material?.hsnSac?.defaultTaxRate?.gstPct) ??
      dec(rateCard?.gstPct) ??
      '0';
    const minCharge = line.minCharge ?? dec(material?.minCharge) ?? dec(rateCard?.minCharge);
    const isService = line.isService ?? (material?.hsnSac ? material.hsnSac.type === 'SAC' : true);
    const uomCode =
      line.uomCode ??
      material?.uom?.uomCode ??
      rateCard?.uom?.uomCode ??
      (line.kind === 'AREA' ? 'SQFT' : 'NOS');

    const qty = line.qty ?? '1';
    const heightFt = line.heightFt ?? undefined;
    const widthFt = line.widthFt ?? undefined;

    // FR-211 — dimensions are mandatory for square-foot pricing; the engine
    // enforces it too, but naming the line here gives a better message.
    if (line.kind === 'AREA' && (heightFt === undefined || widthFt === undefined)) {
      throw new PricingError(
        'Height and width are required for square-foot pricing',
        'DIMENSIONS_REQUIRED',
        lineNo,
      );
    }

    const h = feet(heightFt);
    const w = feet(widthFt);
    const dimensions = line.kind === 'AREA' && h !== null && w !== null ? `${h}×${w} ft` : null;

    const fallbackSubstrate = material?.name ?? rateCard?.itemName ?? null;
    const spec = normaliseSpec(line.spec, fallbackSubstrate, dimensions);
    const description = line.description ?? renderLineDescription(spec, dimensions);

    const pricing: PricingLineInput = {
      lineNo,
      kind: line.kind,
      description,
      hsnSac,
      isService,
      qty,
      ...(heightFt !== undefined ? { heightFt } : {}),
      ...(widthFt !== undefined ? { widthFt } : {}),
      ...(rate !== undefined ? { rate } : {}),
      rateSource,
      // Cost is carried for margin visibility; an explicit rate always wins.
      ...(explicitCost !== undefined || material?.costRate
        ? { costRate: explicitCost ?? dec(material?.costRate) }
        : {}),
      ...(line.markupPct !== null && line.markupPct !== undefined ? { markupPct: line.markupPct } : {}),
      ...(line.markupMode ? { markupMode: line.markupMode as MarkupMode } : {}),
      ...(line.addOnRate !== null && line.addOnRate !== undefined ? { addOnRate: line.addOnRate } : {}),
      ...(line.addOnFlat !== null && line.addOnFlat !== undefined ? { addOnFlat: line.addOnFlat } : {}),
      ...(minCharge !== undefined ? { minCharge } : {}),
      ...(line.discountPct !== null && line.discountPct !== undefined ? { discountPct: line.discountPct } : {}),
      ...(line.discountAmt !== null && line.discountAmt !== undefined ? { discountAmt: line.discountAmt } : {}),
      gstPct,
      ...(line.cessPct !== null && line.cessPct !== undefined ? { cessPct: line.cessPct } : {}),
    };

    return {
      lineNo,
      kind: line.kind,
      description,
      spec,
      hsnSac,
      isService,
      uomCode,
      materialId: material?.id ?? null,
      rateCardId: rateCard?.id ?? null,
      rateSource,
      pricing,
    };
  });
}

export interface DocumentOptions {
  isInterstate: boolean;
  docDiscountPct?: string | null;
  docDiscountAmt?: string | null;
}

/** Assemble the document-level input, applying the tenant's FR-213/FR-215 defaults. */
export function buildDocumentInput(
  ctx: PricingContext,
  resolved: ResolvedLine[],
  options: DocumentOptions,
): PricingDocumentInput {
  return {
    lines: resolved.map((r) => r.pricing),
    isInterstate: options.isInterstate,
    // FR-224 — "If tenant is not GST-registered … the tenant setting suppresses tax lines."
    taxEnabled: ctx.tenant.gstRegistered,
    ...(options.docDiscountPct !== null && options.docDiscountPct !== undefined
      ? { docDiscountPct: options.docDiscountPct }
      : {}),
    ...(options.docDiscountAmt !== null && options.docDiscountAmt !== undefined
      ? { docDiscountAmt: options.docDiscountAmt }
      : {}),
    defaultMarkupPct: ctx.tenant.defaultMarkupPct.toString(),
    defaultMarkupMode: ctx.tenant.defaultMarkupMode,
    roundUpFeet: ctx.tenant.roundUpFeet,
    roundingMode: ctx.roundingMode,
    roundingPrecision: ctx.roundingPrecision,
    maxDiscountPct: ctx.tenant.maxDiscountPct.toString(),
  };
}
