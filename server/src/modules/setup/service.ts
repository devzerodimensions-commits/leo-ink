/**
 * Setup & configuration services — FRD §3 (FR-100 … FR-119), §9.4 (FR-718)
 * and §9.6 (FR-722 … FR-725).
 *
 * Every query filters by `auth.tenantId` (BR-4); every money/rate value crosses
 * the wire as a fixed-decimal string (BR-1).
 */
import bcrypt from 'bcryptjs';
import type { z } from 'zod';
import type { DocType, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { assertBranchAccess, type AuthContext } from '../../auth/middleware.js';
import { D, money, rate, round2 } from '../../lib/money.js';
import { fyLabel, fyRange, fyStartYear, tenantToday, toDateOnly } from '../../lib/fy.js';
import {
  isValidIfsc,
  isValidPan,
  isValidStateCode,
  panFromGstin,
  stateName,
  validateGstin,
} from '../../lib/gstin.js';
import { renderNumber, validateRenderedLength, GST_DOC_NUMBER_MAX_LENGTH } from '../../lib/numbering.js';
import { resolveGstTreatment, splitTax } from '../../engine/pricing.js';
import { recordAudit } from './audit.js';
import {
  assertBranchSlotAvailable,
  assertSeatAvailable,
  loadPlanUsage,
  trialState,
} from './limits.js';
import { DEFAULT_PLANS, planCatalogEntry } from '../auth/seed.js';
import type {
  auditQuerySchema,
  bankAccountCreateSchema,
  bankAccountUpdateSchema,
  branchCreateSchema,
  branchUpdateSchema,
  firmUpdateSchema,
  fyCreateSchema,
  fyRolloverSchema,
  fyUpdateSchema,
  hsnCreateSchema,
  hsnUpdateSchema,
  planChangeSchema,
  RoundingRuleInput,
  seriesCreateSchema,
  seriesPreviewSchema,
  seriesUpdateSchema,
  taxRateCreateSchema,
  taxRateUpdateSchema,
  taxSplitQuerySchema,
  termsCreateSchema,
  termsUpdateSchema,
  uomCreateSchema,
  uomUpdateSchema,
  userCreateSchema,
  userUpdateSchema,
  wizardUpdateSchema,
} from './schemas.js';

export const BCRYPT_ROUNDS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// serialisation helpers — BR-1: decimals leave as strings, never JS numbers
// ─────────────────────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const dateOnly = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** Prisma hands back its own Decimal class; route it through its string form so no float is ever created (BR-1). */
const str = (v: unknown): string => (v === null || v === undefined ? '0' : String(v));
/** 2-decimal money string. */
const m2 = (v: unknown): string => money(str(v));
/** 4-decimal rate string. */
const m4 = (v: unknown): string => rate(str(v));

// ─────────────────────────────────────────────────────────────────────────────
// FR-101 — firm profile & branding
// ─────────────────────────────────────────────────────────────────────────────

type TenantRow = Prisma.TenantGetPayload<Record<string, never>>;

function serializeFirm(t: TenantRow) {
  return {
    id: t.id,
    legalName: t.legalName,
    tradeName: t.tradeName,
    constitution: t.constitution,
    gstin: t.gstin,
    pan: t.pan,
    /** FR-101 — derived from GSTIN digits 1-2 and displayed read-only. */
    homeStateCode: t.homeStateCode,
    homeStateName: t.homeStateCode ? stateName(t.homeStateCode) : null,
    addressLine1: t.addressLine1,
    addressLine2: t.addressLine2,
    city: t.city,
    stateCode: t.stateCode,
    pincode: t.pincode,
    email: t.email,
    phone: t.phone,
    website: t.website,
    logoUrl: t.logoUrl,
    baseCurrency: t.baseCurrency,
    decimalPrecision: t.decimalPrecision,
    gstRegistered: t.gstRegistered,
    status: t.status,
    goLiveReady: t.goLiveReady,
    wizardStep: t.wizardStep,
    defaultMarkupPct: m4(t.defaultMarkupPct),
    defaultMarkupMode: t.defaultMarkupMode,
    maxDiscountPct: m4(t.maxDiscountPct),
    quoteValidityDays: t.quoteValidityDays,
    roundUpFeet: t.roundUpFeet,
    defaultVertical: t.defaultVertical,
    timezone: t.timezone,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

async function loadTenant(auth: AuthContext): Promise<TenantRow> {
  const tenant = await prisma.tenant.findUnique({ where: { id: auth.tenantId } });
  if (!tenant) throw notFound('Tenant not found');
  return tenant;
}

export async function getFirm(auth: AuthContext) {
  return { firm: serializeFirm(await loadTenant(auth)) };
}

export async function updateFirm(auth: AuthContext, input: z.infer<typeof firmUpdateSchema>) {
  const before = await loadTenant(auth);

  const data: Prisma.TenantUpdateInput = {};
  let homeStateCode = before.homeStateCode;

  // FR-101 — GSTIN format + checksum, then derive the home state.
  const gstinGiven = input.gstin !== undefined;
  const nextGstin = gstinGiven ? (input.gstin ?? '') : before.gstin ?? '';

  if (gstinGiven) {
    if (nextGstin === '') {
      data.gstin = null;
      homeStateCode = null;
    } else {
      const check = validateGstin(nextGstin);
      if (!check.valid) {
        // FR-101 acceptance: a bad checksum is rejected with "GSTIN checksum invalid".
        throw unprocessable(check.message ?? 'GSTIN is invalid', `GSTIN_${check.problem ?? 'INVALID'}`);
      }
      data.gstin = nextGstin;
      homeStateCode = check.stateCode ?? null;
    }
    data.homeStateCode = homeStateCode;
  }

  const panGiven = input.pan !== undefined;
  const nextPan = panGiven ? (input.pan ?? '') : before.pan ?? '';
  if (panGiven) {
    if (nextPan === '') {
      data.pan = null;
    } else {
      if (!isValidPan(nextPan)) throw unprocessable('PAN must be 10 characters in the format AAAAA0000A', 'PAN_FORMAT');
      data.pan = nextPan;
    }
  }

  // FR-101 — "PAN embedded in GSTIN must equal the PAN field when both present."
  if (nextGstin && nextPan) {
    const embedded = panFromGstin(nextGstin);
    if (embedded && embedded !== nextPan) {
      throw unprocessable(
        `PAN ${nextPan} does not match the PAN embedded in the GSTIN (${embedded})`,
        'PAN_GSTIN_MISMATCH',
      );
    }
  }

  if (input.legalName !== undefined) data.legalName = input.legalName;
  if (input.tradeName !== undefined) data.tradeName = input.tradeName || null;
  if (input.constitution !== undefined) data.constitution = input.constitution || null;
  if (input.addressLine1 !== undefined) data.addressLine1 = input.addressLine1 || null;
  if (input.addressLine2 !== undefined) data.addressLine2 = input.addressLine2 || null;
  if (input.city !== undefined) data.city = input.city || null;
  if (input.pincode !== undefined) data.pincode = input.pincode || null;
  if (input.email !== undefined) data.email = input.email || null;
  if (input.phone !== undefined) data.phone = input.phone || null;
  if (input.website !== undefined) data.website = input.website || null;
  if (input.logoUrl !== undefined) data.logoUrl = input.logoUrl || null;
  if (input.gstRegistered !== undefined) data.gstRegistered = input.gstRegistered;
  if (input.baseCurrency !== undefined) data.baseCurrency = input.baseCurrency.toUpperCase();
  if (input.decimalPrecision !== undefined) data.decimalPrecision = input.decimalPrecision;
  if (input.timezone !== undefined) data.timezone = input.timezone || 'Asia/Kolkata';

  if (input.stateCode !== undefined && input.stateCode !== null) {
    if (!isValidStateCode(input.stateCode)) throw unprocessable(`Unknown GST state code "${input.stateCode}"`, 'STATE_CODE');
    data.stateCode = input.stateCode;
  } else if (homeStateCode && !before.stateCode) {
    // The firm's postal state defaults to the GSTIN's state when not stated.
    data.stateCode = homeStateCode;
  }

  const after = await prisma.tenant.update({ where: { id: auth.tenantId }, data });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'FIRM',
    entityId: after.id,
    action: 'UPDATE',
    actorId: auth.userId,
    before: { legalName: before.legalName, gstin: before.gstin, pan: before.pan, homeStateCode: before.homeStateCode },
    after: { legalName: after.legalName, gstin: after.gstin, pan: after.pan, homeStateCode: after.homeStateCode },
  });

  return { firm: serializeFirm(after) };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-100 — guided first-run setup wizard
// ─────────────────────────────────────────────────────────────────────────────

export interface WizardStepState {
  key: string;
  label: string;
  complete: boolean;
  required: boolean;
  blockers: string[];
}

/** FR-100 — "Tenant cannot be marked go-live ready until firm GSTIN/state, one active branch, and one financial year exist." */
async function wizardState(auth: AuthContext) {
  const tenant = await loadTenant(auth);
  const [activeBranches, financialYears, activeSeries, activeBanks] = await Promise.all([
    prisma.branch.count({ where: { tenantId: auth.tenantId, active: true } }),
    prisma.financialYear.count({ where: { tenantId: auth.tenantId } }),
    prisma.numberingSeries.count({ where: { tenantId: auth.tenantId, active: true } }),
    prisma.bankAccount.count({ where: { tenantId: auth.tenantId, active: true } }),
  ]);

  const firmBlockers: string[] = [];
  if (!tenant.legalName) firmBlockers.push('Firm legal name is required');
  if (tenant.gstRegistered && !tenant.gstin) firmBlockers.push('Firm GSTIN is required');
  if (!tenant.homeStateCode && !tenant.stateCode) firmBlockers.push('Firm state is required');

  const steps: WizardStepState[] = [
    {
      key: 'firm',
      label: 'Firm profile & GSTIN',
      complete: firmBlockers.length === 0,
      required: true,
      blockers: firmBlockers,
    },
    {
      key: 'branch',
      label: 'First branch',
      complete: activeBranches > 0,
      required: true,
      blockers: activeBranches > 0 ? [] : ['At least one active branch is required'],
    },
    {
      key: 'financial_year',
      label: 'Financial year',
      complete: financialYears > 0,
      required: true,
      blockers: financialYears > 0 ? [] : ['At least one financial year is required'],
    },
    {
      key: 'numbering',
      label: 'Document numbering',
      complete: activeSeries > 0,
      required: false,
      blockers: activeSeries > 0 ? [] : ['No active numbering series configured'],
    },
    {
      key: 'bank',
      label: 'Bank account',
      complete: activeBanks > 0,
      required: false,
      blockers: activeBanks > 0 ? [] : ['No bank account added — invoices will print without payment details'],
    },
  ];

  const blockers = steps.filter((s) => s.required && !s.complete).flatMap((s) => s.blockers);
  const firstIncomplete = steps.find((s) => !s.complete);

  return {
    tenant,
    steps,
    blockers,
    canGoLive: blockers.length === 0,
    // FR-100 — "the wizard resumes at the first incomplete step with prior entries retained".
    currentStep: tenant.goLiveReady ? 'complete' : firstIncomplete?.key ?? 'complete',
  };
}

function serializeWizard(state: Awaited<ReturnType<typeof wizardState>>) {
  return {
    wizard: {
      status: state.tenant.status,
      goLiveReady: state.tenant.goLiveReady,
      /** Where the user left off, persisted across sessions. */
      savedStep: state.tenant.wizardStep,
      currentStep: state.currentStep,
      canGoLive: state.canGoLive,
      blockers: state.blockers,
      steps: state.steps,
    },
    firm: serializeFirm(state.tenant),
  };
}

export async function getWizard(auth: AuthContext) {
  return serializeWizard(await wizardState(auth));
}

export async function updateWizard(auth: AuthContext, input: z.infer<typeof wizardUpdateSchema>) {
  const state = await wizardState(auth);

  const data: Prisma.TenantUpdateInput = {};
  if (input.step) data.wizardStep = input.step;

  if (input.complete) {
    if (!state.canGoLive) {
      throw unprocessable('Setup cannot be completed yet', 'GO_LIVE_BLOCKED', { missing: state.blockers });
    }
    data.status = 'LIVE';
    data.goLiveReady = true;
    data.wizardStep = 'complete';
  }

  if (Object.keys(data).length === 0) return serializeWizard(state);

  await prisma.tenant.update({ where: { id: auth.tenantId }, data });

  if (input.complete) {
    await recordAudit({
      tenantId: auth.tenantId,
      entityType: 'TENANT',
      entityId: auth.tenantId,
      action: 'GO_LIVE',
      actorId: auth.userId,
      before: { status: state.tenant.status, goLiveReady: state.tenant.goLiveReady },
      after: { status: 'LIVE', goLiveReady: true },
    });
  }

  return serializeWizard(await wizardState(auth));
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-103 / FR-118 — branches
// ─────────────────────────────────────────────────────────────────────────────

type BranchRow = Prisma.BranchGetPayload<Record<string, never>>;

function serializeBranch(b: BranchRow) {
  return {
    id: b.id,
    branchCode: b.branchCode,
    name: b.name,
    gstin: b.gstin,
    stateCode: b.stateCode,
    stateName: stateName(b.stateCode),
    addressLine1: b.addressLine1,
    addressLine2: b.addressLine2,
    city: b.city,
    pincode: b.pincode,
    phone: b.phone,
    isHeadOffice: b.isHeadOffice,
    active: b.active,
    defaultBankAccount: b.defaultBankAccount,
    createdAt: iso(b.createdAt),
    updatedAt: iso(b.updatedAt),
  };
}

/** Resolve the state code a branch will carry, cross-checking any GSTIN supplied. */
function resolveBranchState(gstin: string | null | undefined, given: string | null | undefined): string {
  let derived: string | null = null;
  if (gstin) {
    const check = validateGstin(gstin);
    if (!check.valid) throw unprocessable(check.message ?? 'GSTIN is invalid', `GSTIN_${check.problem ?? 'INVALID'}`);
    derived = check.stateCode ?? null;
  }
  const stateCode = given ?? derived;
  if (!stateCode) throw unprocessable('Branch state code is required', 'STATE_CODE_REQUIRED');
  if (!isValidStateCode(stateCode)) throw unprocessable(`Unknown GST state code "${stateCode}"`, 'STATE_CODE');
  if (derived && given && derived !== given) {
    throw unprocessable(
      `Branch state ${given} does not match the GSTIN's state code ${derived}`,
      'BRANCH_STATE_MISMATCH',
    );
  }
  return stateCode;
}

export async function listBranches(auth: AuthContext, opts: { includeInactive?: boolean }) {
  const where: Prisma.BranchWhereInput = { tenantId: auth.tenantId };
  // FR-118 — "deactivated branches are hidden from new-document selection but retained for history."
  if (!opts.includeInactive) where.active = true;
  // FR-717 — a branch-scoped user only ever sees their own branches.
  if (!auth.allBranches && auth.branchIds.length > 0) where.id = { in: auth.branchIds };

  const rows = await prisma.branch.findMany({ where, orderBy: [{ isHeadOffice: 'desc' }, { branchCode: 'asc' }] });
  return { branches: rows.map(serializeBranch) };
}

export async function getBranch(auth: AuthContext, id: string) {
  const row = await prisma.branch.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw notFound('Branch not found');
  assertBranchAccess(auth, row.id);
  return { branch: serializeBranch(row) };
}

export async function createBranch(auth: AuthContext, input: z.infer<typeof branchCreateSchema>) {
  const stateCode = resolveBranchState(input.gstin ?? null, input.stateCode ?? null);
  const active = input.active ?? true;

  const branch = await prisma.$transaction(async (tx) => {
    // FR-725 — plan branch limit, enforced server-side.
    if (active) await assertBranchSlotAvailable(auth.tenantId, tx);

    // FR-103 — "branch code is unique within the tenant."
    const dupe = await tx.branch.findFirst({
      where: { tenantId: auth.tenantId, branchCode: input.branchCode },
      select: { id: true },
    });
    if (dupe) throw conflict(`Branch code "${input.branchCode}" is already in use`, 'BRANCH_CODE_DUPLICATE');

    const existing = await tx.branch.count({ where: { tenantId: auth.tenantId } });
    // FR-103 — "Exactly one branch is flagged head office"; the first one always is.
    const isHeadOffice = existing === 0 ? true : input.isHeadOffice ?? false;
    if (isHeadOffice) {
      await tx.branch.updateMany({ where: { tenantId: auth.tenantId, isHeadOffice: true }, data: { isHeadOffice: false } });
    }

    return tx.branch.create({
      data: {
        tenantId: auth.tenantId,
        branchCode: input.branchCode,
        name: input.name,
        gstin: input.gstin || null,
        stateCode,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        pincode: input.pincode ?? null,
        phone: input.phone ?? null,
        isHeadOffice,
        active,
        defaultBankAccount: input.defaultBankAccount ?? null,
      },
    });
  });

  await recordAudit({
    tenantId: auth.tenantId,
    branchId: branch.id,
    entityType: 'BRANCH',
    entityId: branch.id,
    action: 'CREATE',
    actorId: auth.userId,
    after: serializeBranch(branch),
  });

  return { branch: serializeBranch(branch) };
}

export async function updateBranch(auth: AuthContext, id: string, input: z.infer<typeof branchUpdateSchema>) {
  const before = await prisma.branch.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw notFound('Branch not found');
  assertBranchAccess(auth, before.id);

  const nextGstin = input.gstin !== undefined ? input.gstin || null : before.gstin;
  const stateCode =
    input.stateCode !== undefined || input.gstin !== undefined
      ? // With a GSTIN present the state follows it; clearing the GSTIN keeps the stored state.
        resolveBranchState(nextGstin, input.stateCode ?? (nextGstin ? null : before.stateCode))
      : before.stateCode;

  const updated = await prisma.$transaction(async (tx) => {
    if (input.branchCode && input.branchCode !== before.branchCode) {
      const dupe = await tx.branch.findFirst({
        where: { tenantId: auth.tenantId, branchCode: input.branchCode, id: { not: id } },
        select: { id: true },
      });
      if (dupe) throw conflict(`Branch code "${input.branchCode}" is already in use`, 'BRANCH_CODE_DUPLICATE');
    }

    if (input.active === false && before.active) {
      if (before.isHeadOffice) {
        const others = await tx.branch.count({ where: { tenantId: auth.tenantId, active: true, id: { not: id } } });
        if (others > 0) {
          throw conflict(
            'The head-office branch cannot be deactivated — designate another branch as head office first',
            'HEAD_OFFICE_REQUIRED',
          );
        }
      }
    }
    // FR-725 — re-activating a branch consumes a plan slot again.
    if (input.active === true && !before.active) await assertBranchSlotAvailable(auth.tenantId, tx);

    if (input.isHeadOffice === true) {
      await tx.branch.updateMany({
        where: { tenantId: auth.tenantId, isHeadOffice: true, id: { not: id } },
        data: { isHeadOffice: false },
      });
    } else if (input.isHeadOffice === false && before.isHeadOffice) {
      throw unprocessable(
        'Exactly one branch must be the head office — mark another branch as head office instead',
        'HEAD_OFFICE_REQUIRED',
      );
    }

    return tx.branch.update({
      where: { id },
      data: {
        branchCode: input.branchCode ?? undefined,
        name: input.name ?? undefined,
        gstin: input.gstin !== undefined ? input.gstin || null : undefined,
        stateCode,
        addressLine1: input.addressLine1 !== undefined ? input.addressLine1 || null : undefined,
        addressLine2: input.addressLine2 !== undefined ? input.addressLine2 || null : undefined,
        city: input.city !== undefined ? input.city || null : undefined,
        pincode: input.pincode !== undefined ? input.pincode || null : undefined,
        phone: input.phone !== undefined ? input.phone || null : undefined,
        isHeadOffice: input.isHeadOffice ?? undefined,
        active: input.active ?? undefined,
        defaultBankAccount: input.defaultBankAccount !== undefined ? input.defaultBankAccount || null : undefined,
      },
    });
  });

  await recordAudit({
    tenantId: auth.tenantId,
    branchId: id,
    entityType: 'BRANCH',
    entityId: id,
    action: 'UPDATE',
    actorId: auth.userId,
    before: serializeBranch(before),
    after: serializeBranch(updated),
  });

  return { branch: serializeBranch(updated) };
}

export async function deleteBranch(auth: AuthContext, id: string) {
  const branch = await prisma.branch.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!branch) throw notFound('Branch not found');
  assertBranchAccess(auth, branch.id);

  // FR-103 — "A branch with posted transactions cannot be hard-deleted, only deactivated."
  const [quotes, jobcards] = await Promise.all([
    prisma.quote.count({ where: { tenantId: auth.tenantId, branchId: id } }),
    prisma.jobcard.count({ where: { tenantId: auth.tenantId, branchId: id } }),
  ]);
  if (quotes + jobcards > 0) {
    throw new AppError(
      `This branch has ${quotes} quotation(s) and ${jobcards} jobcard(s) against it and cannot be deleted. Deactivate it instead — history is preserved and it disappears from new-document selection.`,
      409,
      'BRANCH_IN_USE',
      { quotes, jobcards, deactivate: { method: 'PUT', path: `/api/setup/branches/${id}`, body: { active: false } } },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.numberingSeries.deleteMany({ where: { tenantId: auth.tenantId, branchId: id } });
    await tx.userBranch.deleteMany({ where: { branchId: id } });
    await tx.branch.delete({ where: { id } });

    // Keep the "exactly one head office" invariant.
    if (branch.isHeadOffice) {
      const next = await tx.branch.findFirst({
        where: { tenantId: auth.tenantId, active: true },
        orderBy: { createdAt: 'asc' },
      });
      if (next) await tx.branch.update({ where: { id: next.id }, data: { isHeadOffice: true } });
    }
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'BRANCH',
    entityId: id,
    action: 'DELETE',
    actorId: auth.userId,
    before: serializeBranch(branch),
  });

  return { deleted: true, id };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-102 — bank accounts
// ─────────────────────────────────────────────────────────────────────────────

type BankRow = Prisma.BankAccountGetPayload<Record<string, never>>;

/** FR-102 — "Account number is masked in list views, shown in full only on the edit form." */
export function maskAccountNo(accountNo: string): string {
  const tail = accountNo.slice(-4);
  return `${'X'.repeat(Math.max(0, accountNo.length - 4))}${tail}`;
}

function serializeBank(b: BankRow, opts: { masked: boolean }) {
  return {
    id: b.id,
    accountName: b.accountName,
    accountNo: opts.masked ? maskAccountNo(b.accountNo) : b.accountNo,
    accountNoMasked: maskAccountNo(b.accountNo),
    ifsc: b.ifsc,
    bankName: b.bankName,
    branchName: b.branchName,
    upiVpa: b.upiVpa,
    isDefault: b.isDefault,
    active: b.active,
    createdAt: iso(b.createdAt),
    updatedAt: iso(b.updatedAt),
  };
}

export async function listBankAccounts(auth: AuthContext, opts: { includeInactive?: boolean }) {
  const where: Prisma.BankAccountWhereInput = { tenantId: auth.tenantId };
  if (!opts.includeInactive) where.active = true;
  const rows = await prisma.bankAccount.findMany({ where, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
  return { bankAccounts: rows.map((r) => serializeBank(r, { masked: true })) };
}

export async function getBankAccount(auth: AuthContext, id: string) {
  const row = await prisma.bankAccount.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw notFound('Bank account not found');
  return { bankAccount: serializeBank(row, { masked: false }) };
}

function assertIfsc(ifsc: string): void {
  // FR-102 — "IFSC must match the 11-character format (4 letters + `0` + 6 alphanumeric)".
  if (!isValidIfsc(ifsc)) {
    throw unprocessable('IFSC must be 11 characters: 4 letters, then 0, then 6 letters/digits', 'IFSC_FORMAT');
  }
}

export async function createBankAccount(auth: AuthContext, input: z.infer<typeof bankAccountCreateSchema>) {
  assertIfsc(input.ifsc);

  const account = await prisma.$transaction(async (tx) => {
    const existing = await tx.bankAccount.count({ where: { tenantId: auth.tenantId } });
    const isDefault = existing === 0 ? true : input.isDefault ?? false;
    // FR-102 — "exactly one account may be marked default per branch/tenant."
    if (isDefault) {
      await tx.bankAccount.updateMany({ where: { tenantId: auth.tenantId, isDefault: true }, data: { isDefault: false } });
    }
    return tx.bankAccount.create({
      data: {
        tenantId: auth.tenantId,
        accountName: input.accountName,
        accountNo: input.accountNo,
        ifsc: input.ifsc,
        bankName: input.bankName,
        branchName: input.branchName ?? null,
        upiVpa: input.upiVpa || null,
        isDefault,
        active: input.active ?? true,
      },
    });
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'BANK_ACCOUNT',
    entityId: account.id,
    action: 'CREATE',
    actorId: auth.userId,
    after: serializeBank(account, { masked: true }),
  });

  return { bankAccount: serializeBank(account, { masked: false }) };
}

export async function updateBankAccount(auth: AuthContext, id: string, input: z.infer<typeof bankAccountUpdateSchema>) {
  const before = await prisma.bankAccount.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw notFound('Bank account not found');
  if (input.ifsc !== undefined) assertIfsc(input.ifsc);

  const updated = await prisma.$transaction(async (tx) => {
    if (input.isDefault === true) {
      await tx.bankAccount.updateMany({
        where: { tenantId: auth.tenantId, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }
    return tx.bankAccount.update({
      where: { id },
      data: {
        accountName: input.accountName ?? undefined,
        accountNo: input.accountNo ?? undefined,
        ifsc: input.ifsc ?? undefined,
        bankName: input.bankName ?? undefined,
        branchName: input.branchName !== undefined ? input.branchName || null : undefined,
        upiVpa: input.upiVpa !== undefined ? input.upiVpa || null : undefined,
        isDefault: input.isDefault ?? undefined,
        active: input.active ?? undefined,
      },
    });
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'BANK_ACCOUNT',
    entityId: id,
    action: 'UPDATE',
    actorId: auth.userId,
    before: serializeBank(before, { masked: true }),
    after: serializeBank(updated, { masked: true }),
  });

  return { bankAccount: serializeBank(updated, { masked: false }) };
}

export async function deleteBankAccount(auth: AuthContext, id: string) {
  const before = await prisma.bankAccount.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw notFound('Bank account not found');

  await prisma.$transaction(async (tx) => {
    await tx.branch.updateMany({
      where: { tenantId: auth.tenantId, defaultBankAccount: id },
      data: { defaultBankAccount: null },
    });
    await tx.bankAccount.delete({ where: { id } });
    if (before.isDefault) {
      const next = await tx.bankAccount.findFirst({
        where: { tenantId: auth.tenantId, active: true },
        orderBy: { createdAt: 'asc' },
      });
      if (next) await tx.bankAccount.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'BANK_ACCOUNT',
    entityId: id,
    action: 'DELETE',
    actorId: auth.userId,
    before: serializeBank(before, { masked: true }),
  });

  return { deleted: true, id };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-104 / FR-105 — financial years
// ─────────────────────────────────────────────────────────────────────────────

type FyRow = Prisma.FinancialYearGetPayload<Record<string, never>>;

function serializeFy(f: FyRow) {
  return {
    id: f.id,
    fyLabel: f.fyLabel,
    startDate: dateOnly(f.startDate),
    endDate: dateOnly(f.endDate),
    status: f.status,
    isCurrent: f.isCurrent,
    createdAt: iso(f.createdAt),
    updatedAt: iso(f.updatedAt),
  };
}

export async function listFinancialYears(auth: AuthContext) {
  const rows = await prisma.financialYear.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { startDate: 'desc' },
  });
  return { financialYears: rows.map(serializeFy) };
}

export async function createFinancialYear(auth: AuthContext, input: z.infer<typeof fyCreateSchema>) {
  // FR-104 — "FY start is fixed to 1-April and end to 31-March"; any date inside
  // the year resolves to that year's 1-April.
  const startYear = input.startYear ?? fyStartYear(toDateOnly(input.startDate as Date));
  const range = fyRange(startYear);

  const fy = await prisma.$transaction(async (tx) => {
    const dupe = await tx.financialYear.findFirst({
      where: { tenantId: auth.tenantId, fyLabel: range.fyLabel },
      select: { id: true },
    });
    if (dupe) throw conflict(`Financial year ${range.fyLabel} already exists`, 'FY_DUPLICATE');

    const existing = await tx.financialYear.count({ where: { tenantId: auth.tenantId } });
    const isCurrent = existing === 0 ? true : input.isCurrent ?? false;
    if (isCurrent) {
      await tx.financialYear.updateMany({ where: { tenantId: auth.tenantId, isCurrent: true }, data: { isCurrent: false } });
    }

    return tx.financialYear.create({
      data: {
        tenantId: auth.tenantId,
        fyLabel: range.fyLabel,
        startDate: range.startDate,
        endDate: range.endDate,
        status: 'OPEN',
        isCurrent,
      },
    });
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'FINANCIAL_YEAR',
    entityId: fy.id,
    action: 'CREATE',
    actorId: auth.userId,
    after: serializeFy(fy),
  });

  return { financialYear: serializeFy(fy) };
}

export async function updateFinancialYear(auth: AuthContext, id: string, input: z.infer<typeof fyUpdateSchema>) {
  const before = await prisma.financialYear.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw notFound('Financial year not found');

  // FR-104 — "Posting into a Closed FY is disallowed except through explicit re-open by an Admin."
  if (input.status === 'OPEN' && before.status === 'CLOSED' && auth.role !== 'OWNER_ADMIN') {
    throw forbidden('Only the Owner/Admin may re-open a closed financial year');
  }
  if (input.isCurrent === false && before.isCurrent) {
    throw unprocessable(
      'Exactly one financial year must be current — set another year current instead',
      'FY_CURRENT_REQUIRED',
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (input.isCurrent === true) {
      await tx.financialYear.updateMany({
        where: { tenantId: auth.tenantId, isCurrent: true, id: { not: id } },
        data: { isCurrent: false },
      });
    }
    return tx.financialYear.update({
      where: { id },
      data: { status: input.status ?? undefined, isCurrent: input.isCurrent ?? undefined },
    });
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'FINANCIAL_YEAR',
    entityId: id,
    action: 'UPDATE',
    actorId: auth.userId,
    before: serializeFy(before),
    after: serializeFy(updated),
  });

  return { financialYear: serializeFy(updated) };
}

/** FR-104 — "Given an FY marked current, when another is set current, then the prior one is automatically un-set." */
export async function setCurrentFinancialYear(auth: AuthContext, id: string) {
  const fy = await prisma.financialYear.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!fy) throw notFound('Financial year not found');

  const updated = await prisma.$transaction(async (tx) => {
    await tx.financialYear.updateMany({
      where: { tenantId: auth.tenantId, isCurrent: true, id: { not: id } },
      data: { isCurrent: false },
    });
    return tx.financialYear.update({ where: { id }, data: { isCurrent: true } });
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'FINANCIAL_YEAR',
    entityId: id,
    action: 'SET_CURRENT',
    actorId: auth.userId,
    before: { isCurrent: fy.isCurrent },
    after: { isCurrent: true },
  });

  return { financialYear: serializeFy(updated) };
}

/**
 * FR-105 — year-end rollover.
 *
 * `:id` is the closing year. The next FY is created if missing, party closing
 * balances are carried forward, and YEARLY-reset series restart at their start
 * number. Re-running recomputes rather than duplicating: the new FY is looked up
 * by label, series are upserted by (docType, branch, fy) and the carry-forward
 * figures are derived, never accumulated.
 */
export async function rolloverFinancialYear(
  auth: AuthContext,
  id: string,
  input: z.infer<typeof fyRolloverSchema>,
) {
  const source = await prisma.financialYear.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!source) throw notFound('Financial year not found');

  const nextRange = fyRange(fyStartYear(toDateOnly(source.startDate)) + 1);

  const result = await prisma.$transaction(async (tx) => {
    let target = await tx.financialYear.findFirst({
      where: { tenantId: auth.tenantId, fyLabel: nextRange.fyLabel },
    });
    const created = !target;
    if (!target) {
      target = await tx.financialYear.create({
        data: {
          tenantId: auth.tenantId,
          fyLabel: nextRange.fyLabel,
          startDate: nextRange.startDate,
          endDate: nextRange.endDate,
          status: 'OPEN',
          isCurrent: false,
        },
      });
    }

    // FR-105 — "Rollover is idempotent and re-runnable while the new FY is still Open".
    if (target.status === 'CLOSED') {
      throw conflict(
        `Financial year ${target.fyLabel} is closed — re-open it before running rollover again`,
        'FY_CLOSED',
      );
    }

    // Carry-forward of party closing balances. Phase 1 holds the party opening
    // balance on the master itself, so closing == opening and the recomputation
    // is naturally idempotent (no duplicated opening entries).
    const [customers, suppliers] = await Promise.all([
      tx.customer.findMany({
        where: { tenantId: auth.tenantId, active: true },
        select: { id: true, name: true, openingBalance: true },
        orderBy: { name: 'asc' },
      }),
      tx.supplier.findMany({
        where: { tenantId: auth.tenantId, active: true },
        select: { id: true, name: true, openingBalance: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    // FR-105 / FR-107 — YEARLY series restart at their configured start number.
    const resettable = await tx.numberingSeries.findMany({
      where: {
        tenantId: auth.tenantId,
        resetPolicy: 'YEARLY',
        OR: [{ fyId: null }, { fyId: target.id }],
      },
    });
    let seriesReset = 0;
    for (const series of resettable) {
      if (series.nextNumber !== series.startNumber) {
        await tx.numberingSeries.update({ where: { id: series.id }, data: { nextNumber: series.startNumber } });
      }
      seriesReset += 1;
    }

    // Series pinned to the closing FY get an equivalent for the new FY, once.
    const pinned = await tx.numberingSeries.findMany({
      where: { tenantId: auth.tenantId, fyId: source.id, resetPolicy: 'YEARLY' },
    });
    let seriesCreated = 0;
    for (const series of pinned) {
      const existing = await tx.numberingSeries.findFirst({
        where: { tenantId: auth.tenantId, docType: series.docType, branchId: series.branchId, fyId: target.id },
      });
      if (existing) continue;
      await tx.numberingSeries.create({
        data: {
          tenantId: auth.tenantId,
          docType: series.docType,
          branchId: series.branchId,
          fyId: target.id,
          prefix: series.prefix,
          suffix: series.suffix,
          startNumber: series.startNumber,
          nextNumber: series.startNumber,
          padding: series.padding,
          resetPolicy: 'YEARLY',
          active: series.active,
        },
      });
      seriesCreated += 1;
      seriesReset += 1;
    }

    if (input.setCurrent) {
      await tx.financialYear.updateMany({
        where: { tenantId: auth.tenantId, isCurrent: true, id: { not: target.id } },
        data: { isCurrent: false },
      });
      target = await tx.financialYear.update({ where: { id: target.id }, data: { isCurrent: true } });
    }

    return { target, created, customers, suppliers, seriesReset, seriesCreated };
  }, { timeout: 20_000 });

  const customerOpenings = result.customers.map((c) => ({
    id: c.id,
    name: c.name,
    closingBalance: m2(c.openingBalance),
    openingBalance: m2(c.openingBalance),
  }));
  const supplierOpenings = result.suppliers.map((s) => ({
    id: s.id,
    name: s.name,
    closingBalance: m2(s.openingBalance),
    openingBalance: m2(s.openingBalance),
  }));

  const payload = {
    fromFy: serializeFy(source),
    toFy: serializeFy(result.target),
    /** false on a re-run — the FY already existed and was recomputed, not duplicated. */
    createdFy: result.created,
    seriesReset: result.seriesReset,
    seriesCreated: result.seriesCreated,
    openingBalances: {
      customers: customerOpenings,
      suppliers: supplierOpenings,
      customerTotal: money(customerOpenings.reduce((acc, c) => acc.plus(D(c.openingBalance)), D(0))),
      supplierTotal: money(supplierOpenings.reduce((acc, s) => acc.plus(D(s.openingBalance)), D(0))),
    },
  };

  // FR-105 — "rollover audit log".
  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'FINANCIAL_YEAR',
    entityId: result.target.id,
    action: 'ROLLOVER',
    actorId: auth.userId,
    before: { fromFy: source.fyLabel },
    after: {
      toFy: result.target.fyLabel,
      createdFy: result.created,
      seriesReset: result.seriesReset,
      seriesCreated: result.seriesCreated,
      customers: customerOpenings.length,
      suppliers: supplierOpenings.length,
    },
  });

  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-106 / FR-107 — numbering series
// ─────────────────────────────────────────────────────────────────────────────

type SeriesRow = Prisma.NumberingSeriesGetPayload<Record<string, never>>;

function serializeSeries(s: SeriesRow, ctx?: { branchCode?: string | null; fyLabel?: string | null }) {
  const preview = renderNumber(
    { prefix: s.prefix, suffix: s.suffix, padding: s.padding, nextNumber: s.nextNumber },
    s.nextNumber,
    { branchCode: ctx?.branchCode ?? undefined, fyLabel: ctx?.fyLabel ?? undefined },
  );
  return {
    id: s.id,
    docType: s.docType,
    branchId: s.branchId,
    fyId: s.fyId,
    prefix: s.prefix,
    suffix: s.suffix,
    startNumber: s.startNumber,
    nextNumber: s.nextNumber,
    padding: s.padding,
    resetPolicy: s.resetPolicy,
    active: s.active,
    lastIssuedAt: iso(s.lastIssuedAt),
    preview,
    previewLength: preview.length,
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.updatedAt),
  };
}

async function seriesRenderContext(
  tenantId: string,
  branchId: string | null,
  fyId: string | null,
): Promise<{ branchCode?: string; fyLabel?: string }> {
  const [branch, fy, currentFy] = await Promise.all([
    branchId ? prisma.branch.findFirst({ where: { id: branchId, tenantId }, select: { branchCode: true } }) : null,
    fyId ? prisma.financialYear.findFirst({ where: { id: fyId, tenantId }, select: { fyLabel: true } }) : null,
    prisma.financialYear.findFirst({ where: { tenantId, isCurrent: true }, select: { fyLabel: true } }),
  ]);
  return {
    branchCode: branch?.branchCode ?? undefined,
    fyLabel: fy?.fyLabel ?? currentFy?.fyLabel ?? fyLabel(fyStartYear(tenantToday())),
  };
}

export async function listSeries(auth: AuthContext, opts: { docType?: string; includeInactive?: boolean }) {
  const where: Prisma.NumberingSeriesWhereInput = { tenantId: auth.tenantId };
  if (opts.docType) where.docType = opts.docType as DocType;
  if (!opts.includeInactive) where.active = true;

  const rows = await prisma.numberingSeries.findMany({
    where,
    include: { branch: { select: { branchCode: true } }, fy: { select: { fyLabel: true } } },
    orderBy: [{ docType: 'asc' }, { createdAt: 'asc' }],
  });
  const fallback = await seriesRenderContext(auth.tenantId, null, null);

  return {
    numberingSeries: rows.map((r) =>
      serializeSeries(r, {
        branchCode: r.branch?.branchCode ?? undefined,
        fyLabel: r.fy?.fyLabel ?? fallback.fyLabel,
      }),
    ),
  };
}

async function assertSeriesScope(tenantId: string, branchId: string | null, fyId: string | null): Promise<void> {
  if (branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId }, select: { id: true } });
    if (!branch) throw notFound('Branch not found');
  }
  if (fyId) {
    const fy = await prisma.financialYear.findFirst({ where: { id: fyId, tenantId }, select: { id: true } });
    if (!fy) throw notFound('Financial year not found');
  }
}

export async function createSeries(auth: AuthContext, input: z.infer<typeof seriesCreateSchema>) {
  const branchId = input.branchId ?? null;
  const fyId = input.fyId ?? null;
  if (branchId) assertBranchAccess(auth, branchId);
  await assertSeriesScope(auth.tenantId, branchId, fyId);

  const prefix = input.prefix ?? '';
  const suffix = input.suffix ?? '';
  const padding = input.padding ?? 4;
  const startNumber = input.startNumber ?? 1;
  const active = input.active ?? true;

  // FR-106 — "rendered number must be ≤16 characters for tax invoices".
  const ctx = await seriesRenderContext(auth.tenantId, branchId, fyId);
  validateRenderedLength(
    input.docType as DocType,
    renderNumber({ prefix, suffix, padding, nextNumber: startNumber }, startNumber, ctx),
  );

  const series = await prisma.$transaction(async (tx) => {
    // FR-106 — "Each (doc_type, branch, fy) has at most one active series."
    if (active) {
      const clash = await tx.numberingSeries.findFirst({
        where: { tenantId: auth.tenantId, docType: input.docType as DocType, branchId, fyId, active: true },
        select: { id: true },
      });
      if (clash) {
        throw conflict(
          `An active ${input.docType} numbering series already exists for this branch and financial year`,
          'SERIES_DUPLICATE',
        );
      }
    }
    return tx.numberingSeries.create({
      data: {
        tenantId: auth.tenantId,
        docType: input.docType as DocType,
        branchId,
        fyId,
        prefix,
        suffix,
        startNumber,
        nextNumber: startNumber,
        padding,
        resetPolicy: input.resetPolicy ?? (prefix.includes('{FY}') || suffix.includes('{FY}') ? 'YEARLY' : 'NEVER'),
        active,
      },
    });
  });

  await recordAudit({
    tenantId: auth.tenantId,
    branchId,
    entityType: 'NUMBERING_SERIES',
    entityId: series.id,
    action: 'CREATE',
    actorId: auth.userId,
    after: serializeSeries(series, ctx),
  });

  return { series: serializeSeries(series, ctx) };
}

export async function updateSeries(auth: AuthContext, id: string, input: z.infer<typeof seriesUpdateSchema>) {
  const before = await prisma.numberingSeries.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw notFound('Numbering series not found');
  if (before.branchId) assertBranchAccess(auth, before.branchId);

  const branchId = input.branchId !== undefined ? input.branchId ?? null : before.branchId;
  const fyId = input.fyId !== undefined ? input.fyId ?? null : before.fyId;
  if (branchId && branchId !== before.branchId) assertBranchAccess(auth, branchId);
  await assertSeriesScope(auth.tenantId, branchId, fyId);

  const prefix = input.prefix ?? before.prefix;
  const suffix = input.suffix ?? before.suffix;
  const padding = input.padding ?? before.padding;
  const startNumber = input.startNumber ?? before.startNumber;
  const docType = (input.docType ?? before.docType) as DocType;
  const active = input.active ?? before.active;

  // FR-107 — a series that has already issued numbers may never rewind.
  let nextNumber = before.nextNumber;
  if (input.nextNumber !== undefined) {
    if (before.lastIssuedAt && input.nextNumber < before.nextNumber) {
      throw conflict(
        'This series has already issued numbers — its counter cannot be rewound (numbers must stay gap-free and unique)',
        'SERIES_REWIND_BLOCKED',
      );
    }
    nextNumber = input.nextNumber;
  } else if (!before.lastIssuedAt && input.startNumber !== undefined) {
    nextNumber = startNumber;
  }

  const ctx = await seriesRenderContext(auth.tenantId, branchId, fyId);
  validateRenderedLength(docType, renderNumber({ prefix, suffix, padding, nextNumber }, nextNumber, ctx));

  const updated = await prisma.$transaction(async (tx) => {
    if (active) {
      const clash = await tx.numberingSeries.findFirst({
        where: { tenantId: auth.tenantId, docType, branchId, fyId, active: true, id: { not: id } },
        select: { id: true },
      });
      if (clash) {
        throw conflict(
          `An active ${docType} numbering series already exists for this branch and financial year`,
          'SERIES_DUPLICATE',
        );
      }
    }
    return tx.numberingSeries.update({
      where: { id },
      data: {
        docType,
        branchId,
        fyId,
        prefix,
        suffix,
        padding,
        startNumber,
        nextNumber,
        resetPolicy: input.resetPolicy ?? undefined,
        active,
      },
    });
  });

  await recordAudit({
    tenantId: auth.tenantId,
    branchId,
    entityType: 'NUMBERING_SERIES',
    entityId: id,
    action: 'UPDATE',
    actorId: auth.userId,
    before: serializeSeries(before, ctx),
    after: serializeSeries(updated, ctx),
  });

  return { series: serializeSeries(updated, ctx) };
}

export async function deleteSeries(auth: AuthContext, id: string) {
  const before = await prisma.numberingSeries.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw notFound('Numbering series not found');
  if (before.branchId) assertBranchAccess(auth, before.branchId);

  // FR-107 — numbers already issued from this series must remain reproducible.
  if (before.lastIssuedAt) {
    throw new AppError(
      'This series has already issued document numbers and cannot be deleted. Deactivate it instead.',
      409,
      'SERIES_IN_USE',
      { deactivate: { method: 'PUT', path: `/api/setup/numbering-series/${id}`, body: { active: false } } },
    );
  }

  await prisma.numberingSeries.delete({ where: { id } });
  await recordAudit({
    tenantId: auth.tenantId,
    branchId: before.branchId,
    entityType: 'NUMBERING_SERIES',
    entityId: id,
    action: 'DELETE',
    actorId: auth.userId,
    before: { docType: before.docType, prefix: before.prefix, suffix: before.suffix, padding: before.padding },
  });

  return { deleted: true, id };
}

/**
 * FR-106 — formatted number preview. The rendered value is always returned so
 * the UI can show it; when the GST 16-character limit is breached for a tax
 * document the response carries the block/warning that `validateRenderedLength`
 * raises on save.
 */
export async function previewSeries(auth: AuthContext, input: z.infer<typeof seriesPreviewSchema>) {
  let base = { prefix: '', suffix: '', padding: 4, seq: 1 };
  let docType: DocType | null = (input.docType as DocType | undefined) ?? null;
  let branchId = input.branchId ?? null;
  let fyId = input.fyId ?? null;

  if (input.seriesId) {
    const series = await prisma.numberingSeries.findFirst({
      where: { id: input.seriesId, tenantId: auth.tenantId },
    });
    if (!series) throw notFound('Numbering series not found');
    base = { prefix: series.prefix, suffix: series.suffix, padding: series.padding, seq: series.nextNumber };
    docType = docType ?? series.docType;
    branchId = branchId ?? series.branchId;
    fyId = fyId ?? series.fyId;
  }

  if (!docType) throw badRequest('docType (or seriesId) is required to preview a number');

  const prefix = input.prefix ?? base.prefix;
  const suffix = input.suffix ?? base.suffix;
  const padding = input.padding ?? base.padding;
  const seq = input.seq ?? base.seq;

  const resolved = await seriesRenderContext(auth.tenantId, branchId, fyId);
  const branchCode = input.branchCode ?? resolved.branchCode;
  const fyLabelCtx = input.fyLabel ?? resolved.fyLabel;

  const number = renderNumber({ prefix, suffix, padding, nextNumber: seq }, seq, {
    branchCode,
    fyLabel: fyLabelCtx,
  });

  let blocked = false;
  let warning: string | null = null;
  try {
    validateRenderedLength(docType, number);
  } catch (err) {
    blocked = true;
    warning = err instanceof AppError ? err.message : 'Rendered number exceeds the GST length limit';
  }

  return {
    preview: {
      docType,
      number,
      length: number.length,
      maxLength: GST_DOC_NUMBER_MAX_LENGTH,
      seq,
      branchCode: branchCode ?? null,
      fyLabel: fyLabelCtx ?? null,
      /** true ⇒ saving this series will be rejected with DOC_NUMBER_TOO_LONG. */
      blocked,
      warning,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-108 — GST tax rates & place-of-supply logic
// ─────────────────────────────────────────────────────────────────────────────

type TaxRateRow = Prisma.TaxRateGetPayload<Record<string, never>>;

function serializeTaxRate(t: TaxRateRow) {
  return {
    id: t.id,
    name: t.name,
    gstPct: m4(t.gstPct),
    cessPct: m4(t.cessPct),
    effectiveFrom: dateOnly(t.effectiveFrom),
    active: t.active,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

export async function listTaxRates(auth: AuthContext, opts: { includeInactive?: boolean; onDate?: Date }) {
  const where: Prisma.TaxRateWhereInput = { tenantId: auth.tenantId };
  if (!opts.includeInactive) where.active = true;
  // FR-108 — "the rate applicable on a document's date is used."
  if (opts.onDate) where.effectiveFrom = { lte: toDateOnly(opts.onDate) };

  const rows = await prisma.taxRate.findMany({ where, orderBy: [{ gstPct: 'asc' }, { effectiveFrom: 'desc' }] });
  return { taxRates: rows.map(serializeTaxRate) };
}

export async function createTaxRate(auth: AuthContext, input: z.infer<typeof taxRateCreateSchema>) {
  const dupe = await prisma.taxRate.findFirst({
    where: { tenantId: auth.tenantId, name: input.name },
    select: { id: true },
  });
  if (dupe) throw conflict(`A tax rate named "${input.name}" already exists`, 'TAX_RATE_DUPLICATE');

  const row = await prisma.taxRate.create({
    data: {
      tenantId: auth.tenantId,
      name: input.name,
      gstPct: input.gstPct.toFixed(4),
      cessPct: (input.cessPct ?? D(0)).toFixed(4),
      effectiveFrom: toDateOnly(input.effectiveFrom ?? tenantToday()),
      active: input.active ?? true,
    },
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'TAX_RATE',
    entityId: row.id,
    action: 'CREATE',
    actorId: auth.userId,
    after: serializeTaxRate(row),
  });

  return { taxRate: serializeTaxRate(row) };
}

export async function updateTaxRate(auth: AuthContext, id: string, input: z.infer<typeof taxRateUpdateSchema>) {
  const before = await prisma.taxRate.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw notFound('Tax rate not found');

  if (input.name && input.name !== before.name) {
    const dupe = await prisma.taxRate.findFirst({
      where: { tenantId: auth.tenantId, name: input.name, id: { not: id } },
      select: { id: true },
    });
    if (dupe) throw conflict(`A tax rate named "${input.name}" already exists`, 'TAX_RATE_DUPLICATE');
  }

  const updated = await prisma.taxRate.update({
    where: { id },
    data: {
      name: input.name ?? undefined,
      gstPct: input.gstPct ? input.gstPct.toFixed(4) : undefined,
      cessPct: input.cessPct ? input.cessPct.toFixed(4) : undefined,
      effectiveFrom: input.effectiveFrom ? toDateOnly(input.effectiveFrom) : undefined,
      active: input.active ?? undefined,
    },
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'TAX_RATE',
    entityId: id,
    action: 'UPDATE',
    actorId: auth.userId,
    before: serializeTaxRate(before),
    after: serializeTaxRate(updated),
  });

  return { taxRate: serializeTaxRate(updated) };
}

export async function deleteTaxRate(auth: AuthContext, id: string) {
  const before = await prisma.taxRate.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw notFound('Tax rate not found');

  const [hsn, products] = await Promise.all([
    prisma.hsnSacCode.count({ where: { tenantId: auth.tenantId, defaultTaxRateId: id } }),
    prisma.product.count({ where: { tenantId: auth.tenantId, taxRateId: id } }),
  ]);
  // FR-108 — "historical documents retain the rate that applied at their date": a
  // referenced rate is deactivated, never removed (BR-11).
  if (hsn + products > 0) {
    throw new AppError(
      `This tax rate is referenced by ${hsn} HSN/SAC code(s) and ${products} product(s) and cannot be deleted. Deactivate it instead.`,
      409,
      'TAX_RATE_IN_USE',
      { deactivate: { method: 'PUT', path: `/api/setup/tax-rates/${id}`, body: { active: false } } },
    );
  }

  await prisma.taxRate.delete({ where: { id } });
  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'TAX_RATE',
    entityId: id,
    action: 'DELETE',
    actorId: auth.userId,
    before: serializeTaxRate(before),
  });
  return { deleted: true, id };
}

/**
 * FR-108 — "When supplier branch state code equals customer place-of-supply state
 * code, tax splits into CGST = SGST = GST%/2; otherwise the full GST% is charged
 * as IGST." Uses the same engine primitives every document uses.
 */
export function taxSplit(input: z.infer<typeof taxSplitQuerySchema>) {
  if (!isValidStateCode(input.supplierState)) {
    throw unprocessable(`Unknown GST state code "${input.supplierState}"`, 'STATE_CODE');
  }
  if (!isValidStateCode(input.placeOfSupply)) {
    throw unprocessable(`Unknown GST state code "${input.placeOfSupply}"`, 'STATE_CODE');
  }

  const { isInterstate } = resolveGstTreatment(input.supplierState, input.placeOfSupply);
  const taxable = round2(input.taxableValue ?? D(100));
  const parts = splitTax(taxable, input.gstPct, isInterstate);
  const cess = round2(taxable.times(input.cessPct ?? D(0)).dividedBy(100));
  const total = round2(parts.cgst.plus(parts.sgst).plus(parts.igst).plus(cess));

  return {
    split: {
      supplierState: input.supplierState,
      supplierStateName: stateName(input.supplierState),
      placeOfSupply: input.placeOfSupply,
      placeOfSupplyName: stateName(input.placeOfSupply),
      isInterstate,
      treatment: isInterstate ? 'IGST' : 'CGST_SGST',
      gstPct: rate(input.gstPct),
      cessPct: rate(input.cessPct ?? D(0)),
      taxableValue: money(taxable),
      cgstPct: isInterstate ? rate(0) : rate(input.gstPct.dividedBy(2)),
      sgstPct: isInterstate ? rate(0) : rate(input.gstPct.dividedBy(2)),
      igstPct: isInterstate ? rate(input.gstPct) : rate(0),
      cgst: money(parts.cgst),
      sgst: money(parts.sgst),
      igst: money(parts.igst),
      cess: money(cess),
      totalTax: money(total),
      invoiceTotal: money(taxable.plus(total)),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-109 / FR-117 — HSN & SAC codes
// ─────────────────────────────────────────────────────────────────────────────

type HsnRow = Prisma.HsnSacCodeGetPayload<{ include: { defaultTaxRate: true; defaultUom: true } }>;

function serializeHsn(h: HsnRow) {
  return {
    id: h.id,
    code: h.code,
    type: h.type,
    description: h.description,
    defaultTaxRateId: h.defaultTaxRateId,
    defaultTaxPct: h.defaultTaxRate ? m4(h.defaultTaxRate.gstPct) : null,
    defaultUomId: h.defaultUomId,
    defaultUomCode: h.defaultUom?.uomCode ?? null,
    active: h.active,
    createdAt: iso(h.createdAt),
    updatedAt: iso(h.updatedAt),
  };
}

/** FR-109 — "HSN codes are numeric (typically 4/6/8 digits) and SAC 6 digits". */
function assertHsnFormat(type: 'HSN' | 'SAC', code: string): void {
  if (!/^[0-9]+$/.test(code)) {
    throw unprocessable(`${type} codes are numeric — "${code}" contains non-digits`, 'HSN_FORMAT');
  }
  if (type === 'HSN' && ![4, 6, 8].includes(code.length)) {
    throw unprocessable(`An HSN code must be 4, 6 or 8 digits — "${code}" is ${code.length}`, 'HSN_FORMAT');
  }
  if (type === 'SAC' && code.length !== 6) {
    throw unprocessable(`A SAC code must be exactly 6 digits — "${code}" is ${code.length}`, 'SAC_FORMAT');
  }
}

async function assertHsnRefs(tenantId: string, taxRateId?: string | null, uomId?: string | null): Promise<void> {
  if (taxRateId) {
    const row = await prisma.taxRate.findFirst({ where: { id: taxRateId, tenantId }, select: { id: true } });
    if (!row) throw notFound('Default tax rate not found');
  }
  if (uomId) {
    const row = await prisma.unitOfMeasure.findFirst({ where: { id: uomId, tenantId }, select: { id: true } });
    if (!row) throw notFound('Default UOM not found');
  }
}

export async function listHsnCodes(auth: AuthContext, opts: { includeInactive?: boolean; type?: string; q?: string }) {
  const where: Prisma.HsnSacCodeWhereInput = { tenantId: auth.tenantId };
  // FR-117 — "Deactivating a code hides it from new selection but preserves it on historical records."
  if (!opts.includeInactive) where.active = true;
  if (opts.type) where.type = opts.type as 'HSN' | 'SAC';
  if (opts.q) {
    where.OR = [
      { code: { contains: opts.q, mode: 'insensitive' } },
      { description: { contains: opts.q, mode: 'insensitive' } },
    ];
  }

  const rows = await prisma.hsnSacCode.findMany({
    where,
    include: { defaultTaxRate: true, defaultUom: true },
    orderBy: { code: 'asc' },
  });
  return { hsnCodes: rows.map(serializeHsn) };
}

export async function createHsnCode(auth: AuthContext, input: z.infer<typeof hsnCreateSchema>) {
  assertHsnFormat(input.type, input.code);
  await assertHsnRefs(auth.tenantId, input.defaultTaxRateId, input.defaultUomId);

  const dupe = await prisma.hsnSacCode.findFirst({
    where: { tenantId: auth.tenantId, code: input.code },
    select: { id: true },
  });
  if (dupe) throw conflict(`Code ${input.code} already exists`, 'HSN_DUPLICATE');

  const row = await prisma.hsnSacCode.create({
    data: {
      tenantId: auth.tenantId,
      code: input.code,
      type: input.type,
      description: input.description ?? null,
      defaultTaxRateId: input.defaultTaxRateId ?? null,
      defaultUomId: input.defaultUomId ?? null,
      active: input.active ?? true,
    },
    include: { defaultTaxRate: true, defaultUom: true },
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'HSN_SAC',
    entityId: row.id,
    action: 'CREATE',
    actorId: auth.userId,
    after: serializeHsn(row),
  });

  return { hsnCode: serializeHsn(row) };
}

export async function updateHsnCode(auth: AuthContext, id: string, input: z.infer<typeof hsnUpdateSchema>) {
  const before = await prisma.hsnSacCode.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { defaultTaxRate: true, defaultUom: true },
  });
  if (!before) throw notFound('HSN/SAC code not found');

  const type = input.type ?? before.type;
  const code = input.code ?? before.code;
  assertHsnFormat(type, code);
  await assertHsnRefs(auth.tenantId, input.defaultTaxRateId, input.defaultUomId);

  if (code !== before.code) {
    const dupe = await prisma.hsnSacCode.findFirst({
      where: { tenantId: auth.tenantId, code, id: { not: id } },
      select: { id: true },
    });
    if (dupe) throw conflict(`Code ${code} already exists`, 'HSN_DUPLICATE');
  }

  const updated = await prisma.hsnSacCode.update({
    where: { id },
    data: {
      code,
      type,
      description: input.description !== undefined ? input.description || null : undefined,
      defaultTaxRateId: input.defaultTaxRateId !== undefined ? input.defaultTaxRateId || null : undefined,
      defaultUomId: input.defaultUomId !== undefined ? input.defaultUomId || null : undefined,
      active: input.active ?? undefined,
    },
    include: { defaultTaxRate: true, defaultUom: true },
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'HSN_SAC',
    entityId: id,
    action: 'UPDATE',
    actorId: auth.userId,
    before: serializeHsn(before),
    after: serializeHsn(updated),
  });

  return { hsnCode: serializeHsn(updated) };
}

export async function deleteHsnCode(auth: AuthContext, id: string) {
  const before = await prisma.hsnSacCode.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { defaultTaxRate: true, defaultUom: true },
  });
  if (!before) throw notFound('HSN/SAC code not found');

  const [products, materials] = await Promise.all([
    prisma.product.count({ where: { tenantId: auth.tenantId, hsnSacId: id } }),
    prisma.materialItem.count({ where: { tenantId: auth.tenantId, hsnSacId: id } }),
  ]);
  if (products + materials > 0) {
    throw new AppError(
      `This code is used by ${products} product(s) and ${materials} material(s) and cannot be deleted. Deactivate it — it will disappear from pickers but stay on past documents.`,
      409,
      'HSN_IN_USE',
      { deactivate: { method: 'PUT', path: `/api/setup/hsn-codes/${id}`, body: { active: false } } },
    );
  }

  await prisma.hsnSacCode.delete({ where: { id } });
  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'HSN_SAC',
    entityId: id,
    action: 'DELETE',
    actorId: auth.userId,
    before: serializeHsn(before),
  });
  return { deleted: true, id };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-110 — units of measure
// ─────────────────────────────────────────────────────────────────────────────

type UomRow = Prisma.UnitOfMeasureGetPayload<{ include: { baseUom: true } }>;

function serializeUom(u: UomRow) {
  return {
    id: u.id,
    uomCode: u.uomCode,
    name: u.name,
    symbol: u.symbol,
    baseUomId: u.baseUomId,
    baseUomCode: u.baseUom?.uomCode ?? null,
    factorToBase: D(str(u.factorToBase)).toFixed(6),
    active: u.active,
    createdAt: iso(u.createdAt),
    updatedAt: iso(u.updatedAt),
  };
}

async function resolveBaseUom(
  tenantId: string,
  baseUomId: string | null | undefined,
  baseUomCode: string | null | undefined,
  selfId?: string,
): Promise<string | null> {
  const target = baseUomId
    ? await prisma.unitOfMeasure.findFirst({ where: { id: baseUomId, tenantId } })
    : baseUomCode
      ? await prisma.unitOfMeasure.findFirst({ where: { uomCode: baseUomCode, tenantId } })
      : null;
  if ((baseUomId || baseUomCode) && !target) throw notFound('Base UOM not found');
  if (!target) return null;
  if (selfId && target.id === selfId) throw unprocessable('A UOM cannot be its own base unit', 'UOM_SELF_BASE');
  // FR-110 — "no multi-step conversion engine at MVP."
  if (target.baseUomId) {
    throw unprocessable(
      `Only a single-factor relationship is supported — ${target.uomCode} already converts to another unit`,
      'UOM_MULTI_STEP',
    );
  }
  return target.id;
}

export async function listUoms(auth: AuthContext, opts: { includeInactive?: boolean }) {
  const where: Prisma.UnitOfMeasureWhereInput = { tenantId: auth.tenantId };
  if (!opts.includeInactive) where.active = true;
  const rows = await prisma.unitOfMeasure.findMany({ where, include: { baseUom: true }, orderBy: { uomCode: 'asc' } });
  return { uoms: rows.map(serializeUom) };
}

export async function createUom(auth: AuthContext, input: z.infer<typeof uomCreateSchema>) {
  const dupe = await prisma.unitOfMeasure.findFirst({
    where: { tenantId: auth.tenantId, uomCode: input.uomCode },
    select: { id: true },
  });
  if (dupe) throw conflict(`UOM "${input.uomCode}" already exists`, 'UOM_DUPLICATE');

  const baseUomId = await resolveBaseUom(auth.tenantId, input.baseUomId, input.baseUomCode);

  const row = await prisma.unitOfMeasure.create({
    data: {
      tenantId: auth.tenantId,
      uomCode: input.uomCode,
      name: input.name,
      symbol: input.symbol ?? null,
      baseUomId,
      factorToBase: (input.factorToBase ?? D(1)).toFixed(6),
      active: input.active ?? true,
    },
    include: { baseUom: true },
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'UOM',
    entityId: row.id,
    action: 'CREATE',
    actorId: auth.userId,
    after: serializeUom(row),
  });

  return { uom: serializeUom(row) };
}

export async function updateUom(auth: AuthContext, id: string, input: z.infer<typeof uomUpdateSchema>) {
  const before = await prisma.unitOfMeasure.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { baseUom: true },
  });
  if (!before) throw notFound('UOM not found');

  if (input.uomCode && input.uomCode !== before.uomCode) {
    const dupe = await prisma.unitOfMeasure.findFirst({
      where: { tenantId: auth.tenantId, uomCode: input.uomCode, id: { not: id } },
      select: { id: true },
    });
    if (dupe) throw conflict(`UOM "${input.uomCode}" already exists`, 'UOM_DUPLICATE');
  }

  const baseUomId =
    input.baseUomId !== undefined || input.baseUomCode !== undefined
      ? await resolveBaseUom(auth.tenantId, input.baseUomId, input.baseUomCode, id)
      : undefined;

  const updated = await prisma.unitOfMeasure.update({
    where: { id },
    data: {
      uomCode: input.uomCode ?? undefined,
      name: input.name ?? undefined,
      symbol: input.symbol !== undefined ? input.symbol || null : undefined,
      baseUomId,
      factorToBase: input.factorToBase ? input.factorToBase.toFixed(6) : undefined,
      active: input.active ?? undefined,
    },
    include: { baseUom: true },
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'UOM',
    entityId: id,
    action: 'UPDATE',
    actorId: auth.userId,
    before: serializeUom(before),
    after: serializeUom(updated),
  });

  return { uom: serializeUom(updated) };
}

export async function deleteUom(auth: AuthContext, id: string) {
  const before = await prisma.unitOfMeasure.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { baseUom: true },
  });
  if (!before) throw notFound('UOM not found');

  // FR-110 — "A UOM referenced by any product/item cannot be deleted, only deactivated."
  const [products, materials, rateCards, hsnDefaults, derived] = await Promise.all([
    prisma.product.count({ where: { tenantId: auth.tenantId, defaultUomId: id } }),
    prisma.materialItem.count({ where: { tenantId: auth.tenantId, uomId: id } }),
    prisma.rateCard.count({ where: { tenantId: auth.tenantId, uomId: id } }),
    prisma.hsnSacCode.count({ where: { tenantId: auth.tenantId, defaultUomId: id } }),
    prisma.unitOfMeasure.count({ where: { tenantId: auth.tenantId, baseUomId: id } }),
  ]);
  const refs = products + materials + rateCards + hsnDefaults + derived;
  if (refs > 0) {
    throw new AppError(
      `${before.uomCode} is referenced by ${products} product(s), ${materials} material(s), ${rateCards} rate card(s), ${hsnDefaults} HSN default(s) and ${derived} derived UOM(s). It cannot be deleted — deactivate it instead.`,
      409,
      'UOM_IN_USE',
      {
        references: { products, materials, rateCards, hsnDefaults, derived },
        deactivate: { method: 'PUT', path: `/api/setup/uoms/${id}`, body: { active: false } },
      },
    );
  }

  await prisma.unitOfMeasure.delete({ where: { id } });
  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'UOM',
    entityId: id,
    action: 'DELETE',
    actorId: auth.userId,
    before: serializeUom(before),
  });
  return { deleted: true, id };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-111 — reusable terms & notes blocks
// ─────────────────────────────────────────────────────────────────────────────

type TermsRow = Prisma.TermsBlockGetPayload<Record<string, never>>;

function serializeTerms(t: TermsRow) {
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    appliesTo: t.appliesTo,
    isDefault: t.isDefault,
    sortOrder: t.sortOrder,
    active: t.active,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

export async function listTermsBlocks(
  auth: AuthContext,
  opts: { includeInactive?: boolean; docType?: string; defaultsOnly?: boolean },
) {
  const where: Prisma.TermsBlockWhereInput = { tenantId: auth.tenantId };
  if (!opts.includeInactive) where.active = true;
  if (opts.docType) where.appliesTo = { has: opts.docType as DocType };
  if (opts.defaultsOnly) where.isDefault = true;

  // FR-111 — "ordering is preserved when more than one applies."
  const rows = await prisma.termsBlock.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  return { termsBlocks: rows.map(serializeTerms) };
}

export async function createTermsBlock(auth: AuthContext, input: z.infer<typeof termsCreateSchema>) {
  const row = await prisma.termsBlock.create({
    data: {
      tenantId: auth.tenantId,
      title: input.title,
      body: input.body,
      appliesTo: (input.appliesTo ?? []) as DocType[],
      isDefault: input.isDefault ?? false,
      sortOrder: input.sortOrder ?? 0,
      active: input.active ?? true,
    },
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'TERMS_BLOCK',
    entityId: row.id,
    action: 'CREATE',
    actorId: auth.userId,
    after: serializeTerms(row),
  });

  return { termsBlock: serializeTerms(row) };
}

export async function updateTermsBlock(auth: AuthContext, id: string, input: z.infer<typeof termsUpdateSchema>) {
  const before = await prisma.termsBlock.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw notFound('Terms block not found');

  const updated = await prisma.termsBlock.update({
    where: { id },
    data: {
      title: input.title ?? undefined,
      body: input.body ?? undefined,
      appliesTo: input.appliesTo ? { set: input.appliesTo as DocType[] } : undefined,
      isDefault: input.isDefault ?? undefined,
      sortOrder: input.sortOrder ?? undefined,
      active: input.active ?? undefined,
    },
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'TERMS_BLOCK',
    entityId: id,
    action: 'UPDATE',
    actorId: auth.userId,
    before: serializeTerms(before),
    after: serializeTerms(updated),
  });

  return { termsBlock: serializeTerms(updated) };
}

export async function deleteTermsBlock(auth: AuthContext, id: string) {
  const before = await prisma.termsBlock.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!before) throw notFound('Terms block not found');

  await prisma.termsBlock.delete({ where: { id } });
  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'TERMS_BLOCK',
    entityId: id,
    action: 'DELETE',
    actorId: auth.userId,
    before: serializeTerms(before),
  });
  return { deleted: true, id };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-112 — rounding rules
// ─────────────────────────────────────────────────────────────────────────────

type RoundingRow = Prisma.RoundingRuleGetPayload<Record<string, never>>;

function serializeRounding(r: RoundingRow) {
  return {
    id: r.id,
    /** null scope = the tenant-wide default applied to every document type. */
    scope: r.scope,
    mode: r.mode,
    precision: r.precision,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export async function listRoundingRules(auth: AuthContext) {
  const rows = await prisma.roundingRule.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: [{ scope: 'asc' }],
  });
  return { roundingRules: rows.map(serializeRounding) };
}

export async function upsertRoundingRules(auth: AuthContext, rules: RoundingRuleInput[]) {
  for (const rule of rules) {
    const scope = (rule.scope ?? null) as DocType | null;
    const existing = await prisma.roundingRule.findFirst({ where: { tenantId: auth.tenantId, scope } });
    if (existing) {
      const updated = await prisma.roundingRule.update({
        where: { id: existing.id },
        data: { mode: rule.mode, precision: rule.precision },
      });
      await recordAudit({
        tenantId: auth.tenantId,
        entityType: 'ROUNDING_RULE',
        entityId: updated.id,
        action: 'UPDATE',
        actorId: auth.userId,
        before: serializeRounding(existing),
        after: serializeRounding(updated),
      });
    } else {
      const created = await prisma.roundingRule.create({
        data: { tenantId: auth.tenantId, scope, mode: rule.mode, precision: rule.precision },
      });
      await recordAudit({
        tenantId: auth.tenantId,
        entityType: 'ROUNDING_RULE',
        entityId: created.id,
        action: 'CREATE',
        actorId: auth.userId,
        after: serializeRounding(created),
      });
    }
  }
  return listRoundingRules(auth);
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-119 / FR-715 / FR-725 — users
// ─────────────────────────────────────────────────────────────────────────────

type UserRow = Prisma.UserGetPayload<{ include: { branches: true } }>;

export function serializeUser(u: UserRow) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    status: u.status,
    allBranches: u.allBranches,
    branchIds: u.branches.map((b) => b.branchId),
    hasPassword: !!u.passwordHash,
    lastLoginAt: iso(u.lastLoginAt),
    createdAt: iso(u.createdAt),
    updatedAt: iso(u.updatedAt),
  };
}

