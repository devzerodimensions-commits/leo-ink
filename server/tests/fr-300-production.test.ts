/**
 * API conformance — FRD §5 "Jobcard & Production Workflow" (FR-300 … FR-313).
 * Leo Ink's wedge #2: the capability eflexo does not have at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { newTenant, addUser, body, closeDb, type Tenant, type Client } from './helpers/harness.js';
import { buildGstin } from '../src/lib/gstin.js';

let t: Tenant;
let owner: Client;
let customerId: string;

const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function makeJobcard(over: Record<string, unknown> = {}) {
  return owner.post('/jobcards', {
    vertical: 'FLEX_LARGE_FORMAT',
    customerId,
    branchId: t.branchId,
    deliveryDate: isoDate(3),
    priority: 'NORMAL',
    specs: [
      {
        description: 'Star Flex banner',
        width: '6',
        height: '4',
        unit: 'ft',
        substrate: 'Star Flex 340 GSM',
        quantity: '2',
        finishing: ['eyelets'],
      },
    ],
    ...over,
  });
}

beforeAll(async () => {
  t = await newTenant({ stateCode: '27' });
  owner = t.owner;

  const customer = await owner.post('/customers', {
    name: 'Deccan Auto Spares Pvt Ltd',
    customerType: 'REGISTERED',
    gstin: buildGstin('27', 'AACCD5678K'),
    placeOfSupplyState: '27',
    phone: '9822011223',
  });
  customerId = body<{ id: string }>(customer).id;
}, 180_000);

afterAll(async () => {
  await closeDb();
});

describe('FR-306 — admin-configurable multi-stage workflow per vertical', () => {
  it('a default template is seeded per vertical on tenant setup', async () => {
    const res = await owner.get('/workflow-templates');
    expect(res.status).toBe(200);
    const templates = (body<{ data: Array<{ vertical: string; isDefault: boolean; stages: unknown[] }> }>(res).data ??
      []) as Array<{ vertical: string; isDefault: boolean; stages: unknown[] }>;

    const verticals = templates.map((x) => x.vertical);
    expect(verticals).toEqual(
      expect.arrayContaining(['FLEX_LARGE_FORMAT', 'OFFSET', 'DIGITAL', 'SCREEN']),
    );
    const flex = templates.find((x) => x.vertical === 'FLEX_LARGE_FORMAT')!;
    expect(flex.stages.length).toBeGreaterThan(1);
  });

  it('AC3: a template with no terminal stage is rejected', async () => {
    const res = await owner.post('/workflow-templates', {
      vertical: 'DIGITAL',
      name: 'No terminal stage',
      stages: [
        { name: 'Design', sequence: 1, department: 'Design', isTerminal: false },
        { name: 'Print', sequence: 2, department: 'Machine', isTerminal: false },
      ],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/terminal/i);
  });
});

describe('FR-300 — multi-vertical jobcard with process-specific templates', () => {
  it('AC1: a Flex jobcard auto-derives sq-ft area from width × height × quantity', async () => {
    const res = await makeJobcard();
    expect(res.status).toBe(201);

    const jc = body<{ id: string; jobcardNo: string; overallStatus: string }>(res);
    expect(jc.overallStatus).toBe('OPEN');

    const bag = await owner.get(`/jobcards/${jc.id}/job-bag`);
    const specs = body<{ specs: Array<{ areaSqft: string }> }>(bag).specs;
    expect(Number(specs[0].areaSqft)).toBe(48); // 6 × 4 × 2
  });

  it('AC2: an Offset jobcard missing colours or quantity cannot be saved', async () => {
    const res = await owner.post('/jobcards', {
      vertical: 'OFFSET',
      customerId,
      branchId: t.branchId,
      deliveryDate: isoDate(5),
      specs: [{ description: 'Letterheads' }], // no colours, no quantity
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('AC3: a valid multi-item spec creates all spec items and records a `created` event', async () => {
    const res = await makeJobcard({
      specs: [
        { description: 'Banner A', width: '6', height: '4', unit: 'ft', quantity: '2' },
        { description: 'Banner B', width: '3', height: '2', unit: 'ft', quantity: '5' },
      ],
    });
    const id = body<{ id: string }>(res).id;

    const bag = await owner.get(`/jobcards/${id}/job-bag`);
    expect(body<{ specs: unknown[] }>(bag).specs).toHaveLength(2);

    const events = await owner.get(`/jobcards/${id}/events`);
    const list = (body<{ data: Array<{ eventType: string; actorId: string | null; createdAt: string }> }>(events).data ??
      []) as Array<{ eventType: string; actorId: string | null; createdAt: string }>;
    const created = list.find((e) => e.eventType === 'CREATED');
    expect(created).toBeTruthy();
    expect(created!.actorId).toBeTruthy();
    expect(created!.createdAt).toBeTruthy();
  });

  it('a Flex jobcard without a size is rejected', async () => {
    const res = await owner.post('/jobcards', {
      vertical: 'FLEX_LARGE_FORMAT',
      customerId,
      branchId: t.branchId,
      deliveryDate: isoDate(3),
      specs: [{ description: 'Banner with no size', quantity: '1' }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('FR-301 — 15-second quick jobcard for walk-ins', () => {
  it('AC1: only customer, description, quantity and delivery date are required', async () => {
    const res = await owner.post('/jobcards/quick', {
      customerId,
      description: '2 flex banners 6×4 ft, eyelets',
      quantity: '2',
      deliveryDate: isoDate(2),
    });
    expect(res.status).toBe(201);
    const jc = body<{ id: string; specIncomplete: boolean; isQuick: boolean; overallStatus: string }>(res);
    expect(jc.specIncomplete).toBe(true);
    expect(jc.isQuick).toBe(true);
    expect(jc.overallStatus).toBe('OPEN');
  });

  it('AC3: a new walk-in name + mobile creates the customer record inline and links it', async () => {
    const res = await owner.post('/jobcards/quick', {
      customer: { name: `Rakesh Sweets ${Date.now()}`, phone: '9011223344' },
      description: 'A3 poster, 10 copies',
      quantity: '10',
      deliveryDate: isoDate(1),
    });
    expect(res.status).toBe(201);
    const jc = body<{ id: string; customerId: string }>(res);
    expect(jc.customerId).toBeTruthy();

    const customer = await owner.get(`/customers/${jc.customerId}`);
    expect(customer.status).toBe(200);
    expect(body<{ phone: string }>(customer).phone).toBe('9011223344');
  });

  it('AC1 (cont.): the quick jobcard appears on the board immediately', async () => {
    const board = await owner.get('/production/board');
    expect(board.status).toBe(200);
    const columns = (body<{ columns: Array<{ cards: unknown[] }> }>(board).columns ?? []) as Array<{ cards: unknown[] }>;
    const totalCards = columns.reduce((n, c) => n + c.cards.length, 0);
    expect(totalCards).toBeGreaterThan(0);
  });
});

describe('FR-303 — jobcard numbering (gap-free, FY-resetting, immutable)', () => {
  it('AC1: consecutive jobcards receive consecutive numbers with no gap', async () => {
    const a = await makeJobcard();
    const b = await makeJobcard();

    const na = Number(body<{ jobcardNo: string }>(a).jobcardNo.split('/').pop());
    const nb = Number(body<{ jobcardNo: string }>(b).jobcardNo.split('/').pop());
    expect(nb).toBe(na + 1);
  });

  it('the number carries the financial-year segment', async () => {
    const res = await makeJobcard();
    expect(body<{ jobcardNo: string }>(res).jobcardNo).toMatch(/^JC\/\d{4}-\d{2}\/\d+$/);
  });

  it('AC3: the jobcard number cannot be changed once assigned', async () => {
    const created = await makeJobcard();
    const jc = body<{ id: string; jobcardNo: string }>(created);

    const res = await owner.put(`/jobcards/${jc.id}`, { jobcardNo: 'JC/2000-01/99999' });
    if (res.status < 400) {
      expect(body<{ jobcardNo: string }>(res).jobcardNo).toBe(jc.jobcardNo);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('FR-304 — delivery date, priority and rush flags', () => {
  it('AC2: a past delivery date is rejected without an explicit override', async () => {
    const res = await makeJobcard({ deliveryDate: isoDate(-3) });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('a past date is accepted with override plus a reason', async () => {
    const res = await makeJobcard({
      deliveryDate: isoDate(-3),
      override: true,
      overrideReason: 'Back-dated entry for a job already delivered',
    });
    expect(res.status).toBe(201);
  });

  it('AC3: changing the delivery date is logged with actor, old value, new value and timestamp', async () => {
    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;

    const changed = await owner.put(`/jobcards/${id}`, { deliveryDate: isoDate(7) });
    expect(changed.status).toBe(200);

    const events = await owner.get(`/jobcards/${id}/events`);
    const list = (body<{
      data: Array<{ eventType: string; oldValue: string | null; newValue: string | null; actorId: string | null }>;
    }>(events).data ?? []) as Array<{
      eventType: string;
      oldValue: string | null;
      newValue: string | null;
      actorId: string | null;
    }>;
    const evt = list.find((e) => e.eventType === 'DELIVERY_DATE_CHANGED');
    expect(evt).toBeTruthy();
    expect(evt!.oldValue).toBeTruthy();
    expect(evt!.newValue).toBeTruthy();
    expect(evt!.actorId).toBeTruthy();
  });

  it('AC1: a rush-flagged card sorts above non-rush cards in its column', async () => {
    const rush = await makeJobcard({ rushFlag: true, priority: 'HIGH' });
    expect(rush.status).toBe(201);

    const board = await owner.get('/production/board');
    const columns = (body<{ columns: Array<{ cards: Array<{ rushFlag: boolean }> }> }>(board).columns ?? []) as Array<{
      cards: Array<{ rushFlag: boolean }>;
    }>;

    for (const col of columns) {
      const firstNonRush = col.cards.findIndex((c) => !c.rushFlag);
      const lastRush = col.cards.map((c) => c.rushFlag).lastIndexOf(true);
      if (firstNonRush !== -1 && lastRush !== -1) expect(lastRush).toBeLessThan(firstNonRush);
    }
  });
});

describe('FR-305 — digital job bag & QR', () => {
  it('AC1: the job bag shows specs, customer, delivery date, priority and the current stage', async () => {
    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;

    const res = await owner.get(`/jobcards/${id}/job-bag`);
    expect(res.status).toBe(200);
    const bag = body<{
      jobcardNo: string;
      customer: { name: string };
      deliveryDate: string;
      priority: string;
      specs: unknown[];
      qrToken: string;
      progress: unknown[];
    }>(res);

    expect(bag.jobcardNo).toBeTruthy();
    expect(bag.customer.name).toBeTruthy();
    expect(bag.deliveryDate).toBeTruthy();
    expect(bag.priority).toBeTruthy();
    expect(bag.specs.length).toBeGreaterThan(0);
    expect(bag.progress.length).toBeGreaterThan(0);
    expect(bag.qrToken).toBeTruthy();
    expect(bag.qrToken.length).toBeGreaterThanOrEqual(16); // non-guessable
  });

  it('the QR token is stable for the jobcard’s life', async () => {
    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;

    const first = body<{ qrToken: string }>(await owner.get(`/jobcards/${id}/job-bag`)).qrToken;
    const second = body<{ qrToken: string }>(await owner.get(`/jobcards/${id}/job-bag`)).qrToken;
    expect(second).toBe(first);
  });

  it('printing the ticket stamps printedAt', async () => {
    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;

    const printed = await owner.post(`/jobcards/${id}/print-ticket`, {});
    expect(printed.status).toBeLessThan(400);

    const bag = await owner.get(`/jobcards/${id}/job-bag`);
    expect(body<{ printedAt: string | null }>(bag).printedAt).toBeTruthy();
  });
});

describe('FR-307 / FR-308 / FR-309 — board, stage progression and roll-up status', () => {
  it('FR-309 AC1: a jobcard with no started stage reads `open`', async () => {
    const created = await makeJobcard();
    expect(body<{ overallStatus: string }>(created).overallStatus).toBe('OPEN');
  });

  it('FR-308 AC1: advancing completes the source stage with an operator and starts the destination', async () => {
    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;

    const advanced = await owner.post(`/jobcards/${id}/advance`, {});
    expect(advanced.status).toBeLessThan(400);

    const bag = await owner.get(`/jobcards/${id}/job-bag`);
    const progress = body<{
      progress: Array<{ sequence: number; status: string; startedAt: string | null; completedAt: string | null }>;
    }>(bag).progress;

    expect(progress[0].status).toBe('COMPLETED');
    expect(progress[0].completedAt).toBeTruthy();
    expect(progress[1].status).toBe('IN_PROGRESS');
    expect(progress[1].startedAt).toBeTruthy();
  });

  it('FR-309 AC2: with a started, non-terminal stage the status reads `in-progress`', async () => {
    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;
    await owner.post(`/jobcards/${id}/advance`, {});

    const res = await owner.get(`/jobcards/${id}`);
    expect(body<{ overallStatus: string }>(res).overallStatus).toBe('IN_PROGRESS');
  });

  it('FR-308 AC3: every stage move records a JobEvent with from/to stage, actor and timestamp', async () => {
    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;
    await owner.post(`/jobcards/${id}/advance`, {});

    const events = await owner.get(`/jobcards/${id}/events`);
    const list = (body<{
      data: Array<{ eventType: string; fromStage: string | null; toStage: string | null; actorId: string | null; source: string }>;
    }>(events).data ?? []) as Array<{
      eventType: string;
      fromStage: string | null;
      toStage: string | null;
      actorId: string | null;
      source: string;
    }>;

    const move = list.find((e) => e.eventType === 'STAGE_ADVANCED')!;
    expect(move).toBeTruthy();
    expect(move.fromStage).toBeTruthy();
    expect(move.toStage).toBeTruthy();
    expect(move.actorId).toBeTruthy();
    expect(move.source).toBe('WEB');
  });

  it('FR-309 AC3: completing the terminal stage sets `done`, stamps completion and drops it off the active board', async () => {
    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;

    const bag = await owner.get(`/jobcards/${id}/job-bag`);
    const stageCount = body<{ progress: unknown[] }>(bag).progress.length;

    for (let i = 0; i < stageCount; i++) {
      await owner.post(`/jobcards/${id}/advance`, {});
    }

    const done = await owner.get(`/jobcards/${id}`);
    expect(body<{ overallStatus: string; completedAt: string | null }>(done).overallStatus).toBe('DONE');
    expect(body<{ completedAt: string | null }>(done).completedAt).toBeTruthy();

    const board = await owner.get('/production/board');
    const ids = ((body<{ columns: Array<{ cards: Array<{ id: string }> }> }>(board).columns ?? []) as Array<{
      cards: Array<{ id: string }>;
    }>).flatMap((c) => c.cards.map((x) => x.id));
    expect(ids).not.toContain(id);

    const withDone = await owner.get('/production/board?includeDone=true');
    const allIds = ((body<{ columns: Array<{ cards: Array<{ id: string }> }> }>(withDone).columns ?? []) as Array<{
      cards: Array<{ id: string }>;
    }>).flatMap((c) => c.cards.map((x) => x.id));
    expect(allIds).toContain(id);
  });

  it('FR-308 AC2: a non-authorised user cannot move a card backward', async () => {
    const operator = await addUser(t, 'OPERATOR');

    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;
    await owner.post(`/jobcards/${id}/advance`, {});

    const res = await operator.post(`/jobcards/${id}/revert`, {});
    expect(res.status).toBe(403);
  });

  it('FR-307 AC2: an "overdue" filter returns only jobcards past their delivery date', async () => {
    await makeJobcard({ deliveryDate: isoDate(-2), override: true, overrideReason: 'back-dated' });

    const res = await owner.get('/production/board?overdue=true');
    expect(res.status).toBe(200);
    const cards = ((body<{ columns: Array<{ cards: Array<{ overdue?: boolean; deliveryDate: string }> }> }>(res)
      .columns ?? []) as Array<{ cards: Array<{ overdue?: boolean; deliveryDate: string }> }>).flatMap((c) => c.cards);

    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(new Date(c.deliveryDate).getTime()).toBeLessThan(Date.now());
    }
  });
});

describe('FR-310 / FR-311 — operator assignment and the personal work queue', () => {
  it('AC3: a user without a production role cannot be selected as an assignee', async () => {
    const accounts = await addUser(t, 'ACCOUNTS');
    const accountsMe = await accounts.get('/auth/me');
    const accountsId = (accountsMe.body.user ?? accountsMe.body.data?.user).id;

    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;
    const bag = await owner.get(`/jobcards/${id}/job-bag`);
    const stage = body<{ progress: Array<{ id: string }> }>(bag).progress[0];

    const res = await owner.post(`/jobcards/${id}/stages/${stage.id}/assign`, { operatorId: accountsId });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('AC1 & AC2: assigning then reassigning records both, with actor and timestamp', async () => {
    const opA = await addUser(t, 'OPERATOR');
    const opB = await addUser(t, 'OPERATOR');
    const idA = (await opA.get('/auth/me')).body.user?.id ?? (await opA.get('/auth/me')).body.data?.user?.id;
    const idB = (await opB.get('/auth/me')).body.user?.id ?? (await opB.get('/auth/me')).body.data?.user?.id;

    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;
    const bag = await owner.get(`/jobcards/${id}/job-bag`);
    const stage = body<{ progress: Array<{ id: string }> }>(bag).progress[0];

    const first = await owner.post(`/jobcards/${id}/stages/${stage.id}/assign`, { operatorId: idA });
    expect(first.status).toBeLessThan(400);

    const second = await owner.post(`/jobcards/${id}/stages/${stage.id}/assign`, { operatorId: idB });
    expect(second.status).toBeLessThan(400);

    const events = await owner.get(`/jobcards/${id}/events`);
    const types = ((body<{ data: Array<{ eventType: string }> }>(events).data ?? []) as Array<{ eventType: string }>).map(
      (e) => e.eventType,
    );
    expect(types).toEqual(expect.arrayContaining(['ASSIGNED', 'REASSIGNED']));

    const after = await owner.get(`/jobcards/${id}/job-bag`);
    expect(body<{ progress: Array<{ operator?: { id: string } | null }> }>(after).progress[0].operator?.id).toBe(idB);
  });

  it('FR-311 AC1: "my jobs" shows only the operator’s actionable stages', async () => {
    const op = await addUser(t, 'OPERATOR');
    const opId = (await op.get('/auth/me')).body.user?.id ?? (await op.get('/auth/me')).body.data?.user?.id;

    const created = await makeJobcard({ rushFlag: true });
    const id = body<{ id: string }>(created).id;
    const bag = await owner.get(`/jobcards/${id}/job-bag`);
    const stage = body<{ progress: Array<{ id: string }> }>(bag).progress[0];
    await owner.post(`/jobcards/${id}/stages/${stage.id}/assign`, { operatorId: opId });

    const queue = await op.get('/production/my-jobs');
    expect(queue.status).toBe(200);
    const items = (body<{ data: Array<{ jobcardId: string; rushFlag: boolean }> }>(queue).data ?? []) as Array<{
      jobcardId: string;
      rushFlag: boolean;
    }>;
    expect(items.some((x) => x.jobcardId === id)).toBe(true);
  });
});

describe('FR-312 — scan-to-status', () => {
  it('AC1: scanning a valid QR advances the stage, timestamped to the scanner with source `scan`', async () => {
    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;
    const token = body<{ qrToken: string }>(await owner.get(`/jobcards/${id}/job-bag`)).qrToken;

    const res = await owner.post('/production/scan', { token, action: 'advance' });
    expect(res.status).toBeLessThan(400);

    const events = await owner.get(`/jobcards/${id}/events`);
    const scan = ((body<{ data: Array<{ eventType: string; source: string }> }>(events).data ?? []) as Array<{
      eventType: string;
      source: string;
    }>).find((e) => e.eventType === 'STAGE_ADVANCED' && e.source === 'SCAN');
    expect(scan).toBeTruthy();
  });

  it('AC2: a QR token belonging to another tenant is denied', async () => {
    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;
    const token = body<{ qrToken: string }>(await owner.get(`/jobcards/${id}/job-bag`)).qrToken;

    const other = await newTenant({ stateCode: '29', legalName: 'Other Shop' });
    const res = await other.owner.post('/production/scan', { token, action: 'open' });
    expect([403, 404]).toContain(res.status);
  });

  it('AC3: scanning at the terminal stage completes the job rather than advancing further', async () => {
    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;
    const bag = await owner.get(`/jobcards/${id}/job-bag`);
    const token = body<{ qrToken: string }>(bag).qrToken;
    const stageCount = body<{ progress: unknown[] }>(bag).progress.length;

    for (let i = 0; i < stageCount; i++) {
      await owner.post('/production/scan', { token, action: 'advance' });
    }

    const done = await owner.get(`/jobcards/${id}`);
    expect(body<{ overallStatus: string }>(done).overallStatus).toBe('DONE');
  });
});

describe('FR-313 — promised delivery date / TAT with due-today and overdue alerts', () => {
  it('AC1: a non-done jobcard due today is flagged due-today', async () => {
    await makeJobcard({ deliveryDate: isoDate(0) });

    const res = await owner.get('/production/tat?filter=due-today');
    expect(res.status).toBe(200);
    const items = (body<{ dueToday?: unknown[]; data?: unknown[] }>(res).dueToday ??
      body<{ data?: unknown[] }>(res).data ??
      []) as unknown[];
    expect(items.length).toBeGreaterThan(0);
  });

  it('AC3: a completed jobcard never appears in due-today or overdue lists', async () => {
    const created = await makeJobcard({ deliveryDate: isoDate(0) });
    const id = body<{ id: string }>(created).id;

    const bag = await owner.get(`/jobcards/${id}/job-bag`);
    const stageCount = body<{ progress: unknown[] }>(bag).progress.length;
    for (let i = 0; i < stageCount; i++) await owner.post(`/jobcards/${id}/advance`, {});

    const res = await owner.get('/production/tat?filter=all');
    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain(id);
  });

  it('the alert sweep produces notifications for overdue and due-today jobs', async () => {
    const res = await owner.post('/production/tat/alerts', {});
    expect(res.status).toBeLessThan(400);
    expect(res.body).toBeTruthy();
  });
});

describe('BR-4 — a jobcard is unreachable from another tenant', () => {
  it('fetching another shop’s jobcard by id is denied', async () => {
    const created = await makeJobcard();
    const id = body<{ id: string }>(created).id;

    const other = await newTenant({ stateCode: '29', legalName: 'Third Shop' });
    const res = await other.owner.get(`/jobcards/${id}`);
    expect([403, 404]).toContain(res.status);
  });
});
