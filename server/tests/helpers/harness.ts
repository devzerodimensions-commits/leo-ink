/**
 * Test harness for the API conformance suites.
 *
 * Each suite calls `newTenant()` to get a fully-seeded, isolated shop plus a
 * signed-in Owner. Tenant isolation (BR-4) means suites never see each other's
 * data, so they can run against one shared database.
 */
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db.js';
import { buildGstin } from '../../src/lib/gstin.js';

export const app = createApp() as unknown as App;

let counter = 0;

/**
 * Vitest isolates each test file, so a per-file counter alone would hand two
 * suites the same GSTIN. Mix in a per-process salt so identities stay unique
 * across the whole run.
 */
const SALT = Math.floor(Math.random() * 0x7fffffff);
const uniq = () => `${Date.now().toString(36)}${SALT.toString(36)}${(counter++).toString(36)}`;

/** A PAN-shaped string, so the GSTINs we build pass BR-6 checksum validation. */
function fakePan(seed: number): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const n = (seed + SALT) >>> 0;
  const l = (x: number) => letters[x % 26];
  return `A${l(n)}${l(n >> 5)}C${l(n >> 10)}${String(1000 + (n % 9000))}${l(n >> 15)}`;
}

export interface Client {
  token: string;
  get(path: string): request.Test;
  post(path: string, body?: unknown): request.Test;
  put(path: string, body?: unknown): request.Test;
  del(path: string): request.Test;
}

export function client(token: string): Client {
  const auth = (t: request.Test) => t.set('Authorization', `Bearer ${token}`);
  return {
    token,
    get: (p) => auth(request(app).get(`/api${p}`)),
    post: (p, body) => auth(request(app).post(`/api${p}`).send((body ?? {}) as object)),
    put: (p, body) => auth(request(app).put(`/api${p}`).send((body ?? {}) as object)),
    del: (p) => auth(request(app).delete(`/api${p}`)),
  };
}

export interface Tenant {
  tenantId: string;
  gstin: string;
  stateCode: string;
  owner: Client;
  ownerEmail: string;
  password: string;
  branchId: string;
  branchCode: string;
  fyId: string;
  fyLabel: string;
}

const PASSWORD = 'leoink-test-123';

/**
 * Register a fresh shop. The register endpoint seeds slabs, UOMs, series, FY and
 * workflows (FR-100).
 *
 * Sign-up lands on the Starter plan (3 seats, 1 branch). Structural suites need
 * more than that, so unless `plan` says otherwise the tenant is upgraded to
 * Growth right away — FR-724's "upgrades take effect immediately". The seat and
 * branch limits themselves are asserted separately on a Starter tenant.
 */
export async function newTenant(
  over: { stateCode?: string; legalName?: string; plan?: 'STARTER' | 'GROWTH' | 'SCALE' } = {},
): Promise<Tenant> {
  const stateCode = over.stateCode ?? '27'; // Maharashtra
  const seed = counter + 1;
  const gstin = buildGstin(stateCode, fakePan(seed));
  const email = `owner-${uniq()}@leoink.test`;

  const res = await request(app)
    .post('/api/auth/register')
    .send({
      legalName: over.legalName ?? `Test Print Shop ${uniq()}`,
      ownerName: 'Test Owner',
      email,
      password: PASSWORD,
      phone: '9800000000',
      gstin,
    });

  if (res.status >= 400) {
    throw new Error(`register failed (${res.status}): ${JSON.stringify(res.body)}`);
  }

  const token: string = res.body.token ?? res.body.data?.token;
  if (!token) throw new Error(`register returned no token: ${JSON.stringify(res.body)}`);

  const owner = client(token);

  const me = await owner.get('/auth/me');
  const tenantId: string = me.body.tenant?.id ?? me.body.data?.tenant?.id;

  // FR-724 — upgrades apply immediately, giving the suite room to add users and branches.
  const plan = over.plan ?? 'GROWTH';
  if (plan !== 'STARTER') {
    const change = await owner.post('/setup/subscription/change', { planCode: plan });
    if (change.status >= 400) {
      throw new Error(`could not move to the ${plan} plan (${change.status}): ${JSON.stringify(change.body)}`);
    }
  }

  // The register step may not have set the GSTIN; make sure the home state is known
  // so place-of-supply resolution has a supplier state to compare against.
  await owner.put('/setup/firm', { legalName: over.legalName ?? 'Test Print Shop', gstin });

  const branches = await owner.get('/setup/branches');
  const branchList = branches.body.data ?? branches.body;
  let branch = Array.isArray(branchList) ? branchList[0] : undefined;

  if (!branch) {
    const created = await owner.post('/setup/branches', {
      branchCode: 'HO',
      name: 'Head Office',
      gstin,
      stateCode,
      city: 'Pune',
      isHeadOffice: true,
    });
    branch = created.body.data ?? created.body;
  }

  const fys = await owner.get('/setup/financial-years');
  const fyList = fys.body.data ?? fys.body;
  const fy = (Array.isArray(fyList) ? fyList : []).find((f: { isCurrent?: boolean }) => f.isCurrent) ?? fyList?.[0];

  return {
    tenantId,
    gstin,
    stateCode,
    owner,
    ownerEmail: email,
    password: PASSWORD,
    branchId: branch?.id,
    branchCode: branch?.branchCode ?? 'HO',
    fyId: fy?.id,
    fyLabel: fy?.fyLabel,
  };
}

/** Add a user in a given role to an existing tenant and sign them in. */
export async function addUser(t: Tenant, role: string): Promise<Client> {
  const email = `${role.toLowerCase()}-${uniq()}@leoink.test`;
  const created = await t.owner.post('/setup/users', {
    name: `${role} User`,
    email,
    role,
    password: PASSWORD,
  });
  if (created.status >= 400) {
    throw new Error(`could not create ${role} user (${created.status}): ${JSON.stringify(created.body)}`);
  }

  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  if (login.status >= 400) {
    throw new Error(`could not log in ${role} (${login.status}): ${JSON.stringify(login.body)}`);
  }
  return client(login.body.token ?? login.body.data?.token);
}

/** Unwrap `{ data: X }` or a bare `X`. */
export function body<T = Record<string, unknown>>(res: { body: unknown }): T {
  const b = res.body as { data?: unknown };
  if (b && typeof b === 'object' && 'data' in b && !Array.isArray(b.data)) return b.data as T;
  return b as T;
}

/**
 * No-op by design. Every suite shares one Prisma client on one PGlite backend
 * session (see vitest.config.ts); disconnecting after one file would drop the
 * session the next file still needs. The connection dies with the process.
 */
export async function closeDb() {
  void prisma;
}