async function assertBranchesBelongToTenant(tenantId: string, branchIds: string[], client: Prisma.TransactionClient) {
  if (branchIds.length === 0) return;
  const found = await client.branch.count({ where: { tenantId, id: { in: branchIds } } });
  if (found !== new Set(branchIds).size) throw notFound('One or more branches do not exist in this tenant');
}

export async function listUsers(auth: AuthContext, opts: { status?: string; role?: string }) {
  const where: Prisma.UserWhereInput = { tenantId: auth.tenantId };
  if (opts.status) where.status = opts.status as 'INVITED' | 'ACTIVE' | 'DISABLED';
  if (opts.role) where.role = opts.role as UserRole;

  const rows = await prisma.user.findMany({ where, include: { branches: true }, orderBy: { createdAt: 'asc' } });
  const usage = await loadPlanUsage(auth.tenantId);
  return {
    users: rows.map(serializeUser),
    // FR-722 — "Given a plan with 5 seats, when a 5th active user exists, then seat usage shows 5/5."
    seatUsage: { used: usage.activeUsers, max: usage.maxUsers, plan: usage.planName },
  };
}

export async function getUser(auth: AuthContext, id: string) {
  const row = await prisma.user.findFirst({ where: { id, tenantId: auth.tenantId }, include: { branches: true } });
  if (!row) throw notFound('User not found');
  return { user: serializeUser(row) };
}

