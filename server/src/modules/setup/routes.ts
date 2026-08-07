/**
 * Setup & configuration routes — FRD §3 (FR-100 … FR-119), §9.4 (FR-715 …
 * FR-718) and §9.6 (FR-722 … FR-725).
 *
 * Mounted at `/api`, so every path below is prefixed `/setup`. Each route is
 * gated by `requirePermission` (FR-716 deny-by-default) and every service call
 * is tenant-scoped through `requireAuth` (BR-4).
 */
import { Router } from 'express';
import type { Request } from 'express';
import { asyncHandler } from '../../http/errors.js';
import { requireAuth, requirePermission, requireRole } from '../../auth/middleware.js';
import {
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
  roundingUpsertSchema,
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
import * as svc from './service.js';

export const setupRouter = Router();

/** Query params arrive as `string | string[] | ParsedQs`; only plain strings are meaningful here. */
function q(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
function qbool(value: unknown): boolean | undefined {
  const raw = q(value)?.toLowerCase();
  if (raw === undefined) return undefined;
  return raw === 'true' || raw === '1' || raw === 'yes';
}
function param(req: Request, name: string): string {
  return String(req.params[name] ?? '');
}

/**
 * Canonical response envelope.
 *
 * Every other module (masters, crm, quotes, production) and the web client agree on
 * `{ data: <payload>, ...metadata }` — the client reads `res.data` / `res.data.data`
 * throughout. The setup services name their payload key after the entity instead
 * (`{ branches: [...] }`), so rename that one key here and let any sibling metadata
 * (seat usage, totals, derived firm) ride alongside. `keyof T` makes a wrong key a
 * compile error rather than a silently undefined body.
 */
function envelope<T extends object, K extends keyof T>(result: T, key: K): Omit<T, K> & { data: T[K] } {
  const { [key]: payload, ...rest } = result;
  return { ...(rest as Omit<T, K>), data: payload };
}

/** For action/computed results that have no single payload key — wrap the whole thing. */
function wrap<T>(result: T): { data: T } {
  return { data: result };
}

// ── FR-100 · first-run setup wizard ──────────────────────────────────────────

setupRouter.get(
  '/setup/wizard',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.getWizard(requireAuth(req)), 'wizard'));
  }),
);

setupRouter.put(
  '/setup/wizard',
  requirePermission('setup', 'U'),
  asyncHandler(async (req, res) => {
    const body = wizardUpdateSchema.parse(req.body ?? {});
    res.json(envelope(await svc.updateWizard(requireAuth(req), body), 'wizard'));
  }),
);

// ── FR-101 · firm profile & branding ─────────────────────────────────────────

setupRouter.get(
  '/setup/firm',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.getFirm(requireAuth(req)), 'firm'));
  }),
);

setupRouter.put(
  '/setup/firm',
  requirePermission('setup', 'U'),
  asyncHandler(async (req, res) => {
    const body = firmUpdateSchema.parse(req.body ?? {});
    res.json(envelope(await svc.updateFirm(requireAuth(req), body), 'firm'));
  }),
);

// ── FR-103 / FR-118 · branches ───────────────────────────────────────────────

setupRouter.get(
  '/setup/branches',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.listBranches(requireAuth(req), { includeInactive: qbool(req.query.includeInactive) }), 'branches'));
  }),
);

setupRouter.get(
  '/setup/branches/:id',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.getBranch(requireAuth(req), param(req, 'id')), 'branch'));
  }),
);

setupRouter.post(
  '/setup/branches',
  requirePermission('setup', 'C'),
  asyncHandler(async (req, res) => {
    const body = branchCreateSchema.parse(req.body ?? {});
    res.status(201).json(envelope(await svc.createBranch(requireAuth(req), body), 'branch'));
  }),
);

setupRouter.put(
  '/setup/branches/:id',
  requirePermission('setup', 'U'),
  asyncHandler(async (req, res) => {
    const body = branchUpdateSchema.parse(req.body ?? {});
    res.json(envelope(await svc.updateBranch(requireAuth(req), param(req, 'id'), body), 'branch'));
  }),
);

setupRouter.delete(
  '/setup/branches/:id',
  requirePermission('setup', 'D'),
  asyncHandler(async (req, res) => {
    res.json(wrap(await svc.deleteBranch(requireAuth(req), param(req, 'id'))));
  }),
);

