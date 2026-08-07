/**
 * FR-722 / FR-725 — plan seat & branch limits.
 *
 * "Adding a user beyond max_users or a branch beyond max_branches is blocked
 *  with an inline 'upgrade to add more' prompt … Enforcement is server-side;
 *  limit checks apply equally to trial and paid subscriptions."
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { AppError } from '../../http/errors.js';

export const PLAN_LIMIT_CODE = 'PLAN_LIMIT';

export interface PlanUsage {
  subscriptionId: string | null;
  status: string | null;
  seats: number | null;
  trialEndsAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  planId: string | null;
  planCode: string | null;
  planName: string | null;
  features: string[];
  /** null ⇒ no subscription on file, so nothing to enforce. */
  maxUsers: number | null;
  maxBranches: number | null;
  activeUsers: number;
  activeBranches: number;
}

/** `PrismaClient` satisfies this too, so callers may pass either. */
type Client = Prisma.TransactionClient;

/**
 * FR-722 — "Active user accounts consume seats; deactivating a user frees a
 * seat." An invited-but-not-yet-signed-in user still holds their seat.
 */
export async function countSeatConsumingUsers(tenantId: string, client: Client = prisma): Promise<number> {
  return client.user.count({ where: { tenantId, status: { not: 'DISABLED' } } });
}

export async function countActiveBranches(tenantId: string, client: Client = prisma): Promise<number> {
  return client.branch.count({ where: { tenantId, active: true } });
}

export async function loadPlanUsage(tenantId: string, client: Client = prisma): Promise<PlanUsage> {
  const [subscription, activeUsers, activeBranches] = await Promise.all([
    client.subscription.findUnique({ where: { tenantId }, include: { plan: true } }),
    countSeatConsumingUsers(tenantId, client),
    countActiveBranches(tenantId, client),
  ]);

  return {
    subscriptionId: subscription?.id ?? null,
    status: subscription?.status ?? null,
    seats: subscription?.seats ?? null,
    trialEndsAt: subscription?.trialEndsAt ?? null,
    periodStart: subscription?.periodStart ?? null,
    periodEnd: subscription?.periodEnd ?? null,
    planId: subscription?.planId ?? null,
    planCode: subscription?.plan.code ?? null,
    planName: subscription?.plan.name ?? null,
    features: subscription?.plan.features ?? [],
    maxUsers: subscription?.plan.maxUsers ?? null,
    maxBranches: subscription?.plan.maxBranches ?? null,
    activeUsers,
    activeBranches,
  };
}

function planLimitError(
  resource: 'users' | 'branches',
  used: number,
  max: number,
  planName: string,
): AppError {
  const noun = resource === 'users' ? 'user seat' : 'branch';
  return new AppError(
    `Your ${planName} plan includes ${max} ${noun}${max === 1 ? '' : 's'} and ${used} ${used === 1 ? 'is' : 'are'} already in use. Upgrade your plan to add more.`,
    409,
    PLAN_LIMIT_CODE,
    {
      limit: resource,
      max,
      used,
      plan: planName,
      upgrade: {
        message: 'Upgrade to add more',
        endpoint: 'POST /api/setup/subscription/change',
      },
    },
  );
}

/** FR-725 — call before persisting a new (or re-enabled) user. */
export async function assertSeatAvailable(
  tenantId: string,
  client: Client = prisma,
  adding = 1,
): Promise<PlanUsage> {
  const usage = await loadPlanUsage(tenantId, client);
  if (usage.maxUsers !== null && usage.activeUsers + adding > usage.maxUsers) {
    throw planLimitError('users', usage.activeUsers, usage.maxUsers, usage.planName ?? 'current');
  }
  return usage;
}

/** FR-725 — call before persisting a new (or re-activated) branch. */
export async function assertBranchSlotAvailable(
  tenantId: string,
  client: Client = prisma,
  adding = 1,
): Promise<PlanUsage> {
  const usage = await loadPlanUsage(tenantId, client);
  if (usage.maxBranches !== null && usage.activeBranches + adding > usage.maxBranches) {
    throw planLimitError('branches', usage.activeBranches, usage.maxBranches, usage.planName ?? 'current');
  }
  return usage;
}

/** FR-723 — a trial that has run out puts the tenant in a restricted state (data retained). */
export function trialState(usage: PlanUsage, now: Date = new Date()): {
  onTrial: boolean;
  expired: boolean;
  daysRemaining: number | null;
} {
  const onTrial = usage.status === 'TRIAL';
  if (!onTrial || !usage.trialEndsAt) {
    return { onTrial, expired: usage.status === 'EXPIRED', daysRemaining: null };
  }
  const msLeft = usage.trialEndsAt.getTime() - now.getTime();
  return {
    onTrial: true,
    expired: msLeft <= 0,
    daysRemaining: Math.max(0, Math.ceil(msLeft / 86_400_000)),
  };
}
