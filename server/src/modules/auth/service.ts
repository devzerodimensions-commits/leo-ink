/**
 * Authentication & self-serve sign-up — FR-715 (role-based access), FR-723
 * (self-serve free trial) and FR-100 (a new tenant lands pre-seeded so the
 * wizard can be finished by accepting defaults).
 */
import bcrypt from 'bcryptjs';
import type { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { conflict, forbidden, unauthorized, unprocessable } from '../../http/errors.js';
import { signToken, type AuthContext } from '../../auth/middleware.js';
import { permissionsFor } from '../../auth/permissions.js';
import { addDays } from '../../lib/fy.js';
import { validateGstin } from '../../lib/gstin.js';
import { money } from '../../lib/money.js';
import { recordAudit } from '../setup/audit.js';
import { loadPlanUsage, trialState } from '../setup/limits.js';
import {
  DEFAULT_PLAN_CODE,
  ensureDefaultPlans,
  planCatalogEntry,
  seedTenantDefaults,
} from './seed.js';
import type { loginSchema, registerSchema } from './schemas.js';

/** FR-723 — bcryptjs with 10 salt rounds. */
export const BCRYPT_ROUNDS = 10;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

type UserWithBranches = Prisma.UserGetPayload<{ include: { branches: true } }>;
type TenantRow = Prisma.TenantGetPayload<Record<string, never>>;

function serializeUser(u: UserWithBranches) {
  return {
    id: u.id,
    tenantId: u.tenantId,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    status: u.status,
    allBranches: u.allBranches,
    branchIds: u.branches.map((b) => b.branchId),
    lastLoginAt: iso(u.lastLoginAt),
    createdAt: iso(u.createdAt),
  };
}

function serializeTenant(t: TenantRow) {
  return {
    id: t.id,
    legalName: t.legalName,
    tradeName: t.tradeName,
    gstin: t.gstin,
    pan: t.pan,
    homeStateCode: t.homeStateCode,
    stateCode: t.stateCode,
    baseCurrency: t.baseCurrency,
    gstRegistered: t.gstRegistered,
    status: t.status,
    /** FR-100 — drives whether the app opens the wizard or the dashboard. */
    goLiveReady: t.goLiveReady,
    wizardStep: t.wizardStep,
    timezone: t.timezone,
    logoUrl: t.logoUrl,
    createdAt: iso(t.createdAt),
  };
}

async function subscriptionSummary(tenantId: string) {
  const usage = await loadPlanUsage(tenantId);
  const trial = trialState(usage);
  return {
    status: usage.status,
    seats: usage.seats,
    trialEndsAt: iso(usage.trialEndsAt),
    trialDaysRemaining: trial.daysRemaining,
    /** FR-723 — on expiry the tenant is restricted pending upgrade; data is retained. */
    restricted: trial.expired,
    plan: usage.planId
      ? {
          id: usage.planId,
          code: usage.planCode,
          name: usage.planName,
          maxUsers: usage.maxUsers,
          maxBranches: usage.maxBranches,
          features: usage.features,
        }
      : null,
    // FR-722 — "Given a plan with 5 seats, when a 5th active user exists, then seat usage shows 5/5."
    usage: {
      users: { used: usage.activeUsers, max: usage.maxUsers },
      branches: { used: usage.activeBranches, max: usage.maxBranches },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-723 — self-serve sign-up
// ─────────────────────────────────────────────────────────────────────────────

export async function register(input: z.infer<typeof registerSchema>) {
  const legalName = (input.legalName ?? input.firmName) as string;
  const ownerName = (input.ownerName ?? input.name) as string;
  const now = new Date();

  // FR-101 — a GSTIN offered at sign-up is checksum-validated and sets the home state.
  let gstin: string | null = null;
  let homeStateCode: string | null = null;
  if (input.gstin) {
    const check = validateGstin(input.gstin);
    if (!check.valid) {
      throw unprocessable(check.message ?? 'GSTIN is invalid', `GSTIN_${check.problem ?? 'INVALID'}`);
    }
    gstin = input.gstin;
    homeStateCode = check.stateCode ?? null;
  }

  // The login identifier must resolve to exactly one account.
  const taken = await prisma.user.findFirst({ where: { email: input.email }, select: { id: true } });
  if (taken) throw conflict('An account with this email already exists — sign in instead', 'EMAIL_TAKEN');

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const created = await prisma.$transaction(
    async (tx) => {
      await ensureDefaultPlans(tx);

      const catalogue = planCatalogEntry(input.planCode ?? DEFAULT_PLAN_CODE) ?? planCatalogEntry(DEFAULT_PLAN_CODE);
      if (!catalogue) throw unprocessable(`Unknown plan "${input.planCode}"`, 'PLAN_UNKNOWN');
      const plan = await tx.plan.upsert({
        where: { code: catalogue.code },
        update: {},
        create: {
          code: catalogue.code,
          name: catalogue.name,
          maxUsers: catalogue.maxUsers,
          maxBranches: catalogue.maxBranches,
          features: catalogue.features,
          pricePerYear: catalogue.pricePerYear,
          active: true,
        },
      });

      const tenant = await tx.tenant.create({
        data: {
          legalName,
          tradeName: input.tradeName || null,
          gstin,
          homeStateCode,
          stateCode: homeStateCode,
          email: input.email,
          phone: input.phone || null,
          // FR-100 — a brand-new tenant opens the wizard, not the dashboard.
          status: 'SETUP',
          goLiveReady: false,
          wizardStep: 'firm',
        },
      });

      // FR-119 / FR-715 — the first user is the Owner/Admin with all-branch access.
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          name: ownerName,
          email: input.email,
          phone: input.phone || null,
          passwordHash,
          role: 'OWNER_ADMIN',
          status: 'ACTIVE',
          allBranches: true,
        },
        include: { branches: true },
      });

      // FR-723 — time-boxed trial, no payment up front.
      const trialEndsAt = addDays(now, env.trialDays);
      const subscription = await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          planId: plan.id,
          status: 'TRIAL',
          seats: plan.maxUsers,
          trialEndsAt,
          periodStart: now,
          periodEnd: trialEndsAt,
        },
      });

      // FR-100 / FR-104 / FR-110 / FR-306 — pre-seeded config.
      const seeded = await seedTenantDefaults(tx, tenant.id, now);

      await recordAudit({
        tenantId: tenant.id,
        entityType: 'TENANT',
        entityId: tenant.id,
        action: 'CREATE',
        actorId: user.id,
        after: { legalName, plan: plan.code, trialEndsAt: trialEndsAt.toISOString(), fy: seeded.fyLabel },
        tx,
      });

      return { tenant, user, subscription, plan, fyLabel: seeded.fyLabel };
    },
    { timeout: 30_000 },
  );

  const token = signToken({
    sub: created.user.id,
    tenantId: created.tenant.id,
    role: created.user.role,
  });

  return {
    token,
    user: serializeUser(created.user),
    tenant: serializeTenant(created.tenant),
    permissions: permissionsFor(created.user.role),
    subscription: {
      status: created.subscription.status,
      seats: created.subscription.seats,
      trialEndsAt: iso(created.subscription.trialEndsAt),
      plan: {
        id: created.plan.id,
        code: created.plan.code,
        name: created.plan.name,
        maxUsers: created.plan.maxUsers,
        maxBranches: created.plan.maxBranches,
        features: created.plan.features,
        pricePerYear: money(String(created.plan.pricePerYear)),
      },
    },
    seeded: { financialYear: created.fyLabel },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-715 — sign-in
// ─────────────────────────────────────────────────────────────────────────────

export async function login(input: z.infer<typeof loginSchema>) {
  // Two round trips, not four. Each one costs a full network hop to the database,
  // which dominates sign-in when the two are in different regions — so the tenant
  // is fetched alongside the user rather than after it, and the lastLoginAt write
  // is not waited on.
  const candidates = await prisma.user.findMany({
    where: {
      email: input.email,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    },
    include: { branches: true, tenant: true },
    orderBy: { createdAt: 'asc' },
  });

  const matches: Array<UserWithBranches & { tenant: TenantRow }> = [];
  for (const candidate of candidates) {
    if (!candidate.passwordHash) continue;
    if (await bcrypt.compare(input.password, candidate.passwordHash)) matches.push(candidate);
  }

  if (matches.length === 0) throw unauthorized('Invalid email or password');

  // FR-715 — "Given a user is disabled, when they attempt to log in, then access
  // is denied while their historical records remain intact."
  const user = matches.find((m) => m.status !== 'DISABLED');
  if (!user) throw forbidden('This user account has been disabled — contact your administrator');

  // Audit-only: nothing in the response depends on it, so it must not delay the
  // sign-in. A failure here is logged, never surfaced to the user.
  void prisma.user
    .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    .catch((err) => console.error('[leo-ink] could not stamp lastLoginAt:', err));

  return {
    token: signToken({ sub: user.id, tenantId: user.tenantId, role: user.role }),
    user: serializeUser(user),
    // FR-715 — the client mirrors these, but the server enforces them on every request.
    permissions: permissionsFor(user.role),
    tenant: serializeTenant(user.tenant),
    subscription: await subscriptionSummary(user.tenantId),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session context
// ─────────────────────────────────────────────────────────────────────────────

export async function me(auth: AuthContext) {
  // FR-717 — an all-branch user sees every branch; anyone else only their own.
  // The filter is known from the request's auth context, so the branch list does
  // not have to wait for the user row — everything goes in one round trip.
  const branchWhere: Prisma.BranchWhereInput = { tenantId: auth.tenantId, active: true };
  if (!auth.allBranches) branchWhere.id = { in: auth.branchIds };

  const [user, tenant, branches, subscription] = await Promise.all([
    prisma.user.findFirst({
      where: { id: auth.userId, tenantId: auth.tenantId },
      include: { branches: true },
    }),
    prisma.tenant.findUnique({ where: { id: auth.tenantId } }),
    prisma.branch.findMany({
      where: branchWhere,
      orderBy: [{ isHeadOffice: 'desc' }, { branchCode: 'asc' }],
      select: {
        id: true,
        branchCode: true,
        name: true,
        stateCode: true,
        gstin: true,
        isHeadOffice: true,
        active: true,
      },
    }),
    subscriptionSummary(auth.tenantId),
  ]);
  if (!user || !tenant) throw unauthorized();

  return {
    user: serializeUser(user),
    tenant: serializeTenant(tenant),
    branches,
    permissions: permissionsFor(user.role),
    subscription,
  };
}
