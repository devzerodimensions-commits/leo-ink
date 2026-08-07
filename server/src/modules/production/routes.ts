/**
 * Jobcard & production routes — mounted at /api (see src/app.ts).
 *
 * FRD §5: FR-300 multi-vertical jobcard · FR-301 quick jobcard · FR-302 jobcard
 * from quote · FR-303 numbering · FR-304 delivery date/priority/rush · FR-305
 * job bag + QR · FR-306 workflow templates · FR-307 Kanban board · FR-308 stage
 * progression · FR-309 roll-up status · FR-310 assignment · FR-311 my-jobs ·
 * FR-312 scan-to-status · FR-313 TAT & alerts.
 *
 * FR-716 — deny-by-default: every route carries a permission guard.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth, requirePermission } from '../../auth/middleware.js';
import { can, type Action, type Module } from '../../auth/permissions.js';
import { asyncHandler, forbidden } from '../../http/errors.js';
import { getBoard } from './board.js';
import {
  advanceSchema,
  assignSchema,
  boardQuerySchema,
  eventsQuerySchema,
  jobcardCreateSchema,
  jobcardListQuerySchema,
  jobcardUpdateSchema,
  myJobsQuerySchema,
  quickJobcardSchema,
  revertSchema,
  scanSchema,
  tatAlertSchema,
  tatQuerySchema,
  workflowTemplateCreateSchema,
  workflowTemplateListQuerySchema,
  workflowTemplateUpdateSchema,
} from './schemas.js';
import * as service from './service.js';

export const productionRouter = Router();

/** Express 5 types a path param as `string | string[]`; a single segment is always one string. */
function pathParam(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

/**
 * FR-306 names both Admin/Owner and Production Manager as actors, and the §2.3
 * matrix splits that authority across two modules (`setup` for the Owner,
 * `production` for the manager). Still deny-by-default — it just accepts either
 * grant rather than locking one of the two named actors out.
 */
function requireAnyPermission(...grants: Array<[Module, Action]>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const auth = requireAuth(req);
      if (!grants.some(([module, action]) => can(auth.role, module, action))) {
        const wanted = grants.map(([m, a]) => `${a} in ${m}`).join(' or ');
        throw forbidden(`Your role (${auth.role}) needs ${wanted} to do this`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

const canReadJobcard = requirePermission('jobcard', 'R');
const canCreateJobcard = requirePermission('jobcard', 'C');
const canUpdateJobcard = requirePermission('jobcard', 'U');
const canReadProduction = requirePermission('production', 'R');
const canUpdateProduction = requirePermission('production', 'U');
const canQueueMessages = requirePermission('communication', 'C');

const canReadWorkflow = requireAnyPermission(['setup', 'R'], ['production', 'R']);
const canCreateWorkflow = requireAnyPermission(['setup', 'C'], ['production', 'C']);
const canUpdateWorkflow = requireAnyPermission(['setup', 'U'], ['production', 'U']);
const canDeleteWorkflow = requireAnyPermission(['setup', 'D'], ['production', 'D']);

// ─────────────────────────────────────────────────────────────────────────────
// FR-306 — admin-configurable per-vertical workflow templates
// ─────────────────────────────────────────────────────────────────────────────

productionRouter.get(
  '/workflow-templates',
  canReadWorkflow,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.listWorkflowTemplates(auth, workflowTemplateListQuerySchema.parse(req.query)));
  }),
);

productionRouter.post(
  '/workflow-templates',
  canCreateWorkflow,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const created = await service.createWorkflowTemplate(auth, workflowTemplateCreateSchema.parse(req.body));
    res.status(201).json(created);
  }),
);

productionRouter.get(
  '/workflow-templates/:id',
  canReadWorkflow,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.getWorkflowTemplate(auth, pathParam(req.params.id)));
  }),
);

productionRouter.put(
  '/workflow-templates/:id',
  canUpdateWorkflow,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(
      await service.updateWorkflowTemplate(auth, pathParam(req.params.id), workflowTemplateUpdateSchema.parse(req.body)),
    );
  }),
);

