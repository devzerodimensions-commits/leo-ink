/**
 * CRM services — FRD §4.1 (FR-200 enquiry inbox, FR-203 follow-ups) plus the
 * FR-220 one-click enquiry → quotation conversion.
 *
 * BR-4  — every query filters on `tenantId`; another tenant's id 404s.
 * BR-9  — status changes and conversions are audited.
 */
import type { Customer, Enquiry, EnquiryStatus, FollowUp, Prisma, User, Vertical } from '@prisma/client';
import { prisma } from '../../db.js';
import type { AuthContext } from '../../auth/middleware.js';
import { notFound, unprocessable } from '../../http/errors.js';
import { money } from '../../lib/money.js';
import { recordAudit } from '../setup/audit.js';
import { createQuote } from '../quotes/service.js';
import type {
  ConvertToQuoteInput,
  EnquiryCreateInput,
  EnquiryIntakeInput,
  EnquiryListQuery,
  EnquiryUpdateInput,
  FollowUpCloseInput,
  FollowUpCreateInput,
  FollowUpListQuery,
  FollowUpNotifyInput,
} from './schemas.js';

const isoTs = (d: Date): string => d.toISOString();
const isoTsN = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const parseIsoDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

function nullable(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** FR-200 — an enquiry that has not yet reached a terminal outcome. */
const OPEN_STATUSES: EnquiryStatus[] = ['NEW', 'CONTACTED', 'QUOTED'];

const VERTICAL_LABEL: Record<Vertical, string> = {
  FLEX_LARGE_FORMAT: 'Flex / large-format',
  OFFSET: 'Offset printing',
  DIGITAL: 'Digital printing',
  SCREEN: 'Screen printing',
};

export interface Warning {
  code: string;
  message: string;
  details?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialisers
// ─────────────────────────────────────────────────────────────────────────────

type EnquiryRecord = Enquiry & {
  customer?: Customer | null;
  assignee?: Pick<User, 'id' | 'name' | 'email'> | null;
  quotes?: Array<{ id: string; quoteNo: string | null; status: string; grandTotal: { toString(): string } }>;
};

export function serializeEnquiry(e: EnquiryRecord) {
  return {
    id: e.id,
    source: e.source,
    status: e.status,
    contactName: e.contactName,
    phone: e.phone,
    email: e.email,
    /** FR-200 — "product type (flex/large-format | offset | digital | screen)". */
    vertical: e.vertical,
    verticalLabel: VERTICAL_LABEL[e.vertical],
    description: e.description,
    lostReason: e.lostReason,
    customerId: e.customerId,
    customer: e.customer
      ? {
          id: e.customer.id,
          name: e.customer.name,
          phone: e.customer.phone,
          email: e.customer.email,
          placeOfSupplyState: e.customer.placeOfSupplyState,
        }
      : null,
    assignedTo: e.assignedTo,
    assignee: e.assignee ? { id: e.assignee.id, name: e.assignee.name, email: e.assignee.email } : null,
    receivedAt: isoTs(e.receivedAt),
    createdAt: isoTs(e.createdAt),
    updatedAt: isoTs(e.updatedAt),
    /** FR-220 — bi-directional trace back to the quotes raised from this enquiry. */
    quotes: (e.quotes ?? []).map((q) => ({
      id: q.id,
      quoteNo: q.quoteNo,
      status: q.status,
      grandTotal: money(q.grandTotal.toString()), // BR-1
    })),
  };
}

type FollowUpRecord = FollowUp & {
  assignee?: Pick<User, 'id' | 'name' | 'email' | 'phone'> | null;
  enquiry?: Pick<Enquiry, 'id' | 'contactName' | 'phone' | 'status'> | null;
  quote?: { id: string; quoteNo: string | null; status: string } | null;
};

export function serializeFollowUp(f: FollowUpRecord, now: Date) {
  return {
    id: f.id,
    parentType: f.enquiryId ? ('ENQUIRY' as const) : ('QUOTE' as const),
    enquiryId: f.enquiryId,
    quoteId: f.quoteId,
    dueAt: isoTs(f.dueAt),
    note: f.note,
    assignedTo: f.assignedTo,
    assignee: f.assignee
      ? { id: f.assignee.id, name: f.assignee.name, email: f.assignee.email, phone: f.assignee.phone }
      : null,
    status: f.status,
    outcome: f.outcome,
    closedAt: isoTsN(f.closedAt),
    notifiedAt: isoTsN(f.notifiedAt),
    /** FR-203 — "overdue items are flagged in the worklist". */
    overdue: f.status === 'OPEN' && f.dueAt.getTime() < now.getTime(),
    enquiry: f.enquiry
      ? { id: f.enquiry.id, contactName: f.enquiry.contactName, phone: f.enquiry.phone, status: f.enquiry.status }
      : null,
    quote: f.quote ? { id: f.quote.id, quoteNo: f.quote.quoteNo, status: f.quote.status } : null,
    createdAt: isoTs(f.createdAt),
    updatedAt: isoTs(f.updatedAt),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookups
// ─────────────────────────────────────────────────────────────────────────────

const ENQUIRY_INCLUDE = {
  customer: true,
  assignee: { select: { id: true, name: true, email: true } },
  quotes: {
    select: { id: true, quoteNo: true, status: true, grandTotal: true },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.EnquiryInclude;

const FOLLOWUP_INCLUDE = {
  assignee: { select: { id: true, name: true, email: true, phone: true } },
  enquiry: { select: { id: true, contactName: true, phone: true, status: true } },
  quote: { select: { id: true, quoteNo: true, status: true } },
} satisfies Prisma.FollowUpInclude;

async function loadEnquiry(auth: AuthContext, id: string) {
  // BR-4 — never leak another tenant's enquiry.
  const enquiry = await prisma.enquiry.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: ENQUIRY_INCLUDE,
  });
  if (!enquiry) throw notFound('Enquiry not found');
  return enquiry;
}

async function assertCustomer(tenantId: string, customerId: string): Promise<Customer> {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId } });
  if (!customer) throw unprocessable('Unknown customer', 'UNKNOWN_CUSTOMER');
  return customer;
}

async function assertUser(tenantId: string, userId: string): Promise<User> {
  const user = await prisma.user.findFirst({ where: { id: userId, tenantId } });
  if (!user) throw unprocessable('Unknown assignee', 'UNKNOWN_USER');
  return user;
}

/** Compare on the last 10 digits so +91 / 0-prefixed forms of one number match. */
function phoneTail(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * FR-200 — "a WhatsApp/phone number matching an existing Customer/Contact
 * auto-suggests the link."
 */
async function suggestCustomer(tenantId: string, phone: string) {
  const tail = phoneTail(phone);
  if (tail.length === 0) return null;

  const direct = await prisma.customer.findFirst({
    where: { tenantId, OR: [{ phone }, { phone: { contains: tail } }] },
    orderBy: { createdAt: 'asc' },
  });
  if (direct) {
    return { id: direct.id, name: direct.name, phone: direct.phone, email: direct.email, matchedOn: 'CUSTOMER' as const };
  }

  const contact = await prisma.customerContact.findFirst({
    where: { tenantId, OR: [{ phone }, { phone: { contains: tail } }] },
    include: { customer: true },
    orderBy: { createdAt: 'asc' },
  });
  if (contact) {
    return {
      id: contact.customer.id,
      name: contact.customer.name,
      phone: contact.phone,
      email: contact.email,
      matchedOn: 'CONTACT' as const,
      contactName: contact.name,
    };
  }
  return null;
}

/**
 * FR-200 — "if an open enquiry with the same phone + product_type exists, the
 * system flags a possible duplicate (does not block)."
 */
async function duplicateWarnings(
  tenantId: string,
  phone: string,
  vertical: Vertical,
  excludeId?: string,
): Promise<Warning[]> {
  const tail = phoneTail(phone);
  const matches = await prisma.enquiry.findMany({
    where: {
      tenantId,
      vertical,
      status: { in: OPEN_STATUSES },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      ...(tail.length > 0 ? { OR: [{ phone }, { phone: { contains: tail } }] } : { phone }),
    },
    select: { id: true, contactName: true, status: true, receivedAt: true },
    orderBy: { receivedAt: 'desc' },
    take: 10,
  });

  if (matches.length === 0) return [];
  return [
    {
      code: 'POSSIBLE_DUPLICATE',
      message: `${matches.length} open ${VERTICAL_LABEL[vertical]} enquiry(ies) already exist for ${phone}`,
      details: {
        enquiries: matches.map((m) => ({
          id: m.id,
          contactName: m.contactName,
          status: m.status,
          receivedAt: isoTs(m.receivedAt),
        })),
      },
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-200 — enquiry inbox
// ─────────────────────────────────────────────────────────────────────────────

export async function listEnquiries(auth: AuthContext, query: EnquiryListQuery) {
  const where: Prisma.EnquiryWhereInput = {
    tenantId: auth.tenantId, // BR-4
    ...(query.source ? { source: query.source } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.vertical ? { vertical: query.vertical } : {}),
    ...(query.assignedTo ? { assignedTo: query.assignedTo } : {}),
    ...(query.customerId ? { customerId: query.customerId } : {}),
    ...(query.open ? { status: { in: OPEN_STATUSES } } : {}),
    ...(query.from || query.to
      ? {
          receivedAt: {
            ...(query.from ? { gte: parseIsoDate(query.from) } : {}),
            ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
          },
        }
      : {}),
    ...(query.q
      ? {
          OR: [
            { contactName: { contains: query.q, mode: 'insensitive' } },
            { phone: { contains: query.q } },
            { email: { contains: query.q, mode: 'insensitive' } },
            { description: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.enquiry.findMany({
      where,
      include: ENQUIRY_INCLUDE,
      orderBy: [{ receivedAt: 'desc' }, { createdAt: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.enquiry.count({ where }),
  ]);

  return { data: rows.map(serializeEnquiry), page: query.page, pageSize: query.pageSize, total };
}

export async function getEnquiry(auth: AuthContext, id: string) {
  const enquiry = await loadEnquiry(auth, id);
  const followUps = await prisma.followUp.findMany({
    where: { tenantId: auth.tenantId, enquiryId: id },
    include: FOLLOWUP_INCLUDE,
    orderBy: { dueAt: 'asc' },
  });
  const now = new Date();
  return {
    ...serializeEnquiry(enquiry),
    followUps: followUps.map((f) => serializeFollowUp(f, now)),
    suggestedCustomer: enquiry.customerId ? null : await suggestCustomer(auth.tenantId, enquiry.phone),
  };
}

interface EnquiryWriteArgs {
  source: EnquiryCreateInput['source'];
  contactName: string;
  phone: string;
  email: string | null;
  vertical: Vertical;
  description: string | null;
  customerId: string | null;
  assignedTo: string | null;
  receivedAt: Date;
  status: EnquiryStatus;
  lostReason: string | null;
}

async function insertEnquiry(auth: AuthContext, args: EnquiryWriteArgs) {
  if (args.customerId) await assertCustomer(auth.tenantId, args.customerId);
  if (args.assignedTo) await assertUser(auth.tenantId, args.assignedTo);
  // FR-200 — "Lost requires a reason."
  if (args.status === 'LOST' && !args.lostReason) {
    throw unprocessable('A reason is required when an enquiry is marked Lost', 'LOST_REASON_REQUIRED');
  }

  // Duplicate detection runs before the insert so the new row never matches itself.
  const warnings = await duplicateWarnings(auth.tenantId, args.phone, args.vertical);
  const suggestedCustomer = args.customerId ? null : await suggestCustomer(auth.tenantId, args.phone);

  const created = await prisma.enquiry.create({
    data: {
      tenantId: auth.tenantId,
      source: args.source,
      contactName: args.contactName,
      phone: args.phone,
      email: args.email,
      vertical: args.vertical,
      description: args.description,
      customerId: args.customerId,
      assignedTo: args.assignedTo,
      receivedAt: args.receivedAt,
      status: args.status,
      lostReason: args.lostReason,
    },
    include: ENQUIRY_INCLUDE,
  });

  const dto = serializeEnquiry(created);
  await recordAudit({
    tenantId: auth.tenantId,
    actorId: auth.userId,
    entityType: 'Enquiry',
    entityId: created.id,
    action: 'CREATE',
    after: dto,
  });

  // FR-200 AC 4 — "a duplicate warning is shown but the save succeeds".
  return { ...dto, warnings, suggestedCustomer };
}

export async function createEnquiry(auth: AuthContext, input: EnquiryCreateInput) {
  return insertEnquiry(auth, {
    source: input.source,
    contactName: input.contactName,
    phone: input.phone,
    email: nullable(input.email),
    vertical: input.vertical,
    description: nullable(input.description),
    customerId: input.customerId ?? null,
    assignedTo: input.assignedTo ?? null,
    receivedAt: input.receivedAt ?? new Date(),
    status: input.status ?? 'NEW',
    lostReason: nullable(input.lostReason),
  });
}

/**
 * FR-200 — "Inbound web-form and WhatsApp enquiries auto-create an enquiry with
 * source set accordingly." Public-shaped, but Phase 1 still requires auth.
 */
export async function intakeEnquiry(auth: AuthContext, input: EnquiryIntakeInput) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { defaultVertical: true },
  });
  if (!tenant) throw notFound('Tenant not found');

  const contactName = input.contactName ?? input.name;
  if (!contactName) throw unprocessable('A contact name is required', 'CONTACT_NAME_REQUIRED');

  return insertEnquiry(auth, {
    source: input.source ?? 'WEB_FORM',
    contactName,
    phone: input.phone,
    email: nullable(input.email),
    vertical: input.vertical ?? input.productType ?? tenant.defaultVertical,
    description: nullable(input.description ?? input.message),
    customerId: null,
    assignedTo: input.assignedTo ?? null,
    receivedAt: input.receivedAt ?? new Date(),
    // FR-200 — "New enquiry default status = New."
    status: 'NEW',
    lostReason: null,
  });
}

/** FR-200 — "New → Contacted → Quoted → Won → Lost". Won/Lost are terminal. */
const ENQUIRY_TRANSITIONS: Record<EnquiryStatus, EnquiryStatus[]> = {
  NEW: ['CONTACTED', 'QUOTED', 'LOST'],
  CONTACTED: ['QUOTED', 'LOST'],
  QUOTED: ['WON', 'LOST'],
  WON: [],
  LOST: [],
};

export async function updateEnquiry(auth: AuthContext, id: string, patch: EnquiryUpdateInput) {
  const existing = await loadEnquiry(auth, id);
  const before = serializeEnquiry(existing);

  const status = patch.status ?? existing.status;
  if (patch.status && patch.status !== existing.status) {
    if (!ENQUIRY_TRANSITIONS[existing.status].includes(patch.status)) {
      throw unprocessable(
        `An enquiry cannot move from ${existing.status} to ${patch.status}`,
        'INVALID_TRANSITION',
        { from: existing.status, to: patch.status, allowed: ENQUIRY_TRANSITIONS[existing.status] },
      );
    }
  }

  // FR-200 — "Lost requires a reason."
  const lostReason = patch.lostReason !== undefined ? nullable(patch.lostReason) : existing.lostReason;
  if (status === 'LOST' && !lostReason) {
    throw unprocessable('A reason is required when an enquiry is marked Lost', 'LOST_REASON_REQUIRED');
  }

  if (patch.customerId) await assertCustomer(auth.tenantId, patch.customerId);
  if (patch.assignedTo) await assertUser(auth.tenantId, patch.assignedTo);

  const updated = await prisma.enquiry.update({
    where: { id },
    data: {
      ...(patch.source !== undefined ? { source: patch.source } : {}),
      ...(patch.contactName !== undefined ? { contactName: patch.contactName } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      ...(patch.email !== undefined ? { email: nullable(patch.email) } : {}),
      ...(patch.vertical !== undefined ? { vertical: patch.vertical } : {}),
      ...(patch.description !== undefined ? { description: nullable(patch.description) } : {}),
      ...(patch.customerId !== undefined ? { customerId: patch.customerId ?? null } : {}),
      ...(patch.assignedTo !== undefined ? { assignedTo: patch.assignedTo ?? null } : {}),
      ...(patch.receivedAt !== undefined ? { receivedAt: patch.receivedAt } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.lostReason !== undefined || status === 'LOST' ? { lostReason } : {}),
    },
    include: ENQUIRY_INCLUDE,
  });

  const dto = serializeEnquiry(updated);
  await recordAudit({
    tenantId: auth.tenantId,
    actorId: auth.userId,
    entityType: 'Enquiry',
    entityId: id,
    action: 'UPDATE',
    before,
    after: dto,
  });

  // FR-203 — "marking parent Won/Lost auto-prompts to close open follow-ups".
  const openFollowUps =
    patch.status && (patch.status === 'WON' || patch.status === 'LOST')
      ? await openFollowUpsFor({ tenantId: auth.tenantId, enquiryId: id })
      : [];

  return { ...dto, openFollowUps };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-220 — one-click enquiry → quotation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Converting sets the enquiry status to Quoted and links the new Quote to the
 * originating enquiry … Enquiry description seeds the first quote line's
 * description." The quote itself is built by the quotation module so the shared
 * pricing engine stays the only source of numbers (FR-210).
 */
export async function convertEnquiryToQuote(auth: AuthContext, id: string, input: ConvertToQuoteInput) {
  const enquiry = await loadEnquiry(auth, id);

  const customerId = input.customerId ?? enquiry.customerId;
  // FR-220 AC 2 — "an enquiry with no customer … requires selecting/creating one".
  if (!customerId) {
    throw unprocessable(
      'This enquiry has no linked customer — select or create one before quoting',
      'CUSTOMER_REQUIRED',
      { enquiryId: enquiry.id },
    );
  }
  await assertCustomer(auth.tenantId, customerId);

  if (input.customerId && input.customerId !== enquiry.customerId) {
    await prisma.enquiry.update({ where: { id }, data: { customerId: input.customerId } });
  }

  // FR-220 — the captured description seeds line 1; the wizard (FR-221) completes it.
  const seedDescription = enquiry.description ?? `${VERTICAL_LABEL[enquiry.vertical]} job`;

  const quote = await createQuote(auth, {
    customerId,
    branchId: input.branchId,
    enquiryId: enquiry.id,
    quoteDate: input.quoteDate,
    ...(input.placeOfSupplyState ? { placeOfSupplyState: input.placeOfSupplyState } : {}),
    ...(input.validUntil ? { validUntil: input.validUntil } : {}),
    lines: [{ kind: 'QTY', description: seedDescription, qty: '1', rate: '0', gstPct: '0' }],
  });

  const refreshed = await loadEnquiry(auth, id);
  await recordAudit({
    tenantId: auth.tenantId,
    actorId: auth.userId,
    entityType: 'Enquiry',
    entityId: id,
    action: 'UPDATE',
    before: { status: enquiry.status },
    after: { status: refreshed.status, quoteId: quote.id },
  });

  return { quote, enquiry: serializeEnquiry(refreshed) };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-203 — follow-up reminders & to-dos
// ─────────────────────────────────────────────────────────────────────────────

async function openFollowUpsFor(where: { tenantId: string; enquiryId?: string; quoteId?: string }) {
  const rows = await prisma.followUp.findMany({
    where: { ...where, status: 'OPEN' },
    include: FOLLOWUP_INCLUDE,
    orderBy: { dueAt: 'asc' },
  });
  const now = new Date();
  return rows.map((f) => serializeFollowUp(f, now));
}

export async function createFollowUp(auth: AuthContext, input: FollowUpCreateInput) {
  const enquiryId = input.enquiryId ?? null;
  const quoteId = input.quoteId ?? null;

  // FR-203 — "A follow-up belongs to exactly one parent (enquiry or quote)."
  if (enquiryId && quoteId) {
    throw unprocessable(
      'A follow-up belongs to exactly one parent — pass either enquiryId or quoteId, not both',
      'PARENT_AMBIGUOUS',
    );
  }
  if (!enquiryId && !quoteId) {
    throw unprocessable(
      'A follow-up needs a parent — pass either enquiryId or quoteId',
      'PARENT_REQUIRED',
    );
  }

  if (enquiryId) {
    const parent = await prisma.enquiry.findFirst({
      where: { id: enquiryId, tenantId: auth.tenantId },
      select: { id: true },
    });
    if (!parent) throw unprocessable('Unknown enquiry', 'UNKNOWN_ENQUIRY');
  }
  if (quoteId) {
    const parent = await prisma.quote.findFirst({
      where: { id: quoteId, tenantId: auth.tenantId },
      select: { id: true },
    });
    if (!parent) throw unprocessable('Unknown quotation', 'UNKNOWN_QUOTE');
  }

  const assignedTo = input.assignedTo ?? auth.userId;
  await assertUser(auth.tenantId, assignedTo);

  const created = await prisma.followUp.create({
    data: {
      tenantId: auth.tenantId,
      enquiryId,
      quoteId,
      dueAt: input.dueAt,
      note: input.note,
      assignedTo,
      status: 'OPEN',
    },
    include: FOLLOWUP_INCLUDE,
  });

  await recordAudit({
    tenantId: auth.tenantId,
    actorId: auth.userId,
    entityType: 'FollowUp',
    entityId: created.id,
    action: 'CREATE',
    after: { enquiryId, quoteId, dueAt: isoTs(created.dueAt), assignedTo },
  });

  return serializeFollowUp(created, new Date());
}

function followUpWhere(auth: AuthContext, query: FollowUpListQuery, now: Date): Prisma.FollowUpWhereInput {
  const status = query.status ?? 'OPEN';
  return {
    tenantId: auth.tenantId, // BR-4
    ...(status === 'ALL' ? {} : { status }),
    ...(query.assignedTo ? { assignedTo: query.assignedTo } : {}),
    ...(query.enquiryId ? { enquiryId: query.enquiryId } : {}),
    ...(query.quoteId ? { quoteId: query.quoteId } : {}),
    ...(query.overdue ? { dueAt: { lt: now }, status: 'OPEN' } : {}),
  };
}

export async function listFollowUps(auth: AuthContext, query: FollowUpListQuery) {
  const now = new Date();
  const where = followUpWhere(auth, query, now);

  const [rows, total] = await Promise.all([
    prisma.followUp.findMany({
      where,
      include: FOLLOWUP_INCLUDE,
      orderBy: [{ dueAt: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.followUp.count({ where }),
  ]);

  const data = rows.map((f) => serializeFollowUp(f, now));
  return {
    data,
    page: query.page,
    pageSize: query.pageSize,
    total,
    overdueCount: data.filter((f) => f.overdue).length,
  };
}

/** FR-203 — the "My Follow-ups" worklist. */
export async function myFollowUps(auth: AuthContext, query: FollowUpListQuery) {
  return listFollowUps(auth, { ...query, assignedTo: auth.userId });
}

/**
 * FR-203 — "On due_at, the system notifies the assignee." This endpoint is the
 * scheduler's queue: due, still open, not yet notified.
 */
export async function dueFollowUps(auth: AuthContext, query: FollowUpListQuery) {
  const now = new Date();
  const where: Prisma.FollowUpWhereInput = {
    tenantId: auth.tenantId,
    status: 'OPEN',
    dueAt: { lte: now },
    notifiedAt: null,
    ...(query.assignedTo ? { assignedTo: query.assignedTo } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.followUp.findMany({
      where,
      include: FOLLOWUP_INCLUDE,
      orderBy: [{ dueAt: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.followUp.count({ where }),
  ]);

  return {
    asOn: isoTs(now),
    data: rows.map((f) => serializeFollowUp(f, now)),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

async function loadFollowUp(auth: AuthContext, id: string) {
  const followUp = await prisma.followUp.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: FOLLOWUP_INCLUDE,
  });
  if (!followUp) throw notFound('Follow-up not found');
  return followUp;
}

/**
 * FR-203 — "the system notifies the assignee via in-app notification and
 * WhatsApp (primary channel)". Phase 1 records the outbound message and stamps
 * notifiedAt so the sweep never double-notifies.
 */
export async function notifyFollowUp(auth: AuthContext, id: string, input: FollowUpNotifyInput) {
  const followUp = await loadFollowUp(auth, id);
  const assignee = await assertUser(auth.tenantId, followUp.assignedTo);

  const toAddress = input.toAddress ?? assignee.phone ?? assignee.email;
  const now = new Date();
  const body =
    input.message ??
    `Follow-up due ${isoTs(followUp.dueAt)}: ${followUp.note}`;

  const updated = await prisma.$transaction(async (tx) => {
    await tx.messageLog.create({
      data: {
        tenantId: auth.tenantId,
        channel: 'WHATSAPP',
        toAddress,
        entityType: 'FollowUp',
        entityId: followUp.id,
        quoteId: followUp.quoteId,
        body,
        status: 'SENT',
        sentAt: now,
      },
    });
    return tx.followUp.update({
      where: { id },
      data: { notifiedAt: now },
      include: FOLLOWUP_INCLUDE,
    });
  });

  return {
    ...serializeFollowUp(updated, now),
    notification: { channel: 'WHATSAPP' as const, toAddress, body, sentAt: isoTs(now), status: 'SENT' },
  };
}

/** FR-203 — "Closing a follow-up requires an outcome note." */
export async function closeFollowUp(auth: AuthContext, id: string, input: FollowUpCloseInput) {
  const followUp = await loadFollowUp(auth, id);

  const outcome = nullable(input.outcome);
  if (!outcome) {
    throw unprocessable('An outcome note is required to close a follow-up', 'OUTCOME_REQUIRED');
  }
  if (followUp.status === 'CLOSED') {
    return serializeFollowUp(followUp, new Date());
  }

  const now = new Date();
  const updated = await prisma.followUp.update({
    where: { id },
    data: { status: 'CLOSED', outcome, closedAt: now },
    include: FOLLOWUP_INCLUDE,
  });

  await recordAudit({
    tenantId: auth.tenantId,
    actorId: auth.userId,
    entityType: 'FollowUp',
    entityId: id,
    action: 'UPDATE',
    before: { status: followUp.status },
    after: { status: 'CLOSED', outcome },
  });

  return serializeFollowUp(updated, now);
}