// ── FR-102 · bank accounts ───────────────────────────────────────────────────

setupRouter.get(
  '/setup/bank-accounts',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.listBankAccounts(requireAuth(req), { includeInactive: qbool(req.query.includeInactive) }), 'bankAccounts'));
  }),
);

setupRouter.get(
  '/setup/bank-accounts/:id',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.getBankAccount(requireAuth(req), param(req, 'id')), 'bankAccount'));
  }),
);

setupRouter.post(
  '/setup/bank-accounts',
  requirePermission('setup', 'C'),
  asyncHandler(async (req, res) => {
    const body = bankAccountCreateSchema.parse(req.body ?? {});
    res.status(201).json(envelope(await svc.createBankAccount(requireAuth(req), body), 'bankAccount'));
  }),
);

setupRouter.put(
  '/setup/bank-accounts/:id',
  requirePermission('setup', 'U'),
  asyncHandler(async (req, res) => {
    const body = bankAccountUpdateSchema.parse(req.body ?? {});
    res.json(envelope(await svc.updateBankAccount(requireAuth(req), param(req, 'id'), body), 'bankAccount'));
  }),
);

setupRouter.delete(
  '/setup/bank-accounts/:id',
  requirePermission('setup', 'D'),
  asyncHandler(async (req, res) => {
    res.json(wrap(await svc.deleteBankAccount(requireAuth(req), param(req, 'id'))));
  }),
);

// ── FR-104 / FR-105 · financial years ────────────────────────────────────────

setupRouter.get(
  '/setup/financial-years',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.listFinancialYears(requireAuth(req)), 'financialYears'));
  }),
);

setupRouter.post(
  '/setup/financial-years',
  requirePermission('setup', 'C'),
  asyncHandler(async (req, res) => {
    const body = fyCreateSchema.parse(req.body ?? {});
    res.status(201).json(envelope(await svc.createFinancialYear(requireAuth(req), body), 'financialYear'));
  }),
);

setupRouter.put(
  '/setup/financial-years/:id',
  requirePermission('setup', 'U'),
  asyncHandler(async (req, res) => {
    const body = fyUpdateSchema.parse(req.body ?? {});
    res.json(envelope(await svc.updateFinancialYear(requireAuth(req), param(req, 'id'), body), 'financialYear'));
  }),
);

setupRouter.post(
  '/setup/financial-years/:id/set-current',
  requirePermission('setup', 'U'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.setCurrentFinancialYear(requireAuth(req), param(req, 'id')), 'financialYear'));
  }),
);

setupRouter.post(
  '/setup/financial-years/:id/rollover',
  requirePermission('setup', 'U'),
  asyncHandler(async (req, res) => {
    const body = fyRolloverSchema.parse(req.body ?? {});
    res.json(wrap(await svc.rolloverFinancialYear(requireAuth(req), param(req, 'id'), body)));
  }),
);

// ── FR-106 / FR-107 · numbering series ───────────────────────────────────────

setupRouter.get(
  '/setup/numbering-series',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.listSeries(requireAuth(req), {
        docType: q(req.query.docType),
        includeInactive: qbool(req.query.includeInactive),
      }), 'numberingSeries'));
  }),
);

// Registered before `/:id`-shaped siblings so "preview" is never read as an id.
setupRouter.post(
  '/setup/numbering-series/preview',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    const body = seriesPreviewSchema.parse(req.body ?? {});
    res.json(envelope(await svc.previewSeries(requireAuth(req), body), 'preview'));
  }),
);

setupRouter.post(
  '/setup/numbering-series',
  requirePermission('setup', 'C'),
  asyncHandler(async (req, res) => {
    const body = seriesCreateSchema.parse(req.body ?? {});
    res.status(201).json(envelope(await svc.createSeries(requireAuth(req), body), 'series'));
  }),
);

setupRouter.put(
  '/setup/numbering-series/:id',
  requirePermission('setup', 'U'),
  asyncHandler(async (req, res) => {
    const body = seriesUpdateSchema.parse(req.body ?? {});
    res.json(envelope(await svc.updateSeries(requireAuth(req), param(req, 'id'), body), 'series'));
  }),
);

setupRouter.delete(
  '/setup/numbering-series/:id',
  requirePermission('setup', 'D'),
  asyncHandler(async (req, res) => {
    res.json(wrap(await svc.deleteSeries(requireAuth(req), param(req, 'id'))));
  }),
);