export async function createUser(auth: AuthContext, input: z.infer<typeof userCreateSchema>) {
  const branchIds = input.branchIds ?? [];
  const status = input.status ?? (input.password ? 'ACTIVE' : 'INVITED');

  const user = await prisma.$transaction(async (tx) => {
    // FR-725 — "Given seats are fully used, when Owner/Admin invites another user, then the invite is blocked".
    if (status !== 'DISABLED') await assertSeatAvailable(auth.tenantId, tx);

    // FR-119 — "Email is unique within the tenant and is the login identifier."
    const dupe = await tx.user.findFirst({
      where: { tenantId: auth.tenantId, email: input.email },
      select: { id: true },
    });
    if (dupe) throw conflict(`A user with the email ${input.email} already exists`, 'USER_EMAIL_DUPLICATE');

    await assertBranchesBelongToTenant(auth.tenantId, branchIds, tx);

    return tx.user.create({
      data: {
        tenantId: auth.tenantId,
        name: input.name,
        email: input.email,
        phone: input.phone ?? null,
        role: input.role as UserRole,
        status,
        allBranches: input.allBranches ?? input.role === 'OWNER_ADMIN',
        passwordHash: input.password ? await bcrypt.hash(input.password, BCRYPT_ROUNDS) : null,
        branches: { create: branchIds.map((branchId) => ({ branchId })) },
      },
      include: { branches: true },
    });
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'USER',
    entityId: user.id,
    action: 'CREATE',
    actorId: auth.userId,
    after: serializeUser(user),
  });

  return { user: serializeUser(user) };
}

