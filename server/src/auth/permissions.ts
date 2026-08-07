/**
 * FRD §2.3 — "User roles & permission matrix (Phase 1)", enforced server-side
 * per FR-715 ("permissions are enforced server-side on every request, not just
 * hidden in the UI") and FR-716 ("Enforcement is deny-by-default").
 */
import type { UserRole } from '@prisma/client';

export type Action = 'C' | 'R' | 'U' | 'D' | 'A';

export type Module =
  | 'setup'
  | 'crm'
  | 'quotation'
  | 'jobcard'
  | 'production'
  | 'inventory'
  | 'procurement'
  | 'invoice'
  | 'edocs'
  | 'payments'
  | 'ledgers'
  | 'dispatch'
  | 'reports'
  | 'communication'
  | 'subscription'
  | 'users';

type Matrix = Record<Module, Partial<Record<UserRole, Action[]>>>;

const N: Action[] = [];
const R: Action[] = ['R'];
const CR: Action[] = ['C', 'R'];
const CRU: Action[] = ['C', 'R', 'U'];
const CRUD: Action[] = ['C', 'R', 'U', 'D'];
const CRUDA: Action[] = ['C', 'R', 'U', 'D', 'A'];

/** Mirrors the §2.3 table row-for-row. */
export const PERMISSION_MATRIX: Matrix = {
  // Setup, config & masters | C R U D A | R (U on tax/party) | R | R | — | —
  setup: { OWNER_ADMIN: CRUDA, ACCOUNTS: ['R', 'U'], SALES_COUNTER: R, PRODUCTION_MANAGER: R, OPERATOR: N, DELIVERY: N },
  // Enquiry & CRM | C R U D | R | C R U | R | — | —
  crm: { OWNER_ADMIN: CRUD, ACCOUNTS: R, SALES_COUNTER: CRU, PRODUCTION_MANAGER: R, OPERATOR: N, DELIVERY: N },
  // Quotation & pricing | C R U D A | R | C R U | R | — | —
  quotation: { OWNER_ADMIN: CRUDA, ACCOUNTS: R, SALES_COUNTER: CRU, PRODUCTION_MANAGER: R, OPERATOR: N, DELIVERY: N },
  // Jobcard | C R U D | R | C R U | C R U | R | R
  jobcard: { OWNER_ADMIN: CRUD, ACCOUNTS: R, SALES_COUNTER: CRU, PRODUCTION_MANAGER: CRU, OPERATOR: R, DELIVERY: R },
  // Production board / stages | R U | — | R | C R U D | R U (own) | R
  production: { OWNER_ADMIN: ['R', 'U'], ACCOUNTS: N, SALES_COUNTER: R, PRODUCTION_MANAGER: CRUD, OPERATOR: ['R', 'U'], DELIVERY: R },
  // Inventory & stock | C R U D | R | R | R U (issue) | R | —
  inventory: { OWNER_ADMIN: CRUD, ACCOUNTS: R, SALES_COUNTER: R, PRODUCTION_MANAGER: ['R', 'U'], OPERATOR: R, DELIVERY: N },
  procurement: { OWNER_ADMIN: CRUDA, ACCOUNTS: CRU, SALES_COUNTER: N, PRODUCTION_MANAGER: R, OPERATOR: N, DELIVERY: N },
  invoice: { OWNER_ADMIN: CRUDA, ACCOUNTS: CRU, SALES_COUNTER: CR, PRODUCTION_MANAGER: N, OPERATOR: N, DELIVERY: N },
  edocs: { OWNER_ADMIN: ['C', 'R', 'A'], ACCOUNTS: CR, SALES_COUNTER: R, PRODUCTION_MANAGER: R, OPERATOR: N, DELIVERY: R },
  payments: { OWNER_ADMIN: CRUD, ACCOUNTS: CRU, SALES_COUNTER: R, PRODUCTION_MANAGER: N, OPERATOR: N, DELIVERY: N },
  ledgers: { OWNER_ADMIN: R, ACCOUNTS: CRU, SALES_COUNTER: R, PRODUCTION_MANAGER: N, OPERATOR: N, DELIVERY: N },
  dispatch: { OWNER_ADMIN: CRUD, ACCOUNTS: R, SALES_COUNTER: R, PRODUCTION_MANAGER: R, OPERATOR: N, DELIVERY: CRU },
  reports: { OWNER_ADMIN: R, ACCOUNTS: R, SALES_COUNTER: R, PRODUCTION_MANAGER: R, OPERATOR: R, DELIVERY: R },
  communication: { OWNER_ADMIN: CR, ACCOUNTS: CR, SALES_COUNTER: CR, PRODUCTION_MANAGER: CR, OPERATOR: N, DELIVERY: CR },
  subscription: { OWNER_ADMIN: CRU, ACCOUNTS: R, SALES_COUNTER: N, PRODUCTION_MANAGER: N, OPERATOR: N, DELIVERY: N },
  users: { OWNER_ADMIN: CRUD, ACCOUNTS: N, SALES_COUNTER: N, PRODUCTION_MANAGER: N, OPERATOR: N, DELIVERY: N },
};

export function can(role: UserRole, module: Module, action: Action): boolean {
  return PERMISSION_MATRIX[module]?.[role]?.includes(action) ?? false;
}

/** The nav/permission map handed to the web client so it can hide what it may not use. */
export function permissionsFor(role: UserRole): Record<Module, Action[]> {
  const out = {} as Record<Module, Action[]>;
  for (const module of Object.keys(PERMISSION_MATRIX) as Module[]) {
    out[module] = PERMISSION_MATRIX[module][role] ?? [];
  }
  return out;
}

/** FR-310 — "only tenant users with an operator/production role may be assigned." */
export const ASSIGNABLE_ROLES: UserRole[] = ['OPERATOR', 'PRODUCTION_MANAGER'];
