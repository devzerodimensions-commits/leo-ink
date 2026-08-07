/**
 * Server response contracts.
 *
 * The production API returns *flattened* cards — `customerName`, `stageName`,
 * `assignedOperatorName` — rather than nested relations, so one shape serves the
 * board, the jobcard list and the operator queue alike. These types mirror
 * `server/src/modules/production/board.ts`.
 */

export type Vertical = 'FLEX_LARGE_FORMAT' | 'OFFSET' | 'DIGITAL' | 'SCREEN';
export type Priority = 'LOW' | 'NORMAL' | 'HIGH';
export type JobStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
export type StageStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';

/** One jobcard as it appears on the board, in a list, or in an operator's queue. */
export interface JobCard {
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

export interface BoardColumn {
  key: string;
  name: string;
  sequence: number;
  departments: string[];
  isTerminal: boolean;
  isDone: boolean;
  cards: JobCard[];
}

export interface BoardResponse {
  columns: BoardColumn[];
}

export interface MyJobsResponse {
  today: string;
  departments: string[];
  count: number;
  total: number;
  data: JobCard[];
}

export interface TatResponse {
  today: string;
  filter: string;
  counts: { dueToday: number; overdue: number };
  dueToday: JobCard[];
  overdue: JobCard[];
}

export interface Paged<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface QuoteSummary {
  id: string;
  quoteNo: string | null;
  quoteDate: string;
  validUntil: string | null;
  status: 'DRAFT' | 'SENT' | 'WON' | 'LOST' | 'EXPIRED';
  grandTotal: string;
  taxableValue: string;
  isInterstate: boolean;
  needsApproval: boolean;
  customer?: { id: string; name: string } | null;
  jobcards?: Array<{ id: string; jobcardNo: string; overallStatus: string }>;
}