export async function updateUser(auth: AuthContext, id: string, input: z.infer<typeof userUpdateSchema>) {
  const before = await prisma.user.findFirst({ where: { id, tenantId: auth.tenantId }, include: { branches: true } });
  if (!before) throw notFound('User not found');

  const updated = await prisma.$transaction(async (tx) => {
    // FR-725 — re-enabling a user re-consumes a seat.
    if (input.status && input.status !== 'DISABLED' && before.status === 'DISABLED') {
      await assertSeatAvailable(auth.tenantId, tx);
    }

    // FR-715 — the tenant must always keep at least one usable Owner/Admin.
    const losingOwner =
      before.role === 'OWNER_ADMIN' &&
      ((input.role && input.role !== 'OWNER_ADMIN') || input.status === 'DISABLED');
    if (losingOwner) {
      const others = await tx.user.count({
        where: { tenantId: auth.tenantId, role: 'OWNER_ADMIN', status: { not: 'DISABLED' }, id: { not: id } },
      });
      if (others === 0) {
        throw conflict('The tenant must keep at least one active Owner/Admin', 'LAST_OWNER_ADMIN');
      }
    }

    if (input.branchIds) {
      await assertBranchesBelongToTenant(auth.tenantId, input.branchIds, tx);
      await tx.userBranch.deleteMany({ where: { userId: id } });
      if (input.branchIds.length > 0) {
        await tx.userBranch.createMany({ data: input.branchIds.map((branchId) => ({ userId: id, branchId })) });
      }
    }

    return tx.user.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        phone: input.phone !== undefined ? input.phone || null : undefined,
        role: (input.role as UserRole | undefined) ?? undefined,
        status: input.status ?? undefined,
        allBranches: input.allBranches ?? undefined,
        passwordHash: input.password ? await bcrypt.hash(input.password, BCRYPT_ROUNDS) : undefined,
      },
      include: { branches: true },
    });
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'USER',
    entityId: id,
    action: 'UPDATE',
    actorId: auth.userId,
    before: serializeUser(before),
    after: serializeUser(updated),
  });

  return { user: serializeUser(updated) };
}