// ── FR-108 · GST tax rates ───────────────────────────────────────────────────

setupRouter.get(
  '/setup/tax-rates',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    const onDate = q(req.query.onDate);
    res.json(envelope(await svc.listTaxRates(requireAuth(req), {
        includeInactive: qbool(req.query.includeInactive),
        onDate: onDate ? new Date(onDate) : undefined,
      }), 'taxRates'));
  }),
);

/** FR-108 — CGST/SGST vs IGST resolution, exposed for the UI's tax preview. */
setupRouter.get(
  '/setup/tax-rates/split',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    const query = taxSplitQuerySchema.parse(req.query);
    res.json(envelope(svc.taxSplit(query), 'split'));
  }),
);

setupRouter.post(
  '/setup/tax-rates',
  requirePermission('setup', 'C'),
  asyncHandler(async (req, res) => {
    const body = taxRateCreateSchema.parse(req.body ?? {});
    res.status(201).json(envelope(await svc.createTaxRate(requireAuth(req), body), 'taxRate'));
  }),
);

setupRouter.put(
  '/setup/tax-rates/:id',
  requirePermission('setup', 'U'),
  asyncHandler(async (req, res) => {
    const body = taxRateUpdateSchema.parse(req.body ?? {});
    res.json(envelope(await svc.updateTaxRate(requireAuth(req), param(req, 'id'), body), 'taxRate'));
  }),
);

setupRouter.delete(
  '/setup/tax-rates/:id',
  requirePermission('setup', 'D'),
  asyncHandler(async (req, res) => {
    res.json(wrap(await svc.deleteTaxRate(requireAuth(req), param(req, 'id'))));
  }),
);

// ── FR-109 / FR-117 · HSN & SAC codes ────────────────────────────────────────

setupRouter.get(
  '/setup/hsn-codes',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.listHsnCodes(requireAuth(req), {
        includeInactive: qbool(req.query.includeInactive),
        type: q(req.query.type)?.toUpperCase(),
        q: q(req.query.q),
      }), 'hsnCodes'));
  }),
);

setupRouter.post(
  '/setup/hsn-codes',
  requirePermission('setup', 'C'),
  asyncHandler(async (req, res) => {
    const body = hsnCreateSchema.parse(req.body ?? {});
    res.status(201).json(envelope(await svc.createHsnCode(requireAuth(req), body), 'hsnCode'));
  }),
);

setupRouter.put(
  '/setup/hsn-codes/:id',
  requirePermission('setup', 'U'),
  asyncHandler(async (req, res) => {
    const body = hsnUpdateSchema.parse(req.body ?? {});
    res.json(envelope(await svc.updateHsnCode(requireAuth(req), param(req, 'id'), body), 'hsnCode'));
  }),
);

setupRouter.delete(
  '/setup/hsn-codes/:id',
  requirePermission('setup', 'D'),
  asyncHandler(async (req, res) => {
    res.json(wrap(await svc.deleteHsnCode(requireAuth(req), param(req, 'id'))));
  }),
);

// ── FR-110 · units of measure ────────────────────────────────────────────────

setupRouter.get(
  '/setup/uoms',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.listUoms(requireAuth(req), { includeInactive: qbool(req.query.includeInactive) }), 'uoms'));
  }),
);

setupRouter.post(
  '/setup/uoms',
  requirePermission('setup', 'C'),
  asyncHandler(async (req, res) => {
    const body = uomCreateSchema.parse(req.body ?? {});
    res.status(201).json(envelope(await svc.createUom(requireAuth(req), body), 'uom'));
  }),
);

setupRouter.put(
  '/setup/uoms/:id',
  requirePermission('setup', 'U'),
  asyncHandler(async (req, res) => {
    const body = uomUpdateSchema.parse(req.body ?? {});
    res.json(envelope(await svc.updateUom(requireAuth(req), param(req, 'id'), body), 'uom'));
  }),
);

setupRouter.delete(
  '/setup/uoms/:id',
  requirePermission('setup', 'D'),
  asyncHandler(async (req, res) => {
    res.json(wrap(await svc.deleteUom(requireAuth(req), param(req, 'id'))));
  }),
);

// ── FR-111 · terms & notes blocks ────────────────────────────────────────────

