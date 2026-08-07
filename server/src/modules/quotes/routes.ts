/**
 * Quotation routes — mounted at /api (see src/app.ts).
 *
 * FR-210 shared pricing engine · FR-211/FR-221 job spec & square-foot pricing ·
 * FR-212 rate resolution · FR-214/FR-215 discounts & rounding · FR-222 live
 * recalculation · FR-223/FR-224 GST treatment · FR-225 branded document ·
 * FR-226 share · FR-230 status pipeline & expiry · FR-231/FR-232 clone/revive ·
 * FR-233 jobcard conversion.
 *
 * FR-716 — deny-by-default: every route carries a `quotation` permission gate
 * (the conversion route also needs `jobcard` create rights).
 */
import { Router } from 'express';
import { requireAuth, requirePermission } from '../../auth/middleware.js';
import { asyncHandler } from '../../http/errors.js';
import {
  assertNoComputedFields,
  pricePreviewSchema,
  quoteCloneSchema,
  quoteCreateSchema,
  quoteListQuerySchema,
  quoteSendSchema,
  quoteStatusChangeSchema,
  quoteUpdateSchema,
} from './schemas.js';
import * as service from './service.js';

export const quotesRouter = Router();

/** Express 5 types a path param as `string | string[]`; a single segment is one string. */
function pathParam(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

const canRead = requirePermission('quotation', 'R');
const canCreate = requirePermission('quotation', 'C');
const canUpdate = requirePermission('quotation', 'U');
const canDelete = requirePermission('quotation', 'D');
const canCreateJobcard = requirePermission('jobcard', 'C');

// ─────────────────────────────────────────────────────────────────────────────
// FR-210 / FR-222 — stateless price preview (what the builder calls live)
// ─────────────────────────────────────────────────────────────────────────────

quotesRouter.post(
  '/quotes/price',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    assertNoComputedFields(req.body);
    res.json(await service.previewPrice(auth, pricePreviewSchema.parse(req.body)));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// FR-230 — scheduled expiry sweep (registered before /quotes/:id routes)
// ─────────────────────────────────────────────────────────────────────────────

quotesRouter.post(
  '/quotes/expire-due',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.expireDue(auth));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// FR-222 — multi-line quote builder
// ─────────────────────────────────────────────────────────────────────────────

quotesRouter.get(
  '/quotes',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.listQuotes(auth, quoteListQuerySchema.parse(req.query)));
  }),
);

quotesRouter.post(
  '/quotes',
  canCreate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    assertNoComputedFields(req.body);
    res.status(201).json(await service.createQuote(auth, quoteCreateSchema.parse(req.body)));
  }),
);

/** FR-225 — deterministic document model for the branded PDF. */
quotesRouter.get(
  '/quotes/:id/document',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.quoteDocument(auth, pathParam(req.params.id)));
  }),
);

/** FR-226 — share on WhatsApp/Email/SMS; Draft → Sent, number allocated here. */
quotesRouter.post(
  '/quotes/:id/send',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.sendQuote(auth, pathParam(req.params.id), quoteSendSchema.parse(req.body)));
  }),
);

/** FR-230 — Draft → Sent → (Won | Lost | Expired). */
quotesRouter.post(
  '/quotes/:id/status',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.changeStatus(auth, pathParam(req.params.id), quoteStatusChangeSchema.parse(req.body)));
  }),
);

/** FR-231 / FR-232 — clone into a fresh draft, re-priced at current rates. */
quotesRouter.post(
  '/quotes/:id/clone',
  canCreate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.status(201).json(await service.cloneQuote(auth, pathParam(req.params.id), quoteCloneSchema.parse(req.body ?? {})));
  }),
);

/** FR-233 — one-click Won quote → jobcard (production module builds it). */
quotesRouter.post(
  '/quotes/:id/convert-to-jobcard',
  canCreateJobcard,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.status(201).json(await service.convertToJobcard(auth, pathParam(req.params.id)));
  }),
);

quotesRouter.get(
  '/quotes/:id',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.getQuote(auth, pathParam(req.params.id)));
  }),
);

quotesRouter.put(
  '/quotes/:id',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    assertNoComputedFields(req.body);
    res.json(await service.updateQuote(auth, pathParam(req.params.id), quoteUpdateSchema.parse(req.body)));
  }),
);

quotesRouter.delete(
  '/quotes/:id',
  canDelete,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.deleteQuote(auth, pathParam(req.params.id)));
  }),
);