export async function deleteUser(auth: AuthContext, id: string) {
  const before = await prisma.user.findFirst({ where: { id, tenantId: auth.tenantId }, include: { branches: true } });
  if (!before) throw notFound('User not found');
  if (before.id === auth.userId) throw conflict('You cannot delete your own account', 'SELF_DELETE');

  if (before.role === 'OWNER_ADMIN') {
    const others = await prisma.user.count({
      where: { tenantId: auth.tenantId, role: 'OWNER_ADMIN', status: { not: 'DISABLED' }, id: { not: id } },
    });
    if (others === 0) throw conflict('The tenant must keep at least one active Owner/Admin', 'LAST_OWNER_ADMIN');
  }

  // FR-119 — "A user cannot be hard-deleted if they have authored records; they are disabled instead."
  const [enquiries, followUps, auditLogs, stages, jobEvents, quotes, jobcards, approvals] = await Promise.all([
    prisma.enquiry.count({ where: { tenantId: auth.tenantId, assignedTo: id } }),
    prisma.followUp.count({ where: { tenantId: auth.tenantId, assignedTo: id } }),
    prisma.auditLog.count({ where: { tenantId: auth.tenantId, actorId: id } }),
    prisma.jobStageProgress.count({ where: { tenantId: auth.tenantId, assignedOperatorId: id } }),
    prisma.jobEvent.count({ where: { tenantId: auth.tenantId, actorId: id } }),
    prisma.quote.count({ where: { tenantId: auth.tenantId, createdBy: id } }),
    prisma.jobcard.count({ where: { tenantId: auth.tenantId, createdBy: id } }),
    prisma.quote.count({ where: { tenantId: auth.tenantId, approvedBy: id } }),
  ]);
  const authored = enquiries + followUps + auditLogs + stages + jobEvents + quotes + jobcards + approvals;
  if (authored > 0) {
    throw new AppError(
      `${before.name} has authored ${authored} record(s) and cannot be deleted. Disable the account instead — access is revoked immediately and their history stays intact.`,
      409,
      'USER_HAS_HISTORY',
      {
        references: { enquiries, followUps, auditLogs, stages, jobEvents, quotes, jobcards, approvals },
        disable: { method: 'PUT', path: `/api/setup/users/${id}`, body: { status: 'DISABLED' } },
      },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.userBranch.deleteMany({ where: { userId: id } });
    await tx.user.delete({ where: { id } });
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'USER',
    entityId: id,
    action: 'DELETE',
    actorId: auth.userId,
    before: serializeUser(before),
  });

  return { deleted: true, id };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-722 / FR-724 / FR-725 — subscription
// ─────────────────────────────────────────────────────────────────────────────

export async function getSubscription(auth: AuthContext) {
  const usage = await loadPlanUsage(auth.tenantId);
  const trial = trialState(usage);
  const plans = await prisma.plan.findMany({ where: { active: true }, orderBy: { maxUsers: 'asc' } });

  return {
    subscription: {
      id: usage.subscriptionId,
      status: usage.status,
      seats: usage.seats,
      trialEndsAt: iso(usage.trialEndsAt),
      trialDaysRemaining: trial.daysRemaining,
      /** FR-723 — an expired trial restricts access; the tenant's data is retained. */
      restricted: trial.expired,
      periodStart: iso(usage.periodStart),
      periodEnd: iso(usage.periodEnd),
      plan: usage.planId
        ? { id: usage.planId, code: usage.planCode, name: usage.planName, maxUsers: usage.maxUsers, maxBranches: usage.maxBranches, features: usage.features }
        : null,
    },
    usage: {
      users: { used: usage.activeUsers, max: usage.maxUsers },
      branches: { used: usage.activeBranches, max: usage.maxBranches },
    },
    plans: plans.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      maxUsers: p.maxUsers,
      maxBranches: p.maxBranches,
      features: p.features,
      pricePerYear: m2(p.pricePerYear),
      current: p.id === usage.planId,
    })),
  };
}