/** BR-11 — deactivation, not deletion, once jobcards reference the template. */
productionRouter.delete(
  '/workflow-templates/:id',
  canDeleteWorkflow,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.deleteWorkflowTemplate(auth, pathParam(req.params.id)));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// FR-307 / FR-311 / FR-312 / FR-313 — board, queue, scan, TAT
// Registered before /jobcards/:id so the literal paths win.
// ─────────────────────────────────────────────────────────────────────────────

productionRouter.get(
  '/production/board',
  canReadProduction,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await getBoard(auth, boardQuerySchema.parse(req.query)));
  }),
);

productionRouter.get(
  '/production/my-jobs',
  canReadProduction,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.myJobs(auth, myJobsQuerySchema.parse(req.query)));
  }),
);

/** FR-312 — the mobile scan; `advance` re-checks the production update grant inside. */
productionRouter.post(
  '/production/scan',
  canReadProduction,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.scan(auth, scanSchema.parse(req.body)));
  }),
);

productionRouter.get(
  '/production/tat',
  canReadProduction,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.tat(auth, tatQuerySchema.parse(req.query)));
  }),
);

productionRouter.post(
  '/production/tat/alerts',
  canQueueMessages,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.runTatAlerts(auth, tatAlertSchema.parse(req.body ?? {})));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// FR-300 … FR-305 — jobcards
// ─────────────────────────────────────────────────────────────────────────────

productionRouter.get(
  '/jobcards',
  canReadJobcard,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.listJobcards(auth, jobcardListQuerySchema.parse(req.query)));
  }),
);

/** FR-301 — registered before POST /jobcards is irrelevant, but keeps the quick path obvious. */
productionRouter.post(
  '/jobcards/quick',
  canCreateJobcard,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const created = await service.createQuickJobcard(auth, quickJobcardSchema.parse(req.body));
    res.status(201).json(created);
  }),
);

productionRouter.post(
  '/jobcards',
  canCreateJobcard,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const created = await service.createJobcard(auth, jobcardCreateSchema.parse(req.body));
    res.status(201).json(created);
  }),
);

/** FR-305 — the consolidated digital job bag; creates the QR token lazily. */
productionRouter.get(
  '/jobcards/:id/job-bag',
  canReadJobcard,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.jobBag(auth, pathParam(req.params.id)));
  }),
);

productionRouter.post(
  '/jobcards/:id/print-ticket',
  canReadJobcard,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.printTicket(auth, pathParam(req.params.id)));
  }),
);

/** FR-308 — forward move; optional `toStageId` skips ahead (authorized roles only). */
productionRouter.post(
  '/jobcards/:id/advance',
  canUpdateProduction,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.advanceJobcard(auth, pathParam(req.params.id), advanceSchema.parse(req.body ?? {}), 'WEB'));
  }),
);

/** FR-308 AC 2 — backward move, Owner/Admin and Production Manager only. */
productionRouter.post(
  '/jobcards/:id/revert',
  canUpdateProduction,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.revertJobcard(auth, pathParam(req.params.id), revertSchema.parse(req.body ?? {}), 'WEB'));
  }),
);

/** FR-310 — stage-level operator assignment / reassignment. */
productionRouter.post(
  '/jobcards/:id/stages/:stageProgressId/assign',
  canUpdateProduction,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(
      await service.assignStage(
        auth,
        pathParam(req.params.id),
        pathParam(req.params.stageProgressId),
        assignSchema.parse(req.body),
      ),
    );
  }),
);

/** FR-304 / FR-308 — the jobcard's audit timeline. */
productionRouter.get(
  '/jobcards/:id/events',
  canReadJobcard,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const { pageSize } = eventsQuerySchema.parse(req.query);
    res.json(await service.listJobEvents(auth, pathParam(req.params.id), pageSize));
  }),
);

productionRouter.get(
  '/jobcards/:id',
  canReadJobcard,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.getJobcard(auth, pathParam(req.params.id)));
  }),
);

productionRouter.put(
  '/jobcards/:id',
  canUpdateJobcard,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.updateJobcard(auth, pathParam(req.params.id), jobcardUpdateSchema.parse(req.body)));
  }),
);
