/**
 * CRM routes — mounted at /api (see src/app.ts).
 *
 * FR-200 unified enquiry / lead inbox · FR-203 follow-up reminders & to-dos ·
 * FR-220 one-click enquiry → quotation.
 *
 * FR-716 — deny-by-default: every route carries a `crm` permission gate; the
 * conversion route additionally needs `quotation` create rights.
 */
import { Router } from 'express';
import { requireAuth, requirePermission } from '../../auth/middleware.js';
import { asyncHandler } from '../../http/errors.js';
import {
  convertToQuoteSchema,
  enquiryCreateSchema,
  enquiryIntakeSchema,
  enquiryListQuerySchema,
  enquiryUpdateSchema,
  followUpCloseSchema,
  followUpCreateSchema,
  followUpListQuerySchema,
  followUpNotifySchema,
} from './schemas.js';
import * as service from './service.js';

export const crmRouter = Router();

/** Express 5 types a path param as `string | string[]`; a single segment is one string. */
function pathParam(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

const canRead = requirePermission('crm', 'R');
const canCreate = requirePermission('crm', 'C');
const canUpdate = requirePermission('crm', 'U');
const canCreateQuote = requirePermission('quotation', 'C');

// ─────────────────────────────────────────────────────────────────────────────
// FR-200 — enquiry inbox
// ─────────────────────────────────────────────────────────────────────────────

crmRouter.get(
  '/enquiries',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.listEnquiries(auth, enquiryListQuerySchema.parse(req.query)));
  }),
);

crmRouter.post(
  '/enquiries',
  canCreate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.status(201).json(await service.createEnquiry(auth, enquiryCreateSchema.parse(req.body)));
  }),
);

/**
 * FR-200 — inbound web-form / WhatsApp intake. Registered before `/enquiries/:id`
 * so the literal path always wins.
 */
crmRouter.post(
  '/enquiries/intake',
  canCreate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.status(201).json(await service.intakeEnquiry(auth, enquiryIntakeSchema.parse(req.body)));
  }),
);

/** FR-220 — one-click enquiry → draft quotation, no re-keying. */
crmRouter.post(
  '/enquiries/:id/convert-to-quote',
  canCreateQuote,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const input = convertToQuoteSchema.parse(req.body ?? {});
    res.status(201).json(await service.convertEnquiryToQuote(auth, pathParam(req.params.id), input));
  }),
);

crmRouter.get(
  '/enquiries/:id',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.getEnquiry(auth, pathParam(req.params.id)));
  }),
);

crmRouter.put(
  '/enquiries/:id',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.updateEnquiry(auth, pathParam(req.params.id), enquiryUpdateSchema.parse(req.body)));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// FR-203 — follow-ups
// ─────────────────────────────────────────────────────────────────────────────

crmRouter.get(
  '/follow-ups',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.listFollowUps(auth, followUpListQuerySchema.parse(req.query)));
  }),
);

/** FR-203 — the assignee's own worklist. */
crmRouter.get(
  '/follow-ups/mine',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.myFollowUps(auth, followUpListQuerySchema.parse(req.query)));
  }),
);

/** FR-203 — due and not yet notified: the scheduler's queue. */
crmRouter.get(
  '/follow-ups/due',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.dueFollowUps(auth, followUpListQuerySchema.parse(req.query)));
  }),
);

crmRouter.post(
  '/follow-ups',
  canCreate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.status(201).json(await service.createFollowUp(auth, followUpCreateSchema.parse(req.body)));
  }),
);

/** FR-203 — Phase-1 notification path: stamp notifiedAt and log the WhatsApp send. */
crmRouter.post(
  '/follow-ups/:id/notify',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.notifyFollowUp(auth, pathParam(req.params.id), followUpNotifySchema.parse(req.body ?? {})));
  }),
);

crmRouter.post(
  '/follow-ups/:id/close',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.closeFollowUp(auth, pathParam(req.params.id), followUpCloseSchema.parse(req.body ?? {})));
  }),
);