/** FR-724 — upgrades apply immediately; downgrades are blocked while usage exceeds the target plan. */
export async function changePlan(auth: AuthContext, input: z.infer<typeof planChangeSchema>) {
  const usage = await loadPlanUsage(auth.tenantId);
  if (!usage.subscriptionId) throw notFound('This tenant has no subscription on file');

  let target = await prisma.plan.findUnique({ where: { code: input.planCode } });
  if (!target) {
    const catalogue = planCatalogEntry(input.planCode);
    if (!catalogue) {
      throw notFound(`Unknown plan "${input.planCode}". Available: ${DEFAULT_PLANS.map((p) => p.code).join(', ')}`);
    }
    target = await prisma.plan.create({
      data: {
        code: catalogue.code,
        name: catalogue.name,
        maxUsers: catalogue.maxUsers,
        maxBranches: catalogue.maxBranches,
        features: catalogue.features,
        pricePerYear: catalogue.pricePerYear,
        active: true,
      },
    });
  }

  const reduce: Array<{ resource: string; used: number; max: number; reduceBy: number }> = [];
  if (usage.activeUsers > target.maxUsers) {
    reduce.push({
      resource: 'users',
      used: usage.activeUsers,
      max: target.maxUsers,
      reduceBy: usage.activeUsers - target.maxUsers,
    });
  }
  if (usage.activeBranches > target.maxBranches) {
    reduce.push({
      resource: 'branches',
      used: usage.activeBranches,
      max: target.maxBranches,
      reduceBy: usage.activeBranches - target.maxBranches,
    });
  }
  if (reduce.length > 0) {
    const detail = reduce
      .map((r) => {
        const noun = r.resource === 'users' ? 'user' : 'branch';
        const plural = r.reduceBy === 1 ? noun : r.resource === 'users' ? 'users' : 'branches';
        return `deactivate ${r.reduceBy} ${plural}`;
      })
      .join(' and ');
    throw new AppError(
      `${target.name} allows ${target.maxUsers} users and ${target.maxBranches} branches — ${detail} first.`,
      409,
      'DOWNGRADE_BLOCKED',
      { reduce },
    );
  }

  const seats = Math.min(input.seats ?? target.maxUsers, target.maxUsers);
  const now = new Date();
  const paid = D(str(target.pricePerYear)).greaterThan(0);

  const updated = await prisma.subscription.update({
    where: { tenantId: auth.tenantId },
    data: {
      planId: target.id,
      seats,
      // Upgrading onto a paid tier settles the trial and opens a period immediately.
      status: paid ? 'ACTIVE' : undefined,
      periodStart: paid ? now : undefined,
      periodEnd: paid ? new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate())) : undefined,
    },
    include: { plan: true },
  });

  await recordAudit({
    tenantId: auth.tenantId,
    entityType: 'SUBSCRIPTION',
    entityId: updated.id,
    action: 'UPDATE',
    actorId: auth.userId,
    before: { planCode: usage.planCode, seats: usage.seats, status: usage.status },
    after: { planCode: updated.plan.code, seats: updated.seats, status: updated.status },
  });

  return getSubscription(auth);
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-718 — audit log (read-only, append-only, Owner/Admin)
// ─────────────────────────────────────────────────────────────────────────────

