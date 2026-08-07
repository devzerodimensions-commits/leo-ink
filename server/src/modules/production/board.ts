/**
 * FR-307 Kanban job/load board + the stage-roll-up primitives shared with the
 * jobcard service (FR-309), the operator queue (FR-311) and TAT (FR-313).
 *
 * BR-4 — every query filters on `tenantId`; branch visibility mirrors
 * `scopeWhere` from the auth middleware.
 */
import type { JobStatus, Prisma, Priority, StageStatus, Vertical } from '@prisma/client';
import { prisma } from '../../db.js';
import type { AuthContext } from '../../auth/middleware.js';
import { tenantToday, addDays, toDateOnly } from '../../lib/fy.js';
import type { BoardQuery } from './schemas.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────────────────────

/** BR-4 — tenant is always filtered by the caller; this adds the branch slice. */
export function branchScope(auth: AuthContext): Prisma.JobcardWhereInput {
  if (auth.allBranches || auth.branchIds.length === 0) return {};
  return { branchId: { in: auth.branchIds } };
}

export interface StageProgressLike {
  id: string;
  stageId: string;
  stageName: string;
  sequence: number;
  department: string | null;
  isTerminal: boolean;
  status: StageStatus;
  assignedOperatorId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** The stage a jobcard is sitting on — the first that is neither completed nor skipped. */
export function activeProgress<T extends StageProgressLike>(rows: T[]): T | null {
  const ordered = [...rows].sort((a, b) => a.sequence - b.sequence);
  return ordered.find((r) => r.status !== 'COMPLETED' && r.status !== 'SKIPPED') ?? null;
}

/**
 * FR-309 — "`open` (no stage started), `in-progress` (any stage started and not
 * all terminal-complete), `done` (terminal stage completed)". Derived only,
 * never set by hand.
 */
export function rollUpStatus(rows: StageProgressLike[]): JobStatus {
  if (rows.length === 0) return 'OPEN';
  const terminals = rows.filter((r) => r.isTerminal);
  if (terminals.length > 0 && terminals.every((r) => r.status === 'COMPLETED')) return 'DONE';
  const started = rows.some(
    (r) => r.startedAt !== null || r.status === 'IN_PROGRESS' || r.status === 'COMPLETED' || r.status === 'SKIPPED',
  );
  return started ? 'IN_PROGRESS' : 'OPEN';
}

/** FR-313 — "due today" / "overdue" are calendar comparisons in the tenant timezone. */
export function dueFlags(
  deliveryDate: Date,
  overallStatus: JobStatus,
  today: Date = tenantToday(),
): { dueToday: boolean; overdue: boolean } {
  if (overallStatus === 'DONE' || overallStatus === 'CANCELLED') return { dueToday: false, overdue: false };
  const due = toDateOnly(deliveryDate).getTime();
  const ref = today.getTime();
  return { dueToday: due === ref, overdue: due < ref };
}

const PRIORITY_RANK: Record<Priority, number> = { HIGH: 3, NORMAL: 2, LOW: 1 };

export interface BoardCard {
  /** The jobcard id — `jobcardId` is kept as an explicit alias for queue payloads. */
  id: string;
  jobcardId: string;
  jobcardNo: string;
  title: string | null;
  vertical: Vertical;
  customerId: string;
  customerName: string;
  deliveryDate: string;
  priority: Priority;
  rushFlag: boolean;
  overallStatus: JobStatus;
  specIncomplete: boolean;
  isQuick: boolean;
  specCount: number;
  stageProgressId: string | null;
  stageId: string | null;
  stageName: string | null;
  stageStatus: StageStatus | null;
  department: string | null;
  startedAt: string | null;
  assignedOperatorId: string | null;
  assignedOperatorName: string | null;
  dueToday: boolean;
  overdue: boolean;
}

/** FR-304 AC 1 — "sorts above non-rush cards in the same column". */
export function compareCards(a: BoardCard, b: BoardCard): number {
  if (a.rushFlag !== b.rushFlag) return a.rushFlag ? -1 : 1;
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  const priority = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
  if (priority !== 0) return priority;
  if (a.deliveryDate !== b.deliveryDate) return a.deliveryDate < b.deliveryDate ? -1 : 1;
  return a.jobcardNo.localeCompare(b.jobcardNo);
}

interface JobcardForBoard {
  id: string;
  jobcardNo: string;
  title: string | null;
  vertical: Vertical;
  customerId: string;
  deliveryDate: Date;
  priority: Priority;
  rushFlag: boolean;
  overallStatus: JobStatus;
  specIncomplete: boolean;
  isQuick: boolean;
  customer: { id: string; name: string };
  specs: Array<{ id: string }>;
  progress: Array<StageProgressLike & { operator: { id: string; name: string } | null }>;
}

export function toCard(jobcard: JobcardForBoard, today: Date): BoardCard {
  const active = activeProgress(jobcard.progress);
  const flags = dueFlags(jobcard.deliveryDate, jobcard.overallStatus, today);
  return {
    id: jobcard.id,
    jobcardId: jobcard.id,
    jobcardNo: jobcard.jobcardNo,
    title: jobcard.title,
    vertical: jobcard.vertical,
    customerId: jobcard.customerId,
    customerName: jobcard.customer.name,
    deliveryDate: jobcard.deliveryDate.toISOString(),
    priority: jobcard.priority,
    rushFlag: jobcard.rushFlag,
    overallStatus: jobcard.overallStatus,
    specIncomplete: jobcard.specIncomplete,
    isQuick: jobcard.isQuick,
    specCount: jobcard.specs.length,
    stageProgressId: active?.id ?? null,
    stageId: active?.stageId ?? null,
    stageName: active?.stageName ?? null,
    stageStatus: active?.status ?? null,
    department: active?.department ?? null,
    startedAt: active?.startedAt ? active.startedAt.toISOString() : null,
    assignedOperatorId: active?.assignedOperatorId ?? null,
    assignedOperatorName: active?.operator?.name ?? null,
    dueToday: flags.dueToday,
    overdue: flags.overdue,
  };
}

export const boardJobcardInclude = {
  customer: { select: { id: true, name: true } },
  specs: { select: { id: true } },
  progress: {
    orderBy: { sequence: 'asc' },
    include: { operator: { select: { id: true, name: true } } },
  },
} satisfies Prisma.JobcardInclude;

// ─────────────────────────────────────────────────────────────────────────────
// FR-307 — the board itself
// ─────────────────────────────────────────────────────────────────────────────

export interface BoardColumn {
  key: string;
  name: string;
  sequence: number;
  departments: string[];
  isTerminal: boolean;
  isDone: boolean;
  cards: BoardCard[];
}

const DONE_COLUMN_KEY = '__done';

export async function getBoard(auth: AuthContext, query: BoardQuery): Promise<{
  today: string;
  columns: BoardColumn[];
  total: number;
  filters: BoardQuery;
}> {
  const today = tenantToday();
  const tomorrow = addDays(today, 1);

  // FR-309 — done jobcards drop off the active board unless explicitly requested.
  const statuses: JobStatus[] = query.includeDone ? ['OPEN', 'IN_PROGRESS', 'DONE'] : ['OPEN', 'IN_PROGRESS'];

  const where: Prisma.JobcardWhereInput = {
    tenantId: auth.tenantId,
    overallStatus: { in: statuses },
    ...branchScope(auth),
  };
  if (query.vertical) where.vertical = query.vertical;
  if (query.priority) where.priority = query.priority;
  if (query.rush !== undefined) where.rushFlag = query.rush;
  if (query.dueToday) where.deliveryDate = { gte: today, lt: tomorrow };
  if (query.overdue) where.deliveryDate = { lt: today };
  if (query.q) {
    where.OR = [
      { jobcardNo: { contains: query.q, mode: 'insensitive' } },
      { title: { contains: query.q, mode: 'insensitive' } },
      { customer: { name: { contains: query.q, mode: 'insensitive' } } },
      { specs: { some: { description: { contains: query.q, mode: 'insensitive' } } } },
    ];
  }

  const [jobcards, templates] = await Promise.all([
    prisma.jobcard.findMany({ where, include: boardJobcardInclude, orderBy: { deliveryDate: 'asc' } }),
    prisma.workflowTemplate.findMany({
      where: { tenantId: auth.tenantId, active: true, ...(query.vertical ? { vertical: query.vertical } : {}) },
      include: { stages: { orderBy: { sequence: 'asc' } } },
    }),
  ]);

  // Columns come from the configured stages so an empty stage still renders.
  const columns = new Map<string, BoardColumn>();
  const addColumn = (name: string, sequence: number, department: string | null, isTerminal: boolean) => {
    const existing = columns.get(name);
    if (!existing) {
      columns.set(name, {
        key: name,
        name,
        sequence,
        departments: department ? [department] : [],
        isTerminal,
        isDone: false,
        cards: [],
      });
      return;
    }
    existing.sequence = Math.min(existing.sequence, sequence);
    existing.isTerminal = existing.isTerminal || isTerminal;
    if (department && !existing.departments.includes(department)) existing.departments.push(department);
  };

  for (const template of templates) {
    for (const stage of template.stages) addColumn(stage.name, stage.sequence, stage.department, stage.isTerminal);
  }

  const cards = jobcards.map((jobcard) => ({ jobcard, card: toCard(jobcard, today) }));

  // FR-306 — an in-flight jobcard keeps its snapshotted stages even after the
  // template was edited, so any stage name still in play earns a column.
  for (const jobcard of jobcards) {
    for (const row of jobcard.progress) addColumn(row.stageName, row.sequence, row.department, row.isTerminal);
  }

  if (query.includeDone) {
    columns.set(DONE_COLUMN_KEY, {
      key: DONE_COLUMN_KEY,
      name: 'Done',
      sequence: Number.MAX_SAFE_INTEGER,
      departments: [],
      isTerminal: true,
      isDone: true,
      cards: [],
    });
  }

  let total = 0;
  for (const { card } of cards) {
    // Board-level filters that read from the card's active stage (FR-307).
    if (query.department && card.department !== query.department) continue;
    if (query.operatorId && card.assignedOperatorId !== query.operatorId) continue;

    const columnKey = card.overallStatus === 'DONE' || !card.stageName ? DONE_COLUMN_KEY : card.stageName;
    const column = columns.get(columnKey) ?? columns.get(DONE_COLUMN_KEY);
    if (!column) continue;
    column.cards.push(card);
    total += 1;
  }

  const ordered = [...columns.values()].sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name));
  for (const column of ordered) column.cards.sort(compareCards);

  return { today: today.toISOString().slice(0, 10), columns: ordered, total, filters: query };
}