setupRouter.get(
  '/setup/terms-blocks',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.listTermsBlocks(requireAuth(req), {
        includeInactive: qbool(req.query.includeInactive),
        docType: q(req.query.docType)?.toUpperCase(),
        defaultsOnly: qbool(req.query.defaultsOnly),
      }), 'termsBlocks'));
  }),
);

setupRouter.post(
  '/setup/terms-blocks',
  requirePermission('setup', 'C'),
  asyncHandler(async (req, res) => {
    const body = termsCreateSchema.parse(req.body ?? {});
    res.status(201).json(envelope(await svc.createTermsBlock(requireAuth(req), body), 'termsBlock'));
  }),
);

setupRouter.put(
  '/setup/terms-blocks/:id',
  requirePermission('setup', 'U'),
  asyncHandler(async (req, res) => {
    const body = termsUpdateSchema.parse(req.body ?? {});
    res.json(envelope(await svc.updateTermsBlock(requireAuth(req), param(req, 'id'), body), 'termsBlock'));
  }),
);

setupRouter.delete(
  '/setup/terms-blocks/:id',
  requirePermission('setup', 'D'),
  asyncHandler(async (req, res) => {
    res.json(wrap(await svc.deleteTermsBlock(requireAuth(req), param(req, 'id'))));
  }),
);

// ── FR-112 · rounding rules ──────────────────────────────────────────────────

setupRouter.get(
  '/setup/rounding-rules',
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.listRoundingRules(requireAuth(req)), 'roundingRules'));
  }),
);

setupRouter.put(
  '/setup/rounding-rules',
  requirePermission('setup', 'U'),
  asyncHandler(async (req, res) => {
    const parsed = roundingUpsertSchema.parse(req.body ?? {});
    const rules = 'rules' in parsed ? parsed.rules : [parsed];
    res.json(envelope(await svc.upsertRoundingRules(requireAuth(req), rules), 'roundingRules'));
  }),
);

// ── FR-119 / FR-715 / FR-725 · users ─────────────────────────────────────────

setupRouter.get(
  '/setup/users',
  requirePermission('users', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.listUsers(requireAuth(req), {
        status: q(req.query.status)?.toUpperCase(),
        role: q(req.query.role)?.toUpperCase(),
      }), 'users'));
  }),
);

setupRouter.get(
  '/setup/users/:id',
  requirePermission('users', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.getUser(requireAuth(req), param(req, 'id')), 'user'));
  }),
);

setupRouter.post(
  '/setup/users',
  requirePermission('users', 'C'),
  asyncHandler(async (req, res) => {
    const body = userCreateSchema.parse(req.body ?? {});
    res.status(201).json(envelope(await svc.createUser(requireAuth(req), body), 'user'));
  }),
);

setupRouter.put(
  '/setup/users/:id',
  requirePermission('users', 'U'),
  asyncHandler(async (req, res) => {
    const body = userUpdateSchema.parse(req.body ?? {});
    res.json(envelope(await svc.updateUser(requireAuth(req), param(req, 'id'), body), 'user'));
  }),
);

setupRouter.delete(
  '/setup/users/:id',
  requirePermission('users', 'D'),
  asyncHandler(async (req, res) => {
    res.json(wrap(await svc.deleteUser(requireAuth(req), param(req, 'id'))));
  }),
);

// ── FR-722 / FR-724 · subscription ───────────────────────────────────────────

setupRouter.get(
  '/setup/subscription',
  requirePermission('subscription', 'R'),
  asyncHandler(async (req, res) => {
    res.json(envelope(await svc.getSubscription(requireAuth(req)), 'subscription'));
  }),
);

setupRouter.post(
  '/setup/subscription/change',
  requirePermission('subscription', 'U'),
  asyncHandler(async (req, res) => {
    const body = planChangeSchema.parse(req.body ?? {});
    res.json(envelope(await svc.changePlan(requireAuth(req), body), 'subscription'));
  }),
);

// ── FR-718 · audit log (Owner/Admin, read-only) ──────────────────────────────

setupRouter.get(
  '/setup/audit-log',
  requireRole('OWNER_ADMIN'),
  requirePermission('setup', 'R'),
  asyncHandler(async (req, res) => {
    const query = auditQuerySchema.parse(req.query);
    res.json(envelope(await svc.listAuditLog(requireAuth(req), query), 'entries'));
  }),
);