export async function listAuditLog(auth: AuthContext, query: z.infer<typeof auditQuerySchema>) {
  const where: Prisma.AuditLogWhereInput = { tenantId: auth.tenantId };
  if (query.entityType) where.entityType = query.entityType;
  if (query.entityId) where.entityId = query.entityId;
  if (query.action) where.action = query.action;
  if (query.actorId) where.actorId = query.actorId;
  if (query.branchId) where.branchId = query.branchId;
  if (query.actor) {
    where.actor = {
      OR: [
        { name: { contains: query.actor, mode: 'insensitive' } },
        { email: { contains: query.actor, mode: 'insensitive' } },
      ],
    };
  }
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: query.from } : {}),
      ...(query.to ? { lte: query.to } : {}),
    };
  }
  // FR-717 — a branch-scoped viewer only sees their branches' entries.
  if (!auth.allBranches && auth.branchIds.length > 0) {
    where.OR = [{ branchId: { in: auth.branchIds } }, { branchId: null }];
  }

  const take = query.limit ?? 100;
  const skip = query.offset ?? 0;

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { id: true, name: true, email: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    entries: rows.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      action: r.action,
      branchId: r.branchId,
      actor: r.actor ? { id: r.actor.id, name: r.actor.name, email: r.actor.email, role: r.actor.role } : null,
      before: r.before,
      after: r.after,
      createdAt: iso(r.createdAt),
    })),
    total,
    limit: take,
    offset: skip,
    /** FR-718 — entries can never be edited or removed through the API. */
    readOnly: true,
  };
}
