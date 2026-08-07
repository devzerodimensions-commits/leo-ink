/**
 * Master-data services — FRD §3.5 (FR-113 … FR-117), §3.6 (FR-120, FR-121),
 * §4.1 (FR-201, FR-202) and FR-212 / FR-216.
 *
 * BR-1  every monetary/rate value is handled as a Decimal and serialised as a
 *       fixed-decimal string; Prisma columns receive `.toFixed(2)` / `.toFixed(4)`.
 * BR-4  every query filters on `tenantId` — a record belonging to another tenant
 *       is indistinguishable from one that does not exist.
 * BR-11 referenced masters are deactivated, never hard-deleted.
 */
import type {
  Customer,
  CustomerContact,
  HsnSacCode,
  ImportBatch,
  MaterialItem,
  Prisma,
  Product,
  RateCard,
  ShippingAddress,
  Supplier,
  TaxRate,
  UnitOfMeasure,
} from '@prisma/client';
import { prisma } from '../../db.js';
import type { AuthContext } from '../../auth/middleware.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../http/errors.js';
import { D, money, rate } from '../../lib/money.js';
import { STATE_CODES, isValidStateCode, stateCodeFromGstin, validateGstin } from '../../lib/gstin.js';
import { addDays, toDateOnly, tenantToday } from '../../lib/fy.js';
import { recordAudit } from '../setup/audit.js';
import type {
  ImportEntity,
  ListQuery,
  TemplateEntity,
  customerCreateSchema,
  customerUpdateSchema,
  importBodySchema,
  materialCreateSchema,
  materialUpdateSchema,
  openingBalanceImportSchema,
  productCreateSchema,
  productUpdateSchema,
  rateCardCreateSchema,
  rateCardUpdateSchema,
  supplierCreateSchema,
  supplierUpdateSchema,
} from './schemas.js';
import type { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface Warning {
  code: string;
  message: string;
}

export interface Paged<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

type DecimalLike = { toString(): string } | null | undefined;

/** BR-1 — 2-decimal money string, never a JS number. */
const m2 = (v: DecimalLike): string => money(v === null || v === undefined ? '0' : v.toString());
/** BR-1 — 4-decimal rate string. */
const r4 = (v: DecimalLike): string => rate(v === null || v === undefined ? '0' : v.toString());
const r4n = (v: DecimalLike): string | null => (v === null || v === undefined ? null : rate(v.toString()));

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const isoTs = (d: Date): string => d.toISOString();

const parseIsoDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

function activeWhere(active: ListQuery['active']): { active?: boolean } {
  return active === 'all' ? {} : { active: active === 'true' };
}

function pageArgs(query: { page: number; pageSize: number }): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

function stateName(code: string | null | undefined): string | null {
  if (!code) return null;
  return STATE_CODES[code] ?? null;
}

/** Normalise an optional free-text field: '' becomes null so blanks never masquerade as values. */
function nullable(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** BR-9 — masters that carry rates/prices are audited on every mutation. */
async function audit(
  auth: AuthContext,
  entityType: string,
  entityId: string,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  before: unknown,
  after: unknown,
): Promise<void> {
  await recordAudit({ tenantId: auth.tenantId, actorId: auth.userId, entityType, entityId, action, before, after });
}

// ─────────────────────────────────────────────────────────────────────────────
// GSTIN / party validation (BR-6, FR-113, FR-114, FR-201)
// ─────────────────────────────────────────────────────────────────────────────

const GSTIN_REQUIRED_TYPES = new Set(['REGISTERED', 'COMPOSITION', 'SEZ']);

function normaliseGstin(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toUpperCase();
  return value === '' ? null : value;
}

/**
 * FR-113 / FR-114 — "GSTIN (when provided) is format- and checksum-validated".
 * A bad checksum is rejected outright (422); only *duplicates* and *state
 * mismatches* are downgraded to non-blocking warnings (FR-201).
 */
function assertGstinValid(gstin: string): string {
  const result = validateGstin(gstin);
  if (!result.valid) {
    const code = result.problem === 'CHECKSUM' ? 'GSTIN_CHECKSUM_INVALID' : 'GSTIN_INVALID';
    throw unprocessable(result.message ?? 'GSTIN is invalid', code);
  }
  return gstin.trim().toUpperCase();
}

/** FR-113 — "for Registered/Composition/SEZ types GSTIN is mandatory". */
function assertGstinPresence(customerType: string, gstin: string | null): void {
  if (GSTIN_REQUIRED_TYPES.has(customerType) && !gstin) {
    throw unprocessable(`GSTIN is mandatory for ${customerType} customers`, 'GSTIN_REQUIRED');
  }
}

/**
 * FR-201 — non-blocking warnings: a GSTIN whose embedded state code disagrees
 * with the captured place of supply, and a GSTIN already used by another party.
 */
async function partyWarnings(
  tenantId: string,
  table: 'customer' | 'supplier',
  gstin: string | null,
  placeOfSupplyState: string,
  excludeId?: string,
): Promise<Warning[]> {
  const warnings: Warning[] = [];
  if (!gstin) return warnings;

  const gstinState = stateCodeFromGstin(gstin);
  if (gstinState && gstinState !== placeOfSupplyState) {
    warnings.push({
      code: 'GSTIN_STATE_MISMATCH',
      message:
        `GSTIN state code ${gstinState} (${stateName(gstinState) ?? 'unknown'}) does not match the ` +
        `place of supply ${placeOfSupplyState} (${stateName(placeOfSupplyState) ?? 'unknown'})`,
    });
  }

  const where = { tenantId, gstin, ...(excludeId ? { id: { not: excludeId } } : {}) };
  const duplicate =
    table === 'customer'
      ? await prisma.customer.findFirst({ where, select: { id: true, name: true } })
      : await prisma.supplier.findFirst({ where, select: { id: true, name: true } });

  if (duplicate) {
    warnings.push({
      code: 'DUPLICATE_GSTIN',
      message: `GSTIN ${gstin} is already used by "${duplicate.name}"`,
    });
  }
  return warnings;
}

/** FR-201 — "Customer name unique per tenant (case-insensitive); duplicate names blocked unless user confirms." */
async function assertNameAvailable(
  tenantId: string,
  table: 'customer' | 'supplier',
  name: string,
  confirmed: boolean,
  excludeId?: string,
): Promise<void> {
  if (confirmed) return;
  const where = {
    tenantId,
    name: { equals: name, mode: 'insensitive' as const },
    ...(excludeId ? { id: { not: excludeId } } : {}),
  };
  const existing =
    table === 'customer'
      ? await prisma.customer.findFirst({ where, select: { id: true, name: true } })
      : await prisma.supplier.findFirst({ where, select: { id: true, name: true } });

  if (existing) {
    throw new AppError(
      `A ${table} named "${existing.name}" already exists — resubmit with confirmDuplicateName: true to keep both`,
      409,
      'DUPLICATE_NAME',
      { existingId: existing.id, existingName: existing.name, confirmWith: 'confirmDuplicateName' },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference-master resolution (FR-115, FR-116, FR-117)
// ─────────────────────────────────────────────────────────────────────────────

type HsnWithDefaults = HsnSacCode & { defaultTaxRate: TaxRate | null; defaultUom: UnitOfMeasure | null };

async function resolveHsn(tenantId: string, hsnSacId: string): Promise<HsnWithDefaults> {
  const hsn = await prisma.hsnSacCode.findFirst({
    where: { id: hsnSacId, tenantId, active: true },
    include: { defaultTaxRate: true, defaultUom: true },
  });
  // FR-117 — a deactivated code is not offered for new selection.
  if (!hsn) throw unprocessable('Unknown or inactive HSN/SAC code', 'UNKNOWN_HSN');
  return hsn;
}

async function resolveUom(tenantId: string, uomId: string): Promise<UnitOfMeasure> {
  const uom = await prisma.unitOfMeasure.findFirst({ where: { id: uomId, tenantId, active: true } });
  if (!uom) throw unprocessable('Unknown or inactive unit of measure', 'UNKNOWN_UOM');
  return uom;
}

async function resolveTaxRate(tenantId: string, taxRateId: string): Promise<TaxRate> {
  const taxRate = await prisma.taxRate.findFirst({ where: { id: taxRateId, tenantId, active: true } });
  if (!taxRate) throw unprocessable('Unknown or inactive tax rate', 'UNKNOWN_TAX_RATE');
  return taxRate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialisers — every decimal leaves as a fixed-decimal string (BR-1)
// ─────────────────────────────────────────────────────────────────────────────

type CustomerRecord = Customer & {
  contacts?: CustomerContact[];
  shippingAddresses?: ShippingAddress[];
};

export function serializeCustomer(c: CustomerRecord) {
  return {
    id: c.id,
    name: c.name,
    customerType: c.customerType,
    gstin: c.gstin,
    pan: c.pan,
    placeOfSupplyState: c.placeOfSupplyState,
    placeOfSupplyStateName: stateName(c.placeOfSupplyState),
    billingAddress: c.billingAddress,
    billingCity: c.billingCity,
    billingPincode: c.billingPincode,
    phone: c.phone,
    email: c.email,
    creditDays: c.creditDays,
    creditLimit: m2(c.creditLimit),
    openingBalance: m2(c.openingBalance),
    active: c.active,
    createdAt: isoTs(c.createdAt),
    updatedAt: isoTs(c.updatedAt),
    contacts: (c.contacts ?? []).map((ct) => ({
      id: ct.id,
      name: ct.name,
      phone: ct.phone,
      email: ct.email,
      role: ct.role,
      isPrimary: ct.isPrimary,
    })),
    shippingAddresses: (c.shippingAddresses ?? []).map((sa) => ({
      id: sa.id,
      label: sa.label,
      address: sa.address,
      city: sa.city,
      stateCode: sa.stateCode,
      stateName: stateName(sa.stateCode),
      pincode: sa.pincode,
    })),
  };
}

/** FR-114 — payment terms feed payables ageing; expose the computed due date. */
export function serializeSupplier(s: Supplier, billDate: Date) {
  const base = toDateOnly(billDate);
  return {
    id: s.id,
    name: s.name,
    gstin: s.gstin,
    pan: s.pan,
    address: s.address,
    placeOfSupplyState: s.placeOfSupplyState,
    placeOfSupplyStateName: stateName(s.placeOfSupplyState),
    paymentTermDays: s.paymentTermDays,
    openingBalance: m2(s.openingBalance),
    phone: s.phone,
    email: s.email,
    active: s.active,
    createdAt: isoTs(s.createdAt),
    updatedAt: isoTs(s.updatedAt),
    /** FR-114 — dueDateFor(billDate) = billDate + paymentTermDays. */
    dueDateFor: {
      billDate: isoDate(base),
      paymentTermDays: s.paymentTermDays,
      dueDate: isoDate(addDays(base, s.paymentTermDays)),
    },
  };
}

type ProductRecord = Product & {
  hsnSac?: HsnSacCode | null;
  defaultUom?: UnitOfMeasure | null;
  taxRate?: TaxRate | null;
};

export function serializeProduct(p: ProductRecord) {
  return {
    id: p.id,
    skuCode: p.skuCode,
    name: p.name,
    vertical: p.vertical,
    defaultSpecs: p.defaultSpecs,
    defaultRate: r4(p.defaultRate),
    active: p.active,
    createdAt: isoTs(p.createdAt),
    updatedAt: isoTs(p.updatedAt),
    hsnSacId: p.hsnSacId,
    defaultUomId: p.defaultUomId,
    taxRateId: p.taxRateId,
    // FR-115 — the resolved defaults a document line pre-fills from.
    hsnSac: p.hsnSac ? { id: p.hsnSac.id, code: p.hsnSac.code, type: p.hsnSac.type, active: p.hsnSac.active } : null,
    uom: p.defaultUom
      ? { id: p.defaultUom.id, uomCode: p.defaultUom.uomCode, name: p.defaultUom.name, symbol: p.defaultUom.symbol }
      : null,
    taxRate: p.taxRate
      ? { id: p.taxRate.id, name: p.taxRate.name, gstPct: r4(p.taxRate.gstPct), cessPct: r4(p.taxRate.cessPct) }
      : null,
  };
}

type MaterialRecord = MaterialItem & {
  uom?: UnitOfMeasure | null;
  hsnSac?: (HsnSacCode & { defaultTaxRate?: TaxRate | null }) | null;
};

export function serializeMaterial(m: MaterialRecord) {
  const sellingRate = r4n(m.sellingRate);
  const gstPct = r4n(m.gstPct) ?? (m.hsnSac?.defaultTaxRate ? r4(m.hsnSac.defaultTaxRate.gstPct) : null);
  return {
    id: m.id,
    itemCode: m.itemCode,
    name: m.name,
    category: m.category,
    gsm: m.gsm,
    size: m.size,
    rollWidthFt: r4n(m.rollWidthFt),
    uomId: m.uomId,
    hsnSacId: m.hsnSacId,
    sellingRate,
    costRate: r4n(m.costRate),
    minCharge: m2(m.minCharge),
    gstPct,
    reorderLevel: r4(m.reorderLevel),
    active: m.active,
    createdAt: isoTs(m.createdAt),
    updatedAt: isoTs(m.updatedAt),
    uom: m.uom ? { id: m.uom.id, uomCode: m.uom.uomCode, name: m.uom.name, symbol: m.uom.symbol } : null,
    hsnSac: m.hsnSac ? { id: m.hsnSac.id, code: m.hsnSac.code, type: m.hsnSac.type, active: m.hsnSac.active } : null,
    /**
     * FR-212 — the pricing engine looks a media rate up here. A null sellingRate
     * (or a deactivated item) must be reported so auto-pricing refuses rather
     * than silently pricing at zero.
     */
    pricing: {
      rateSource: 'MATERIAL_MASTER' as const,
      sellingRate,
      minCharge: m2(m.minCharge),
      gstPct,
      uomCode: m.uom?.uomCode ?? null,
      canAutoPrice: sellingRate !== null && m.active,
      blockedReason:
        sellingRate === null
          ? 'NO_ACTIVE_RATE'
          : !m.active
            ? 'ITEM_INACTIVE'
            : null,
    },
  };
}

type RateCardRecord = RateCard & { uom?: UnitOfMeasure | null };

export function serializeRateCard(rc: RateCardRecord) {
  return {
    id: rc.id,
    itemName: rc.itemName,
    uomId: rc.uomId,
    publishedRate: r4(rc.publishedRate),
    hsnSac: rc.hsnSac,
    gstPct: r4(rc.gstPct),
    minCharge: m2(rc.minCharge),
    active: rc.active,
    createdAt: isoTs(rc.createdAt),
    updatedAt: isoTs(rc.updatedAt),
    uom: rc.uom ? { id: rc.uom.id, uomCode: rc.uom.uomCode, name: rc.uom.name, symbol: rc.uom.symbol } : null,
  };
}

export function serializeImportBatch(b: ImportBatch) {
  const errors = Array.isArray(b.errorReport) ? b.errorReport : [];
  return {
    id: b.id,
    entityType: b.entityType,
    fileName: b.fileName,
    rowCount: b.rowCount,
    accepted: b.accepted,
    rejected: b.rejected,
    skipped: b.rowCount - b.accepted - b.rejected,
    status: b.status,
    errorReport: errors,
    createdAt: isoTs(b.createdAt),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-113 / FR-201 — Customers
// ─────────────────────────────────────────────────────────────────────────────

type CustomerInput = z.output<typeof customerCreateSchema>;
type CustomerPatch = z.output<typeof customerUpdateSchema>;

const CUSTOMER_INCLUDE = {
  contacts: { orderBy: { createdAt: 'asc' } },
  shippingAddresses: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.CustomerInclude;

export async function listCustomers(auth: AuthContext, query: ListQuery): Promise<Paged<ReturnType<typeof serializeCustomer>>> {
  const where: Prisma.CustomerWhereInput = {
    tenantId: auth.tenantId, // BR-4
    ...activeWhere(query.active),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' } },
            { gstin: { contains: query.q, mode: 'insensitive' } },
            { phone: { contains: query.q } },
            { email: { contains: query.q, mode: 'insensitive' } },
            { billingCity: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.customer.findMany({ where, include: CUSTOMER_INCLUDE, orderBy: { name: 'asc' }, ...pageArgs(query) }),
    prisma.customer.count({ where }),
  ]);

  return { data: rows.map(serializeCustomer), page: query.page, pageSize: query.pageSize, total };
}

async function loadCustomer(auth: AuthContext, id: string) {
  // BR-4 — another tenant's id must 404, never leak.
  const customer = await prisma.customer.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: CUSTOMER_INCLUDE,
  });
  if (!customer) throw notFound('Customer not found');
  return customer;
}

export async function getCustomer(auth: AuthContext, id: string) {
  const customer = await loadCustomer(auth, id);
  const warnings = await partyWarnings(
    auth.tenantId,
    'customer',
    customer.gstin,
    customer.placeOfSupplyState,
    customer.id,
  );
  return { ...serializeCustomer(customer), warnings };
}

export async function createCustomer(auth: AuthContext, input: CustomerInput) {
  const gstin = normaliseGstin(input.gstin);
  if (gstin) assertGstinValid(gstin);
  assertGstinPresence(input.customerType, gstin);
  await assertNameAvailable(auth.tenantId, 'customer', input.name, input.confirmDuplicateName);

  const created = await prisma.customer.create({
    data: {
      tenantId: auth.tenantId,
      name: input.name,
      customerType: input.customerType,
      gstin,
      pan: nullable(input.pan),
      placeOfSupplyState: input.placeOfSupplyState,
      billingAddress: nullable(input.billingAddress),
      billingCity: nullable(input.billingCity),
      billingPincode: nullable(input.billingPincode),
      phone: input.phone,
      email: nullable(input.email),
      creditDays: input.creditDays,
      creditLimit: D(input.creditLimit).toFixed(2),
      openingBalance: D(input.openingBalance).toFixed(2),
      active: input.active,
      contacts: {
        create: input.contacts.map((c) => ({
          tenantId: auth.tenantId,
          name: c.name,
          phone: nullable(c.phone),
          email: nullable(c.email),
          role: nullable(c.role),
          isPrimary: c.isPrimary,
        })),
      },
      shippingAddresses: {
        create: input.shippingAddresses.map((sa) => ({
          tenantId: auth.tenantId,
          label: nullable(sa.label),
          address: sa.address,
          city: nullable(sa.city),
          stateCode: sa.stateCode,
          pincode: nullable(sa.pincode),
        })),
      },
    },
    include: CUSTOMER_INCLUDE,
  });

  const dto = serializeCustomer(created);
  await audit(auth, 'Customer', created.id, 'CREATE', null, dto);
  const warnings = await partyWarnings(auth.tenantId, 'customer', gstin, input.placeOfSupplyState, created.id);
  return { ...dto, warnings };
}

export async function updateCustomer(auth: AuthContext, id: string, patch: CustomerPatch) {
  const existing = await loadCustomer(auth, id);
  const before = serializeCustomer(existing);

  const gstin = patch.gstin !== undefined ? normaliseGstin(patch.gstin) : existing.gstin;
  if (gstin && patch.gstin !== undefined) assertGstinValid(gstin);
  const customerType = patch.customerType ?? existing.customerType;
  assertGstinPresence(customerType, gstin);

  if (patch.name !== undefined && patch.name.toLowerCase() !== existing.name.toLowerCase()) {
    await assertNameAvailable(auth.tenantId, 'customer', patch.name, patch.confirmDuplicateName ?? false, id);
  }

  const placeOfSupplyState = patch.placeOfSupplyState ?? existing.placeOfSupplyState;

  const updated = await prisma.$transaction(async (tx) => {
    if (patch.contacts !== undefined) {
      await tx.customerContact.deleteMany({ where: { customerId: id, tenantId: auth.tenantId } });
      await tx.customerContact.createMany({
        data: patch.contacts.map((c) => ({
          tenantId: auth.tenantId,
          customerId: id,
          name: c.name,
          phone: nullable(c.phone),
          email: nullable(c.email),
          role: nullable(c.role),
          isPrimary: c.isPrimary,
        })),
      });
    }
    if (patch.shippingAddresses !== undefined) {
      await tx.shippingAddress.deleteMany({ where: { customerId: id, tenantId: auth.tenantId } });
      await tx.shippingAddress.createMany({
        data: patch.shippingAddresses.map((sa) => ({
          tenantId: auth.tenantId,
          customerId: id,
          label: nullable(sa.label),
          address: sa.address,
          city: nullable(sa.city),
          stateCode: sa.stateCode,
          pincode: nullable(sa.pincode),
        })),
      });
    }

    return tx.customer.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.customerType !== undefined ? { customerType: patch.customerType } : {}),
        ...(patch.gstin !== undefined ? { gstin } : {}),
        ...(patch.pan !== undefined ? { pan: nullable(patch.pan) } : {}),
        ...(patch.placeOfSupplyState !== undefined ? { placeOfSupplyState: patch.placeOfSupplyState } : {}),
        ...(patch.billingAddress !== undefined ? { billingAddress: nullable(patch.billingAddress) } : {}),
        ...(patch.billingCity !== undefined ? { billingCity: nullable(patch.billingCity) } : {}),
        ...(patch.billingPincode !== undefined ? { billingPincode: nullable(patch.billingPincode) } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.email !== undefined ? { email: nullable(patch.email) } : {}),
        ...(patch.creditDays !== undefined ? { creditDays: patch.creditDays } : {}),
        ...(patch.creditLimit !== undefined ? { creditLimit: D(patch.creditLimit).toFixed(2) } : {}),
        ...(patch.openingBalance !== undefined ? { openingBalance: D(patch.openingBalance).toFixed(2) } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      },
      include: CUSTOMER_INCLUDE,
    });
  });

  const dto = serializeCustomer(updated);
  await audit(auth, 'Customer', id, 'UPDATE', before, dto);
  const warnings = await partyWarnings(auth.tenantId, 'customer', gstin, placeOfSupplyState, id);
  return { ...dto, warnings };
}

/** FR-113 / FR-201 — "a customer with transactions cannot be deleted, only deactivated". */
export async function deleteCustomer(auth: AuthContext, id: string) {
  const existing = await loadCustomer(auth, id);

  const [quotes, jobcards, enquiries] = await Promise.all([
    prisma.quote.count({ where: { tenantId: auth.tenantId, customerId: id } }),
    prisma.jobcard.count({ where: { tenantId: auth.tenantId, customerId: id } }),
    prisma.enquiry.count({ where: { tenantId: auth.tenantId, customerId: id } }),
  ]);

  if (quotes > 0 || jobcards > 0 || enquiries > 0) {
    throw new AppError(
      `"${existing.name}" is referenced by existing documents and cannot be deleted — deactivate it instead`,
      409,
      'HAS_REFERENCES',
      {
        references: { quotes, jobcards, enquiries },
        remedy: 'deactivate',
        deactivateEndpoint: `/api/customers/${id}/deactivate`,
      },
    );
  }

  await prisma.customer.delete({ where: { id } });
  await audit(auth, 'Customer', id, 'DELETE', serializeCustomer(existing), null);
  return { id, deleted: true };
}

/** BR-11 — the deactivation the delete endpoint offers. */
export async function deactivateCustomer(auth: AuthContext, id: string) {
  const existing = await loadCustomer(auth, id);
  if (!existing.active) return serializeCustomer(existing);
  const updated = await prisma.customer.update({ where: { id }, data: { active: false }, include: CUSTOMER_INCLUDE });
  const dto = serializeCustomer(updated);
  await audit(auth, 'Customer', id, 'UPDATE', serializeCustomer(existing), dto);
  return dto;
}

/**
 * FR-202 — read-only running outstanding.
 * outstanding = openingBalance + Σ invoices − Σ receipts − Σ credit notes.
 * Phase 1 ships no Invoice/Receipt/CreditNote tables (they belong to the
 * Accounting module), so those buckets are explicitly zero and flagged as such
 * rather than silently omitted. Nothing here is editable.
 */
export async function customerLedger(auth: AuthContext, id: string, asOn?: string) {
  const customer = await loadCustomer(auth, id);
  const asOnDate = asOn ? parseIsoDate(asOn) : tenantToday();

  const fy = await prisma.financialYear.findFirst({
    where: { tenantId: auth.tenantId, isCurrent: true },
    orderBy: { startDate: 'desc' },
  });

  const opening = D(customer.openingBalance.toString());
  const invoices = D(0);
  const receipts = D(0);
  const creditNotes = D(0);
  const outstanding = opening.plus(invoices).minus(receipts).minus(creditNotes);

  const openingDate = fy ? toDateOnly(fy.startDate) : toDateOnly(customer.createdAt);
  const openingDueDate = addDays(openingDate, customer.creditDays);
  const overdue = toDateOnly(asOnDate).getTime() > openingDueDate.getTime() && outstanding.greaterThan(0);

  return {
    customerId: customer.id,
    customerName: customer.name,
    asOn: isoDate(toDateOnly(asOnDate)),
    fy: fy ? { id: fy.id, fyLabel: fy.fyLabel, startDate: isoDate(fy.startDate), endDate: isoDate(fy.endDate) } : null,
    openingBalance: money(opening),
    sources: {
      openingBalance: money(opening),
      invoices: money(invoices),
      receipts: money(receipts),
      creditNotes: money(creditNotes),
    },
    outstanding: money(outstanding),
    creditDays: customer.creditDays,
    creditLimit: m2(customer.creditLimit),
    overCreditLimit: D(customer.creditLimit.toString()).greaterThan(0) && outstanding.greaterThan(D(customer.creditLimit.toString())),
    ageing: {
      notDue: overdue ? money(0) : money(outstanding),
      overdue: overdue ? money(outstanding) : money(0),
      openingDueDate: isoDate(openingDueDate),
    },
    entries: [
      {
        date: isoDate(openingDate),
        particulars: 'Opening balance',
        voucherType: 'OPENING',
        voucherNo: null,
        debit: money(opening),
        credit: money(0),
        balance: money(opening),
      },
    ],
    // FR-202 — "Values shown are computed from posted entries, not editable here."
    readOnly: true,
    postingModule: 'accounting',
    notes: [
      'FR-202 — this view is read-only; invoices, receipts and credit notes are posted by the Accounting module.',
      'Phase 1 carries no Invoice/Receipt/CreditNote tables yet, so those buckets are zero.',
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-114 — Suppliers
// ─────────────────────────────────────────────────────────────────────────────

type SupplierInput = z.output<typeof supplierCreateSchema>;
type SupplierPatch = z.output<typeof supplierUpdateSchema>;

export async function listSuppliers(auth: AuthContext, query: ListQuery & { billDate?: string }) {
  const where: Prisma.SupplierWhereInput = {
    tenantId: auth.tenantId,
    ...activeWhere(query.active),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' } },
            { gstin: { contains: query.q, mode: 'insensitive' } },
            { phone: { contains: query.q } },
            { email: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const billDate = query.billDate ? parseIsoDate(query.billDate) : tenantToday();
  const [rows, total] = await Promise.all([
    prisma.supplier.findMany({ where, orderBy: { name: 'asc' }, ...pageArgs(query) }),
    prisma.supplier.count({ where }),
  ]);

  return {
    data: rows.map((s) => serializeSupplier(s, billDate)),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

async function loadSupplier(auth: AuthContext, id: string): Promise<Supplier> {
  const supplier = await prisma.supplier.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!supplier) throw notFound('Supplier not found');
  return supplier;
}

export async function getSupplier(auth: AuthContext, id: string, billDateRaw?: string) {
  const supplier = await loadSupplier(auth, id);
  const billDate = billDateRaw ? parseIsoDate(billDateRaw) : tenantToday();
  const warnings = await partyWarnings(auth.tenantId, 'supplier', supplier.gstin, supplier.placeOfSupplyState, supplier.id);
  return { ...serializeSupplier(supplier, billDate), warnings };
}

export async function createSupplier(auth: AuthContext, input: SupplierInput) {
  const gstin = normaliseGstin(input.gstin);
  // FR-114 AC — "a supplier GSTIN with a bad checksum, when saved, then it is rejected".
  if (gstin) assertGstinValid(gstin);
  await assertNameAvailable(auth.tenantId, 'supplier', input.name, input.confirmDuplicateName);

  const created = await prisma.supplier.create({
    data: {
      tenantId: auth.tenantId,
      name: input.name,
      gstin,
      pan: nullable(input.pan),
      address: nullable(input.address),
      placeOfSupplyState: input.placeOfSupplyState,
      paymentTermDays: input.paymentTermDays,
      openingBalance: D(input.openingBalance).toFixed(2),
      phone: nullable(input.phone),
      email: nullable(input.email),
      active: input.active,
    },
  });

  const dto = serializeSupplier(created, tenantToday());
  await audit(auth, 'Supplier', created.id, 'CREATE', null, dto);
  const warnings = await partyWarnings(auth.tenantId, 'supplier', gstin, input.placeOfSupplyState, created.id);
  return { ...dto, warnings };
}

export async function updateSupplier(auth: AuthContext, id: string, patch: SupplierPatch) {
  const existing = await loadSupplier(auth, id);
  const before = serializeSupplier(existing, tenantToday());

  const gstin = patch.gstin !== undefined ? normaliseGstin(patch.gstin) : existing.gstin;
  if (gstin && patch.gstin !== undefined) assertGstinValid(gstin);

  if (patch.name !== undefined && patch.name.toLowerCase() !== existing.name.toLowerCase()) {
    await assertNameAvailable(auth.tenantId, 'supplier', patch.name, patch.confirmDuplicateName ?? false, id);
  }

  const updated = await prisma.supplier.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.gstin !== undefined ? { gstin } : {}),
      ...(patch.pan !== undefined ? { pan: nullable(patch.pan) } : {}),
      ...(patch.address !== undefined ? { address: nullable(patch.address) } : {}),
      ...(patch.placeOfSupplyState !== undefined ? { placeOfSupplyState: patch.placeOfSupplyState } : {}),
      ...(patch.paymentTermDays !== undefined ? { paymentTermDays: patch.paymentTermDays } : {}),
      ...(patch.openingBalance !== undefined ? { openingBalance: D(patch.openingBalance).toFixed(2) } : {}),
      ...(patch.phone !== undefined ? { phone: nullable(patch.phone) } : {}),
      ...(patch.email !== undefined ? { email: nullable(patch.email) } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    },
  });

  const dto = serializeSupplier(updated, tenantToday());
  await audit(auth, 'Supplier', id, 'UPDATE', before, dto);
  const warnings = await partyWarnings(
    auth.tenantId,
    'supplier',
    updated.gstin,
    updated.placeOfSupplyState,
    id,
  );
  return { ...dto, warnings };
}

/** FR-114 — "a supplier with transactions is deactivated, not deleted". */
export async function deleteSupplier(auth: AuthContext, id: string) {
  const existing = await loadSupplier(auth, id);
  // Phase 1 ships no PO/GRN/bill tables; opening balances are the only carried state.
  if (!D(existing.openingBalance.toString()).isZero()) {
    throw new AppError(
      `"${existing.name}" carries an opening balance and cannot be deleted — deactivate it instead`,
      409,
      'HAS_REFERENCES',
      { references: { openingBalance: m2(existing.openingBalance) }, remedy: 'deactivate', deactivateEndpoint: `/api/suppliers/${id}/deactivate` },
    );
  }

  await prisma.supplier.delete({ where: { id } });
  await audit(auth, 'Supplier', id, 'DELETE', serializeSupplier(existing, tenantToday()), null);
  return { id, deleted: true };
}

export async function deactivateSupplier(auth: AuthContext, id: string) {
  const existing = await loadSupplier(auth, id);
  if (!existing.active) return serializeSupplier(existing, tenantToday());
  const updated = await prisma.supplier.update({ where: { id }, data: { active: false } });
  const dto = serializeSupplier(updated, tenantToday());
  await audit(auth, 'Supplier', id, 'UPDATE', serializeSupplier(existing, tenantToday()), dto);
  return dto;
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-115 — Products / SKUs
// ─────────────────────────────────────────────────────────────────────────────

type ProductInput = z.output<typeof productCreateSchema>;
type ProductPatch = z.output<typeof productUpdateSchema>;

const PRODUCT_INCLUDE = { hsnSac: true, defaultUom: true, taxRate: true } satisfies Prisma.ProductInclude;

export async function listProducts(auth: AuthContext, query: ListQuery) {
  const where: Prisma.ProductWhereInput = {
    tenantId: auth.tenantId,
    ...activeWhere(query.active),
    ...(query.q
      ? {
          OR: [
            { skuCode: { contains: query.q, mode: 'insensitive' } },
            { name: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.product.findMany({ where, include: PRODUCT_INCLUDE, orderBy: { skuCode: 'asc' }, ...pageArgs(query) }),
    prisma.product.count({ where }),
  ]);

  return { data: rows.map(serializeProduct), page: query.page, pageSize: query.pageSize, total };
}

async function loadProduct(auth: AuthContext, id: string) {
  const product = await prisma.product.findFirst({ where: { id, tenantId: auth.tenantId }, include: PRODUCT_INCLUDE });
  if (!product) throw notFound('Product not found');
  return product;
}

export async function getProduct(auth: AuthContext, id: string) {
  return serializeProduct(await loadProduct(auth, id));
}

export async function createProduct(auth: AuthContext, input: ProductInput) {
  const duplicate = await prisma.product.findFirst({
    where: { tenantId: auth.tenantId, skuCode: input.skuCode },
    select: { id: true },
  });
  // FR-115 AC — "Given a duplicate SKU code, when saved, then it is rejected."
  if (duplicate) throw conflict(`SKU code "${input.skuCode}" already exists`, 'DUPLICATE_SKU_CODE');

  const hsn = input.hsnSacId ? await resolveHsn(auth.tenantId, input.hsnSacId) : null;
  // FR-115 — "Each SKU links an HSN (inheriting its default tax rate) and a default UOM".
  const taxRateId = input.taxRateId ?? hsn?.defaultTaxRateId ?? null;
  if (taxRateId) await resolveTaxRate(auth.tenantId, taxRateId);
  const defaultUomId = input.defaultUomId ?? hsn?.defaultUomId ?? null;
  if (defaultUomId) await resolveUom(auth.tenantId, defaultUomId);

  const created = await prisma.product.create({
    data: {
      tenantId: auth.tenantId,
      skuCode: input.skuCode,
      name: input.name,
      vertical: input.vertical,
      defaultSpecs: (input.defaultSpecs ?? undefined) as Prisma.InputJsonValue | undefined,
      hsnSacId: input.hsnSacId ?? null,
      defaultUomId,
      taxRateId,
      defaultRate: D(input.defaultRate).toFixed(4),
      active: input.active,
    },
    include: PRODUCT_INCLUDE,
  });

  const dto = serializeProduct(created);
  await audit(auth, 'Product', created.id, 'CREATE', null, dto);
  return dto;
}

export async function updateProduct(auth: AuthContext, id: string, patch: ProductPatch) {
  const existing = await loadProduct(auth, id);
  const before = serializeProduct(existing);

  if (patch.skuCode !== undefined && patch.skuCode !== existing.skuCode) {
    const duplicate = await prisma.product.findFirst({
      where: { tenantId: auth.tenantId, skuCode: patch.skuCode, id: { not: id } },
      select: { id: true },
    });
    if (duplicate) throw conflict(`SKU code "${patch.skuCode}" already exists`, 'DUPLICATE_SKU_CODE');
  }

  const hsn = patch.hsnSacId ? await resolveHsn(auth.tenantId, patch.hsnSacId) : null;
  let taxRateId = patch.taxRateId !== undefined ? patch.taxRateId : undefined;
  if (taxRateId === undefined && hsn) taxRateId = hsn.defaultTaxRateId;
  if (taxRateId) await resolveTaxRate(auth.tenantId, taxRateId);
  if (patch.defaultUomId) await resolveUom(auth.tenantId, patch.defaultUomId);

  const updated = await prisma.product.update({
    where: { id },
    data: {
      ...(patch.skuCode !== undefined ? { skuCode: patch.skuCode } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.vertical !== undefined ? { vertical: patch.vertical } : {}),
      ...(patch.defaultSpecs !== undefined
        ? { defaultSpecs: (patch.defaultSpecs ?? undefined) as Prisma.InputJsonValue | undefined }
        : {}),
      ...(patch.hsnSacId !== undefined ? { hsnSacId: patch.hsnSacId ?? null } : {}),
      ...(patch.defaultUomId !== undefined ? { defaultUomId: patch.defaultUomId ?? null } : {}),
      ...(taxRateId !== undefined ? { taxRateId: taxRateId ?? null } : {}),
      ...(patch.defaultRate !== undefined ? { defaultRate: D(patch.defaultRate).toFixed(4) } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    },
    include: PRODUCT_INCLUDE,
  });

  const dto = serializeProduct(updated);
  await audit(auth, 'Product', id, 'UPDATE', before, dto);
  return dto;
}

export async function deleteProduct(auth: AuthContext, id: string) {
  const existing = await loadProduct(auth, id);
  await prisma.product.delete({ where: { id } });
  await audit(auth, 'Product', id, 'DELETE', serializeProduct(existing), null);
  return { id, deleted: true };
}

export async function deactivateProduct(auth: AuthContext, id: string) {
  const existing = await loadProduct(auth, id);
  if (!existing.active) return serializeProduct(existing);
  const updated = await prisma.product.update({ where: { id }, data: { active: false }, include: PRODUCT_INCLUDE });
  const dto = serializeProduct(updated);
  await audit(auth, 'Product', id, 'UPDATE', serializeProduct(existing), dto);
  return dto;
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-116 / FR-212 — Material items
// ─────────────────────────────────────────────────────────────────────────────

type MaterialInput = z.output<typeof materialCreateSchema>;
type MaterialPatch = z.output<typeof materialUpdateSchema>;

const MATERIAL_INCLUDE = {
  uom: true,
  hsnSac: { include: { defaultTaxRate: true } },
} satisfies Prisma.MaterialItemInclude;

/**
 * FR-116 — "Category-specific attributes are captured (e.g., GSM and size for
 * paper/board, roll width for media); UOM and HSN are mandatory."
 */
function assertCategoryFields(state: {
  category: string;
  gsm: number | null;
  size: string | null;
  rollWidthFt: string | null;
  uomId: string | null;
  hsnSacId: string | null;
}): void {
  const missing: string[] = [];
  if (!state.uomId) missing.push('uomId');
  if (!state.hsnSacId) missing.push('hsnSacId');
  if (state.category === 'MEDIA') {
    if (state.rollWidthFt === null) missing.push('rollWidthFt');
  }
  if (state.category === 'PAPER' || state.category === 'BOARD') {
    if (state.gsm === null) missing.push('gsm');
    if (!state.size) missing.push('size');
  }
  if (missing.length > 0) {
    throw unprocessable(
      `${state.category} items require: ${missing.join(', ')}`,
      'CATEGORY_FIELDS_REQUIRED',
      { category: state.category, missing },
    );
  }
}

export async function listMaterials(auth: AuthContext, query: ListQuery) {
  const where: Prisma.MaterialItemWhereInput = {
    tenantId: auth.tenantId,
    ...activeWhere(query.active),
    ...(query.q
      ? {
          OR: [
            { itemCode: { contains: query.q, mode: 'insensitive' } },
            { name: { contains: query.q, mode: 'insensitive' } },
            { size: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.materialItem.findMany({ where, include: MATERIAL_INCLUDE, orderBy: { itemCode: 'asc' }, ...pageArgs(query) }),
    prisma.materialItem.count({ where }),
  ]);

  return { data: rows.map(serializeMaterial), page: query.page, pageSize: query.pageSize, total };
}

async function loadMaterial(auth: AuthContext, id: string) {
  const material = await prisma.materialItem.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: MATERIAL_INCLUDE,
  });
  if (!material) throw notFound('Material item not found');
  return material;
}

export async function getMaterial(auth: AuthContext, id: string) {
  return serializeMaterial(await loadMaterial(auth, id));
}

export async function createMaterial(auth: AuthContext, input: MaterialInput) {
  const duplicate = await prisma.materialItem.findFirst({
    where: { tenantId: auth.tenantId, itemCode: input.itemCode },
    select: { id: true },
  });
  if (duplicate) throw conflict(`Item code "${input.itemCode}" already exists`, 'DUPLICATE_ITEM_CODE');

  assertCategoryFields({
    category: input.category,
    gsm: input.gsm ?? null,
    size: input.size ?? null,
    rollWidthFt: input.rollWidthFt ?? null,
    uomId: input.uomId,
    hsnSacId: input.hsnSacId,
  });

  await resolveUom(auth.tenantId, input.uomId);
  const hsn = await resolveHsn(auth.tenantId, input.hsnSacId);
  const gstPct = input.gstPct ?? (hsn.defaultTaxRate ? hsn.defaultTaxRate.gstPct.toString() : null);

  const created = await prisma.materialItem.create({
    data: {
      tenantId: auth.tenantId,
      itemCode: input.itemCode,
      name: input.name,
      category: input.category,
      gsm: input.gsm ?? null,
      size: nullable(input.size),
      rollWidthFt: input.rollWidthFt === undefined || input.rollWidthFt === null ? null : D(input.rollWidthFt).toFixed(4),
      uomId: input.uomId,
      hsnSacId: input.hsnSacId,
      sellingRate: input.sellingRate === undefined || input.sellingRate === null ? null : D(input.sellingRate).toFixed(4),
      costRate: input.costRate === undefined || input.costRate === null ? null : D(input.costRate).toFixed(4),
      minCharge: D(input.minCharge).toFixed(2),
      gstPct: gstPct === null ? null : D(gstPct).toFixed(4),
      reorderLevel: D(input.reorderLevel).toFixed(4),
      active: input.active,
    },
    include: MATERIAL_INCLUDE,
  });

  const dto = serializeMaterial(created);
  await audit(auth, 'MaterialItem', created.id, 'CREATE', null, dto);
  return dto;
}

export async function updateMaterial(auth: AuthContext, id: string, patch: MaterialPatch) {
  const existing = await loadMaterial(auth, id);
  const before = serializeMaterial(existing);

  if (patch.itemCode !== undefined && patch.itemCode !== existing.itemCode) {
    const duplicate = await prisma.materialItem.findFirst({
      where: { tenantId: auth.tenantId, itemCode: patch.itemCode, id: { not: id } },
      select: { id: true },
    });
    if (duplicate) throw conflict(`Item code "${patch.itemCode}" already exists`, 'DUPLICATE_ITEM_CODE');
  }

  // Category rules are checked against the merged record, not the patch alone.
  assertCategoryFields({
    category: patch.category ?? existing.category,
    gsm: patch.gsm !== undefined ? (patch.gsm ?? null) : existing.gsm,
    size: patch.size !== undefined ? nullable(patch.size) : existing.size,
    rollWidthFt:
      patch.rollWidthFt !== undefined
        ? (patch.rollWidthFt ?? null)
        : existing.rollWidthFt === null
          ? null
          : existing.rollWidthFt.toString(),
    uomId: patch.uomId ?? existing.uomId,
    hsnSacId: patch.hsnSacId ?? existing.hsnSacId,
  });

  if (patch.uomId !== undefined) await resolveUom(auth.tenantId, patch.uomId);
  if (patch.hsnSacId !== undefined) await resolveHsn(auth.tenantId, patch.hsnSacId);

  const updated = await prisma.materialItem.update({
    where: { id },
    data: {
      ...(patch.itemCode !== undefined ? { itemCode: patch.itemCode } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.gsm !== undefined ? { gsm: patch.gsm ?? null } : {}),
      ...(patch.size !== undefined ? { size: nullable(patch.size) } : {}),
      ...(patch.rollWidthFt !== undefined
        ? { rollWidthFt: patch.rollWidthFt === null ? null : D(patch.rollWidthFt).toFixed(4) }
        : {}),
      ...(patch.uomId !== undefined ? { uomId: patch.uomId } : {}),
      ...(patch.hsnSacId !== undefined ? { hsnSacId: patch.hsnSacId } : {}),
      // FR-212 — clearing the rate is meaningful: it blocks auto-pricing.
      ...(patch.sellingRate !== undefined
        ? { sellingRate: patch.sellingRate === null ? null : D(patch.sellingRate).toFixed(4) }
        : {}),
      ...(patch.costRate !== undefined
        ? { costRate: patch.costRate === null ? null : D(patch.costRate).toFixed(4) }
        : {}),
      ...(patch.minCharge !== undefined ? { minCharge: D(patch.minCharge).toFixed(2) } : {}),
      ...(patch.gstPct !== undefined ? { gstPct: patch.gstPct === null ? null : D(patch.gstPct).toFixed(4) } : {}),
      ...(patch.reorderLevel !== undefined ? { reorderLevel: D(patch.reorderLevel).toFixed(4) } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    },
    include: MATERIAL_INCLUDE,
  });

  const dto = serializeMaterial(updated);
  await audit(auth, 'MaterialItem', id, 'UPDATE', before, dto);
  return dto;
}

/** FR-116 — "An item with stock movements or open POs is deactivated, not deleted." */
export async function deleteMaterial(auth: AuthContext, id: string) {
  const existing = await loadMaterial(auth, id);
  const quoteLines = await prisma.quoteLine.count({ where: { tenantId: auth.tenantId, materialId: id } });

  if (quoteLines > 0) {
    throw new AppError(
      `"${existing.name}" is referenced by priced document lines and cannot be deleted — deactivate it instead`,
      409,
      'HAS_REFERENCES',
      { references: { quoteLines }, remedy: 'deactivate', deactivateEndpoint: `/api/materials/${id}/deactivate` },
    );
  }

  await prisma.materialItem.delete({ where: { id } });
  await audit(auth, 'MaterialItem', id, 'DELETE', serializeMaterial(existing), null);
  return { id, deleted: true };
}

export async function deactivateMaterial(auth: AuthContext, id: string) {
  const existing = await loadMaterial(auth, id);
  if (!existing.active) return serializeMaterial(existing);
  const updated = await prisma.materialItem.update({
    where: { id },
    data: { active: false },
    include: MATERIAL_INCLUDE,
  });
  const dto = serializeMaterial(updated);
  await audit(auth, 'MaterialItem', id, 'UPDATE', serializeMaterial(existing), dto);
  return dto;
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-216 — Rate cards
// ─────────────────────────────────────────────────────────────────────────────

type RateCardInput = z.output<typeof rateCardCreateSchema>;
type RateCardPatch = z.output<typeof rateCardUpdateSchema>;

const RATE_CARD_INCLUDE = { uom: true } satisfies Prisma.RateCardInclude;

export async function listRateCards(auth: AuthContext, query: ListQuery & { forPicker?: boolean }) {
  // FR-216 — a deactivated card must never surface in a picker.
  const activeFilter = query.forPicker ? { active: true } : activeWhere(query.active);
  const where: Prisma.RateCardWhereInput = {
    tenantId: auth.tenantId,
    ...activeFilter,
    ...(query.q
      ? {
          OR: [
            { itemName: { contains: query.q, mode: 'insensitive' } },
            { hsnSac: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.rateCard.findMany({ where, include: RATE_CARD_INCLUDE, orderBy: { itemName: 'asc' }, ...pageArgs(query) }),
    prisma.rateCard.count({ where }),
  ]);

  return { data: rows.map(serializeRateCard), page: query.page, pageSize: query.pageSize, total };
}

async function loadRateCard(auth: AuthContext, id: string) {
  const card = await prisma.rateCard.findFirst({ where: { id, tenantId: auth.tenantId }, include: RATE_CARD_INCLUDE });
  if (!card) throw notFound('Rate card not found');
  return card;
}

export async function getRateCard(auth: AuthContext, id: string) {
  return serializeRateCard(await loadRateCard(auth, id));
}

export async function createRateCard(auth: AuthContext, input: RateCardInput) {
  const duplicate = await prisma.rateCard.findFirst({
    where: { tenantId: auth.tenantId, itemName: { equals: input.itemName, mode: 'insensitive' } },
    select: { id: true },
  });
  if (duplicate) throw conflict(`A rate card for "${input.itemName}" already exists`, 'DUPLICATE_RATE_CARD');

  await resolveUom(auth.tenantId, input.uomId);

  const created = await prisma.rateCard.create({
    data: {
      tenantId: auth.tenantId,
      itemName: input.itemName,
      uomId: input.uomId,
      publishedRate: D(input.publishedRate).toFixed(4),
      hsnSac: nullable(input.hsnSac),
      gstPct: D(input.gstPct).toFixed(4),
      minCharge: D(input.minCharge).toFixed(2),
      active: input.active,
    },
    include: RATE_CARD_INCLUDE,
  });

  const dto = serializeRateCard(created);
  await audit(auth, 'RateCard', created.id, 'CREATE', null, dto);
  return dto;
}

export async function updateRateCard(auth: AuthContext, id: string, patch: RateCardPatch) {
  const existing = await loadRateCard(auth, id);
  const before = serializeRateCard(existing);

  if (patch.itemName !== undefined && patch.itemName.toLowerCase() !== existing.itemName.toLowerCase()) {
    const duplicate = await prisma.rateCard.findFirst({
      where: { tenantId: auth.tenantId, itemName: { equals: patch.itemName, mode: 'insensitive' }, id: { not: id } },
      select: { id: true },
    });
    if (duplicate) throw conflict(`A rate card for "${patch.itemName}" already exists`, 'DUPLICATE_RATE_CARD');
  }
  if (patch.uomId !== undefined) await resolveUom(auth.tenantId, patch.uomId);

  const updated = await prisma.rateCard.update({
    where: { id },
    data: {
      ...(patch.itemName !== undefined ? { itemName: patch.itemName } : {}),
      ...(patch.uomId !== undefined ? { uomId: patch.uomId } : {}),
      ...(patch.publishedRate !== undefined ? { publishedRate: D(patch.publishedRate).toFixed(4) } : {}),
      ...(patch.hsnSac !== undefined ? { hsnSac: nullable(patch.hsnSac) } : {}),
      ...(patch.gstPct !== undefined ? { gstPct: D(patch.gstPct).toFixed(4) } : {}),
      ...(patch.minCharge !== undefined ? { minCharge: D(patch.minCharge).toFixed(2) } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    },
    include: RATE_CARD_INCLUDE,
  });

  const dto = serializeRateCard(updated);
  await audit(auth, 'RateCard', id, 'UPDATE', before, dto);
  return dto;
}

export async function deleteRateCard(auth: AuthContext, id: string) {
  const existing = await loadRateCard(auth, id);
  const quoteLines = await prisma.quoteLine.count({ where: { tenantId: auth.tenantId, rateCardId: id } });

  if (quoteLines > 0) {
    throw new AppError(
      `"${existing.itemName}" is referenced by priced document lines and cannot be deleted — deactivate it instead`,
      409,
      'HAS_REFERENCES',
      { references: { quoteLines }, remedy: 'deactivate', deactivateEndpoint: `/api/rate-cards/${id}/deactivate` },
    );
  }

  await prisma.rateCard.delete({ where: { id } });
  await audit(auth, 'RateCard', id, 'DELETE', serializeRateCard(existing), null);
  return { id, deleted: true };
}

export async function deactivateRateCard(auth: AuthContext, id: string) {
  const existing = await loadRateCard(auth, id);
  if (!existing.active) return serializeRateCard(existing);
  const updated = await prisma.rateCard.update({
    where: { id },
    data: { active: false },
    include: RATE_CARD_INCLUDE,
  });
  const dto = serializeRateCard(updated);
  await audit(auth, 'RateCard', id, 'UPDATE', serializeRateCard(existing), dto);
  return dto;
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-120 / FR-121 — Bulk import
// ─────────────────────────────────────────────────────────────────────────────

export interface TemplateColumn {
  name: string;
  required: boolean;
  type: 'string' | 'number' | 'decimal' | 'date' | 'enum';
  description: string;
  values?: string[];
}

export interface ImportTemplate {
  entity: TemplateEntity;
  duplicateKey: string;
  columns: TemplateColumn[];
  sample: Record<string, string>;
  options: { onDuplicate: ['skip', 'update'] };
  rowNumbering: string;
}

const CUSTOMER_TYPES = ['REGISTERED', 'UNREGISTERED', 'COMPOSITION', 'SEZ', 'EXPORT'];
const VERTICALS = ['FLEX_LARGE_FORMAT', 'OFFSET', 'DIGITAL', 'SCREEN'];
const MATERIAL_CATEGORIES = ['PAPER', 'BOARD', 'MEDIA', 'INK', 'PLATE', 'OTHER'];

const ROW_NUMBERING = 'errorReport rows are 1-based positions in the posted `rows` array (header row excluded).';

const TEMPLATES: Record<TemplateEntity, ImportTemplate> = {
  customers: {
    entity: 'customers',
    duplicateKey: 'gstin when present, else name (case-insensitive)',
    columns: [
      { name: 'name', required: true, type: 'string', description: 'Customer legal / trade name' },
      { name: 'customerType', required: false, type: 'enum', description: 'Defaults to UNREGISTERED', values: CUSTOMER_TYPES },
      { name: 'gstin', required: false, type: 'string', description: 'Mandatory for REGISTERED / COMPOSITION / SEZ; format + checksum validated' },
      { name: 'pan', required: false, type: 'string', description: '10-character PAN' },
      { name: 'placeOfSupplyState', required: false, type: 'string', description: '2-digit GST state code; defaults to the GSTIN state code when omitted' },
      { name: 'billingAddress', required: false, type: 'string', description: 'Billing address line' },
      { name: 'billingCity', required: false, type: 'string', description: 'Billing city' },
      { name: 'billingPincode', required: false, type: 'string', description: '6-digit PIN code' },
      { name: 'phone', required: false, type: 'string', description: 'Primary phone' },
      { name: 'email', required: false, type: 'string', description: 'Primary email' },
      { name: 'creditDays', required: false, type: 'number', description: 'Credit period in days' },
      { name: 'creditLimit', required: false, type: 'decimal', description: 'Credit limit in rupees' },
      { name: 'openingBalance', required: false, type: 'decimal', description: 'Opening receivable — prefer the opening-balance import (FR-121)' },
    ],
    sample: {
      name: 'Sharma Digitals',
      customerType: 'REGISTERED',
      gstin: '27AAAPZ1234C1ZV',
      placeOfSupplyState: '27',
      phone: '9820011223',
      creditDays: '30',
      creditLimit: '100000.00',
    },
    options: { onDuplicate: ['skip', 'update'] },
    rowNumbering: ROW_NUMBERING,
  },
  suppliers: {
    entity: 'suppliers',
    duplicateKey: 'gstin when present, else name (case-insensitive)',
    columns: [
      { name: 'name', required: true, type: 'string', description: 'Supplier name' },
      { name: 'gstin', required: false, type: 'string', description: 'Format + checksum validated' },
      { name: 'pan', required: false, type: 'string', description: '10-character PAN' },
      { name: 'address', required: false, type: 'string', description: 'Supplier address' },
      { name: 'placeOfSupplyState', required: false, type: 'string', description: '2-digit GST state code; defaults to the GSTIN state code' },
      { name: 'paymentTermDays', required: false, type: 'number', description: 'Payment terms in days — drives bill due dates' },
      { name: 'openingBalance', required: false, type: 'decimal', description: 'Opening payable' },
      { name: 'phone', required: false, type: 'string', description: 'Phone' },
      { name: 'email', required: false, type: 'string', description: 'Email' },
    ],
    sample: {
      name: 'Vinyl World',
      gstin: '27AAAPZ1234C1ZV',
      placeOfSupplyState: '27',
      paymentTermDays: '30',
    },
    options: { onDuplicate: ['skip', 'update'] },
    rowNumbering: ROW_NUMBERING,
  },
  products: {
    entity: 'products',
    duplicateKey: 'skuCode',
    columns: [
      { name: 'skuCode', required: true, type: 'string', description: 'Unique SKU code within the tenant' },
      { name: 'name', required: true, type: 'string', description: 'Product name' },
      { name: 'vertical', required: true, type: 'enum', description: 'Print vertical', values: VERTICALS },
      { name: 'hsnCode', required: false, type: 'string', description: 'Existing HSN/SAC code — the row is rejected with "unknown HSN" if it does not exist' },
      { name: 'uomCode', required: false, type: 'string', description: 'Existing UOM code — rejected with "unknown UOM" if it does not exist' },
      { name: 'defaultRate', required: false, type: 'decimal', description: 'Default selling rate per UOM' },
    ],
    sample: {
      skuCode: 'FLEX-STAR',
      name: 'Star Flex Banner',
      vertical: 'FLEX_LARGE_FORMAT',
      hsnCode: '4911',
      uomCode: 'SQFT',
      defaultRate: '18.0000',
    },
    options: { onDuplicate: ['skip', 'update'] },
    rowNumbering: ROW_NUMBERING,
  },
  materials: {
    entity: 'materials',
    duplicateKey: 'itemCode',
    columns: [
      { name: 'itemCode', required: true, type: 'string', description: 'Unique item code within the tenant' },
      { name: 'name', required: true, type: 'string', description: 'Item name' },
      { name: 'category', required: true, type: 'enum', description: 'MEDIA needs rollWidthFt; PAPER/BOARD need gsm + size', values: MATERIAL_CATEGORIES },
      { name: 'uomCode', required: true, type: 'string', description: 'Existing UOM code — rejected with "unknown UOM" if it does not exist' },
      { name: 'hsnCode', required: true, type: 'string', description: 'Existing HSN/SAC code — rejected with "unknown HSN" if it does not exist' },
      { name: 'gsm', required: false, type: 'number', description: 'Required for PAPER / BOARD' },
      { name: 'size', required: false, type: 'string', description: 'Required for PAPER / BOARD (e.g. 23x36)' },
      { name: 'rollWidthFt', required: false, type: 'decimal', description: 'Required for MEDIA (feet)' },
      { name: 'sellingRate', required: false, type: 'decimal', description: 'FR-212 — leave blank to block auto-pricing' },
      { name: 'costRate', required: false, type: 'decimal', description: 'Default purchase rate' },
      { name: 'minCharge', required: false, type: 'decimal', description: 'Per-item minimum charge' },
      { name: 'gstPct', required: false, type: 'decimal', description: 'Defaults to the HSN tax rate' },
      { name: 'reorderLevel', required: false, type: 'decimal', description: 'Low-stock alert threshold' },
    ],
    sample: {
      itemCode: 'MEDIA-STAR-10',
      name: 'Star Flex 10ft',
      category: 'MEDIA',
      uomCode: 'SQFT',
      hsnCode: '3921',
      rollWidthFt: '10.0000',
      sellingRate: '14.0000',
    },
    options: { onDuplicate: ['skip', 'update'] },
    rowNumbering: ROW_NUMBERING,
  },
  'opening-balances': {
    entity: 'opening-balances',
    duplicateKey: 'party name / GSTIN per financial year — a re-import replaces the previous figure (FR-121)',
    columns: [
      { name: 'rowType', required: false, type: 'enum', description: 'PARTY (default) or STOCK', values: ['PARTY', 'STOCK'] },
      { name: 'partyType', required: false, type: 'enum', description: 'PARTY rows: CUSTOMER or SUPPLIER', values: ['CUSTOMER', 'SUPPLIER'] },
      { name: 'partyName', required: false, type: 'string', description: 'PARTY rows: existing party name (case-insensitive); use gstin instead if preferred' },
      { name: 'gstin', required: false, type: 'string', description: 'PARTY rows: alternative party lookup key' },
      { name: 'drCr', required: false, type: 'enum', description: 'PARTY rows: DR for customer receivables, CR for supplier payables', values: ['DR', 'CR'] },
      { name: 'amount', required: false, type: 'decimal', description: 'PARTY rows: opening amount in rupees' },
      { name: 'asOnDate', required: false, type: 'date', description: 'Must fall inside the target financial year; defaults to FY start' },
      { name: 'itemCode', required: false, type: 'string', description: 'STOCK rows: existing material item code — rejected with "unknown item" otherwise' },
      { name: 'branchCode', required: false, type: 'string', description: 'STOCK rows: branch the stock sits in' },
      { name: 'quantity', required: false, type: 'decimal', description: 'STOCK rows: opening quantity' },
      { name: 'rate', required: false, type: 'decimal', description: 'STOCK rows: opening rate per UOM' },
      { name: 'value', required: false, type: 'decimal', description: 'STOCK rows: opening value (defaults to quantity × rate)' },
    ],
    sample: {
      rowType: 'PARTY',
      partyType: 'CUSTOMER',
      partyName: 'Sharma Digitals',
      drCr: 'DR',
      amount: '50000.00',
      asOnDate: '2026-04-01',
    },
    options: { onDuplicate: ['skip', 'update'] },
    rowNumbering: ROW_NUMBERING,
  },
};

export function importTemplate(entity: TemplateEntity): ImportTemplate {
  return TEMPLATES[entity];
}

export type RowError = { row: number; reason: string };

class RowReject extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'RowReject';
  }
}

type SheetRow = Record<string, unknown>;

/** Sheet headers arrive in every casing and spacing; normalise once so lookups are stable. */
function normaliseRow(raw: SheetRow): SheetRow {
  const out: SheetRow = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key.trim().toLowerCase().replace(/[^a-z0-9]/g, '')] = value;
  }
  return out;
}

function cell(row: SheetRow, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text !== '') return text;
  }
  return undefined;
}

function requireCell(row: SheetRow, label: string, ...keys: string[]): string {
  const value = cell(row, ...keys);
  if (value === undefined) throw new RowReject(`${label} is required`);
  return value;
}

const DECIMAL_CELL_RE = /^-?\d{1,15}(\.\d{1,6})?$/;

function decimalCell(row: SheetRow, label: string, opts: { nonNegative?: boolean } = {}, ...keys: string[]): string | undefined {
  const value = cell(row, ...keys);
  if (value === undefined) return undefined;
  const cleaned = value.replace(/,/g, '');
  if (!DECIMAL_CELL_RE.test(cleaned)) throw new RowReject(`${label} must be a decimal number`);
  if (opts.nonNegative && cleaned.startsWith('-')) throw new RowReject(`${label} cannot be negative`);
  return cleaned;
}

function intCell(row: SheetRow, label: string, ...keys: string[]): number | undefined {
  const value = cell(row, ...keys);
  if (value === undefined) return undefined;
  if (!/^\d{1,9}$/.test(value.replace(/,/g, ''))) throw new RowReject(`${label} must be a whole number`);
  return Number(value.replace(/,/g, ''));
}

function enumCell(row: SheetRow, label: string, allowed: string[], keys: string[]): string | undefined {
  const value = cell(row, ...keys);
  if (value === undefined) return undefined;
  const upper = value.toUpperCase().replace(/[\s-]/g, '_');
  if (!allowed.includes(upper)) throw new RowReject(`${label} must be one of ${allowed.join(', ')}`);
  return upper;
}

/**
 * Drop the keys a sheet row did not carry so `onDuplicate: 'update'` patches the
 * supplied columns instead of blanking the ones the file omitted.
 */
function compact<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) if (value !== undefined) out[key] = value;
  return out as Partial<T>;
}

interface RunResult {
  rowCount: number;
  accepted: number;
  rejected: number;
  skipped: number;
  created: number;
  updated: number;
  errors: RowError[];
}

function newRunResult(rowCount: number): RunResult {
  return { rowCount, accepted: 0, rejected: 0, skipped: 0, created: 0, updated: 0, errors: [] };
}

function batchStatus(result: RunResult): string {
  if (result.rejected === 0) return 'COMPLETED';
  if (result.accepted === 0 && result.skipped === 0) return 'FAILED';
  return 'PARTIAL';
}

async function persistBatch(
  auth: AuthContext,
  entityType: string,
  fileName: string | undefined,
  result: RunResult,
): Promise<ImportBatch> {
  return prisma.importBatch.create({
    data: {
      tenantId: auth.tenantId,
      entityType,
      fileName: fileName ?? null,
      rowCount: result.rowCount,
      accepted: result.accepted,
      rejected: result.rejected,
      errorReport: result.errors as unknown as Prisma.InputJsonValue,
      status: batchStatus(result),
    },
  });
}

// ── per-entity row handlers ──────────────────────────────────────────────────

async function importCustomerRow(auth: AuthContext, row: SheetRow, onDuplicate: 'skip' | 'update', result: RunResult): Promise<void> {
  const name = requireCell(row, 'name', 'name', 'customername', 'customer');
  const customerType = enumCell(row, 'customerType', CUSTOMER_TYPES, ['customertype', 'type', 'gstregistrationtype']) ?? 'UNREGISTERED';

  const gstinRaw = cell(row, 'gstin', 'gstno', 'gstnumber');
  let gstin: string | null = null;
  if (gstinRaw) {
    const check = validateGstin(gstinRaw);
    if (!check.valid) throw new RowReject(check.message ?? 'invalid GSTIN');
    gstin = gstinRaw.trim().toUpperCase();
  }
  if (GSTIN_REQUIRED_TYPES.has(customerType) && !gstin) {
    throw new RowReject(`GSTIN is mandatory for ${customerType} customers`);
  }

  const placeOfSupplyState = cell(row, 'placeofsupplystate', 'placeofsupply', 'statecode', 'state') ?? stateCodeFromGstin(gstin);
  if (!placeOfSupplyState) throw new RowReject('placeOfSupplyState is required');
  if (!isValidStateCode(placeOfSupplyState)) throw new RowReject(`unknown state code "${placeOfSupplyState}"`);

  const creditLimit = decimalCell(row, 'creditLimit', { nonNegative: true }, 'creditlimit');
  const openingBalance = decimalCell(row, 'openingBalance', {}, 'openingbalance');

  const data = compact({
    name,
    customerType: customerType as Prisma.CustomerCreateInput['customerType'],
    gstin: gstinRaw === undefined ? undefined : gstin,
    pan: cell(row, 'pan'),
    placeOfSupplyState,
    billingAddress: cell(row, 'billingaddress', 'address'),
    billingCity: cell(row, 'billingcity', 'city'),
    billingPincode: cell(row, 'billingpincode', 'pincode', 'pin'),
    phone: cell(row, 'phone', 'mobile', 'contactno'),
    email: cell(row, 'email'),
    creditDays: intCell(row, 'creditDays', 'creditdays'),
    creditLimit: creditLimit === undefined ? undefined : D(creditLimit).toFixed(2),
    openingBalance: openingBalance === undefined ? undefined : D(openingBalance).toFixed(2),
  });

  const existing = await prisma.customer.findFirst({
    where: {
      tenantId: auth.tenantId,
      ...(gstin ? { gstin } : { name: { equals: name, mode: 'insensitive' as const } }),
    },
    select: { id: true },
  });

  if (existing) {
    if (onDuplicate === 'skip') {
      result.skipped += 1;
      return;
    }
    await prisma.customer.update({ where: { id: existing.id }, data });
    result.accepted += 1;
    result.updated += 1;
    await audit(auth, 'Customer', existing.id, 'UPDATE', null, { name, source: 'import' });
    return;
  }

  const created = await prisma.customer.create({
    data: { tenantId: auth.tenantId, phone: '', ...data, name, placeOfSupplyState },
  });
  result.accepted += 1;
  result.created += 1;
  await audit(auth, 'Customer', created.id, 'CREATE', null, { name, source: 'import' });
}

async function importSupplierRow(auth: AuthContext, row: SheetRow, onDuplicate: 'skip' | 'update', result: RunResult): Promise<void> {
  const name = requireCell(row, 'name', 'name', 'suppliername', 'vendor', 'vendorname');

  const gstinRaw = cell(row, 'gstin', 'gstno', 'gstnumber');
  let gstin: string | null = null;
  if (gstinRaw) {
    const check = validateGstin(gstinRaw);
    if (!check.valid) throw new RowReject(check.message ?? 'invalid GSTIN');
    gstin = gstinRaw.trim().toUpperCase();
  }

  const placeOfSupplyState = cell(row, 'placeofsupplystate', 'placeofsupply', 'statecode', 'state') ?? stateCodeFromGstin(gstin);
  if (!placeOfSupplyState) throw new RowReject('placeOfSupplyState is required');
  if (!isValidStateCode(placeOfSupplyState)) throw new RowReject(`unknown state code "${placeOfSupplyState}"`);

  const openingBalance = decimalCell(row, 'openingBalance', {}, 'openingbalance');

  const data = compact({
    name,
    gstin: gstinRaw === undefined ? undefined : gstin,
    pan: cell(row, 'pan'),
    address: cell(row, 'address'),
    placeOfSupplyState,
    paymentTermDays: intCell(row, 'paymentTermDays', 'paymenttermdays', 'paymentterms', 'creditdays'),
    openingBalance: openingBalance === undefined ? undefined : D(openingBalance).toFixed(2),
    phone: cell(row, 'phone', 'mobile'),
    email: cell(row, 'email'),
  });

  const existing = await prisma.supplier.findFirst({
    where: {
      tenantId: auth.tenantId,
      ...(gstin ? { gstin } : { name: { equals: name, mode: 'insensitive' as const } }),
    },
    select: { id: true },
  });

  if (existing) {
    if (onDuplicate === 'skip') {
      result.skipped += 1;
      return;
    }
    await prisma.supplier.update({ where: { id: existing.id }, data });
    result.accepted += 1;
    result.updated += 1;
    await audit(auth, 'Supplier', existing.id, 'UPDATE', null, { name, source: 'import' });
    return;
  }

  const created = await prisma.supplier.create({
    data: { tenantId: auth.tenantId, ...data, name, placeOfSupplyState },
  });
  result.accepted += 1;
  result.created += 1;
  await audit(auth, 'Supplier', created.id, 'CREATE', null, { name, source: 'import' });
}

async function importProductRow(auth: AuthContext, row: SheetRow, onDuplicate: 'skip' | 'update', result: RunResult): Promise<void> {
  const skuCode = requireCell(row, 'skuCode', 'skucode', 'sku', 'code');
  const name = requireCell(row, 'name', 'name', 'productname');
  const vertical = enumCell(row, 'vertical', VERTICALS, ['vertical', 'producttype']);
  if (!vertical) throw new RowReject('vertical is required');

  // FR-120 AC — "a product row referencing a non-existent HSN … rejected with an 'unknown HSN' reason".
  const hsnCode = cell(row, 'hsncode', 'hsn', 'hsnsac', 'sac');
  let hsn: HsnWithDefaults | null = null;
  if (hsnCode) {
    hsn = await prisma.hsnSacCode.findFirst({
      where: { tenantId: auth.tenantId, code: hsnCode, active: true },
      include: { defaultTaxRate: true, defaultUom: true },
    });
    if (!hsn) throw new RowReject('unknown HSN');
  }

  const uomCode = cell(row, 'uomcode', 'uom', 'unit');
  let uomId: string | null = hsn?.defaultUomId ?? null;
  if (uomCode) {
    const uom = await prisma.unitOfMeasure.findFirst({
      where: { tenantId: auth.tenantId, uomCode, active: true },
      select: { id: true },
    });
    if (!uom) throw new RowReject('unknown UOM');
    uomId = uom.id;
  }

  const defaultRate = decimalCell(row, 'defaultRate', { nonNegative: true }, 'defaultrate', 'rate');

  const data = compact({
    skuCode,
    name,
    vertical: vertical as Prisma.ProductCreateInput['vertical'],
    hsnSacId: hsn?.id,
    defaultUomId: uomId ?? undefined,
    // FR-115 — the product inherits the HSN's default tax rate.
    taxRateId: hsn?.defaultTaxRateId ?? undefined,
    defaultRate: defaultRate === undefined ? undefined : D(defaultRate).toFixed(4),
  });

  const existing = await prisma.product.findFirst({
    where: { tenantId: auth.tenantId, skuCode },
    select: { id: true },
  });

  if (existing) {
    if (onDuplicate === 'skip') {
      result.skipped += 1;
      return;
    }
    await prisma.product.update({ where: { id: existing.id }, data });
    result.accepted += 1;
    result.updated += 1;
    return;
  }

  await prisma.product.create({
    data: { tenantId: auth.tenantId, ...data, skuCode, name, vertical: vertical as Prisma.ProductCreateInput['vertical'] },
  });
  result.accepted += 1;
  result.created += 1;
}

async function importMaterialRow(auth: AuthContext, row: SheetRow, onDuplicate: 'skip' | 'update', result: RunResult): Promise<void> {
  const itemCode = requireCell(row, 'itemCode', 'itemcode', 'code', 'sku');
  const name = requireCell(row, 'name', 'name', 'itemname');
  const category = enumCell(row, 'category', MATERIAL_CATEGORIES, ['category']);
  if (!category) throw new RowReject('category is required');

  const uomCode = cell(row, 'uomcode', 'uom', 'unit');
  if (!uomCode) throw new RowReject('unknown UOM');
  const uom = await prisma.unitOfMeasure.findFirst({
    where: { tenantId: auth.tenantId, uomCode, active: true },
    select: { id: true },
  });
  if (!uom) throw new RowReject('unknown UOM');

  const hsnCode = cell(row, 'hsncode', 'hsn', 'hsnsac', 'sac');
  if (!hsnCode) throw new RowReject('unknown HSN');
  const hsn = await prisma.hsnSacCode.findFirst({
    where: { tenantId: auth.tenantId, code: hsnCode, active: true },
    include: { defaultTaxRate: true },
  });
  if (!hsn) throw new RowReject('unknown HSN');

  const gsm = intCell(row, 'gsm', 'gsm') ?? null;
  const size = cell(row, 'size') ?? null;
  const rollWidthFt = decimalCell(row, 'rollWidthFt', { nonNegative: true }, 'rollwidthft', 'rollwidth') ?? null;

  // FR-116 — category-conditional mandatory attributes.
  if (category === 'MEDIA' && rollWidthFt === null) throw new RowReject('MEDIA items require rollWidthFt');
  if ((category === 'PAPER' || category === 'BOARD') && (gsm === null || !size)) {
    throw new RowReject(`${category} items require gsm and size`);
  }

  const gstPct = decimalCell(row, 'gstPct', { nonNegative: true }, 'gstpct', 'gst', 'taxrate');
  const sellingRate = decimalCell(row, 'sellingRate', { nonNegative: true }, 'sellingrate', 'rate');
  const costRate = decimalCell(row, 'costRate', { nonNegative: true }, 'costrate', 'purchaserate');

  const minCharge = decimalCell(row, 'minCharge', { nonNegative: true }, 'mincharge');
  const reorderLevel = decimalCell(row, 'reorderLevel', { nonNegative: true }, 'reorderlevel');

  const data = compact({
    itemCode,
    name,
    category: category as Prisma.MaterialItemCreateInput['category'],
    gsm: gsm ?? undefined,
    size: size ?? undefined,
    rollWidthFt: rollWidthFt === null ? undefined : D(rollWidthFt).toFixed(4),
    uomId: uom.id,
    hsnSacId: hsn.id,
    // FR-212 — a missing selling rate stays null so auto-pricing refuses to price.
    sellingRate: sellingRate === undefined ? undefined : D(sellingRate).toFixed(4),
    costRate: costRate === undefined ? undefined : D(costRate).toFixed(4),
    minCharge: minCharge === undefined ? undefined : D(minCharge).toFixed(2),
    gstPct:
      gstPct !== undefined
        ? D(gstPct).toFixed(4)
        : hsn.defaultTaxRate
          ? D(hsn.defaultTaxRate.gstPct.toString()).toFixed(4)
          : undefined,
    reorderLevel: reorderLevel === undefined ? undefined : D(reorderLevel).toFixed(4),
  });

  const existing = await prisma.materialItem.findFirst({
    where: { tenantId: auth.tenantId, itemCode },
    select: { id: true },
  });

  if (existing) {
    if (onDuplicate === 'skip') {
      result.skipped += 1;
      return;
    }
    await prisma.materialItem.update({ where: { id: existing.id }, data });
    result.accepted += 1;
    result.updated += 1;
    await audit(auth, 'MaterialItem', existing.id, 'UPDATE', null, { itemCode, source: 'import' });
    return;
  }

  const created = await prisma.materialItem.create({
    data: {
      tenantId: auth.tenantId,
      ...data,
      itemCode,
      name,
      category: category as Prisma.MaterialItemCreateInput['category'],
      uomId: uom.id,
    },
  });
  result.accepted += 1;
  result.created += 1;
  await audit(auth, 'MaterialItem', created.id, 'CREATE', null, { itemCode, source: 'import' });
}

/**
 * FR-120 — partial commit: valid rows are created/updated, invalid rows land in
 * the error report with a reason; the ImportBatch keeps the accepted/rejected
 * counts and the downloadable report.
 */
export async function runImport(
  auth: AuthContext,
  entity: ImportEntity,
  body: z.output<typeof importBodySchema>,
) {
  const result = newRunResult(body.rows.length);

  for (let i = 0; i < body.rows.length; i++) {
    const row = normaliseRow(body.rows[i]);
    try {
      if (entity === 'customers') await importCustomerRow(auth, row, body.onDuplicate, result);
      else if (entity === 'suppliers') await importSupplierRow(auth, row, body.onDuplicate, result);
      else if (entity === 'products') await importProductRow(auth, row, body.onDuplicate, result);
      else await importMaterialRow(auth, row, body.onDuplicate, result);
    } catch (err) {
      result.rejected += 1;
      result.errors.push({ row: i + 1, reason: err instanceof RowReject ? err.reason : rejectReason(err) });
    }
  }

  const batch = await persistBatch(auth, entity, body.fileName, result);
  return {
    ...serializeImportBatch(batch),
    entity,
    created: result.created,
    updated: result.updated,
    onDuplicate: body.onDuplicate,
  };
}

function rejectReason(err: unknown): string {
  if (err instanceof AppError) return err.message;
  const prismaErr = err as { code?: string; meta?: { target?: string[] } };
  if (prismaErr?.code === 'P2002') return `duplicate ${(prismaErr.meta?.target ?? ['value']).join(', ')}`;
  if (err instanceof Error) return err.message;
  return 'row could not be imported';
}

// ── FR-121 opening balances ──────────────────────────────────────────────────

/**
 * FR-121 — "Re-import for the same FY replaces prior opening balances rather
 * than adding to them (idempotent)". Modelled by overwriting the party's
 * openingBalance, never accumulating onto it.
 */
export async function runOpeningBalanceImport(
  auth: AuthContext,
  body: z.output<typeof openingBalanceImportSchema>,
) {
  const fy = body.fyLabel
    ? await prisma.financialYear.findFirst({ where: { tenantId: auth.tenantId, fyLabel: body.fyLabel } })
    : ((await prisma.financialYear.findFirst({ where: { tenantId: auth.tenantId, isCurrent: true } })) ??
      (await prisma.financialYear.findFirst({
        where: { tenantId: auth.tenantId, status: 'OPEN' },
        orderBy: { startDate: 'desc' },
      })));

  if (!fy) {
    throw badRequest(
      'No financial year is available — create the current FY in Setup before importing opening balances',
      'NO_OPEN_FY',
    );
  }
  if (fy.status === 'CLOSED') {
    throw unprocessable(`Financial year ${fy.fyLabel} is closed — opening balances cannot be imported into it`, 'FY_CLOSED');
  }

  const fyStart = toDateOnly(fy.startDate);
  const fyEnd = toDateOnly(fy.endDate);
  const result = newRunResult(body.rows.length);
  const parties = { customers: 0, suppliers: 0 };
  const stock = { validated: 0 };

  for (let i = 0; i < body.rows.length; i++) {
    const row = normaliseRow(body.rows[i]);
    try {
      const rowType =
        enumCell(row, 'rowType', ['PARTY', 'STOCK'], ['rowtype']) ??
        (cell(row, 'itemcode', 'item') ? 'STOCK' : 'PARTY');

      if (rowType === 'STOCK') {
        await importOpeningStockRow(auth, row, fyStart, fyEnd);
        stock.validated += 1;
        result.accepted += 1;
      } else {
        const partyType = await importOpeningPartyRow(auth, row, fyStart, fyEnd);
        if (partyType === 'CUSTOMER') parties.customers += 1;
        else parties.suppliers += 1;
        result.accepted += 1;
      }
    } catch (err) {
      result.rejected += 1;
      result.errors.push({ row: i + 1, reason: err instanceof RowReject ? err.reason : rejectReason(err) });
    }
  }

  const batch = await persistBatch(auth, 'opening-balances', body.fileName ?? `opening-balances ${fy.fyLabel}`, result);

  return {
    ...serializeImportBatch(batch),
    entity: 'opening-balances' as const,
    fy: { id: fy.id, fyLabel: fy.fyLabel, startDate: isoDate(fy.startDate), endDate: isoDate(fy.endDate) },
    idempotent: true,
    parties,
    stock: {
      ...stock,
      posted: 0,
      note: 'Opening stock rows are validated here; posting lands with the Inventory module (Phase 1 has no stock ledger).',
    },
  };
}

async function importOpeningPartyRow(auth: AuthContext, row: SheetRow, fyStart: Date, fyEnd: Date): Promise<'CUSTOMER' | 'SUPPLIER'> {
  const partyType = enumCell(row, 'partyType', ['CUSTOMER', 'SUPPLIER'], ['partytype', 'party']) ?? 'CUSTOMER';
  const partyName = cell(row, 'partyname', 'name', 'customer', 'suppliername', 'customername');
  const gstin = cell(row, 'gstin', 'gstno');
  if (!partyName && !gstin) throw new RowReject('partyName or gstin is required');

  const drCr = enumCell(row, 'drCr', ['DR', 'CR'], ['drcr', 'direction']) ?? (partyType === 'CUSTOMER' ? 'DR' : 'CR');
  // FR-121 — "Dr/Cr direction is validated (receivable vs payable)".
  if (partyType === 'CUSTOMER' && drCr !== 'DR') {
    throw new RowReject('customer opening balances are receivable and must be Dr');
  }
  if (partyType === 'SUPPLIER' && drCr !== 'CR') {
    throw new RowReject('supplier opening balances are payable and must be Cr');
  }

  const amount = decimalCell(row, 'amount', { nonNegative: true }, 'amount', 'openingbalance', 'balance');
  if (amount === undefined) throw new RowReject('amount is required');

  const asOnRaw = cell(row, 'asondate', 'ason', 'date');
  if (asOnRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOnRaw)) throw new RowReject('asOnDate must be in YYYY-MM-DD form');
    const asOn = parseIsoDate(asOnRaw);
    if (asOn.getTime() < fyStart.getTime() || asOn.getTime() > fyEnd.getTime()) {
      throw new RowReject('asOnDate falls outside the target financial year');
    }
  }

  const where = {
    tenantId: auth.tenantId,
    ...(gstin ? { gstin: gstin.toUpperCase() } : { name: { equals: partyName as string, mode: 'insensitive' as const } }),
  };

  if (partyType === 'CUSTOMER') {
    const customer = await prisma.customer.findFirst({ where, select: { id: true } });
    if (!customer) throw new RowReject('unknown customer');
    // Overwrite, never accumulate (FR-121 idempotency).
    await prisma.customer.update({ where: { id: customer.id }, data: { openingBalance: D(amount).toFixed(2) } });
    await audit(auth, 'Customer', customer.id, 'UPDATE', null, { openingBalance: money(amount), source: 'opening-balance-import' });
    return 'CUSTOMER';
  }

  const supplier = await prisma.supplier.findFirst({ where, select: { id: true } });
  if (!supplier) throw new RowReject('unknown supplier');
  await prisma.supplier.update({ where: { id: supplier.id }, data: { openingBalance: D(amount).toFixed(2) } });
  await audit(auth, 'Supplier', supplier.id, 'UPDATE', null, { openingBalance: money(amount), source: 'opening-balance-import' });
  return 'SUPPLIER';
}

async function importOpeningStockRow(auth: AuthContext, row: SheetRow, fyStart: Date, fyEnd: Date): Promise<void> {
  const itemCode = cell(row, 'itemcode', 'item', 'code');
  if (!itemCode) throw new RowReject('unknown item');

  // FR-121 AC — "an opening-stock row for a non-existent item … rejected with an 'unknown item' reason".
  const item = await prisma.materialItem.findFirst({
    where: { tenantId: auth.tenantId, itemCode },
    select: { id: true },
  });
  if (!item) throw new RowReject('unknown item');

  const branchCode = cell(row, 'branchcode', 'branch');
  if (branchCode) {
    const branch = await prisma.branch.findFirst({
      where: { tenantId: auth.tenantId, branchCode },
      select: { id: true },
    });
    if (!branch) throw new RowReject('unknown branch');
    // BR-4 / FR-717 — a user may only load stock for branches they are assigned to.
    if (!auth.allBranches && !auth.branchIds.includes(branch.id)) {
      throw new RowReject('branch not permitted for this user');
    }
  }

  const quantity = decimalCell(row, 'quantity', { nonNegative: true }, 'quantity', 'qty');
  if (quantity === undefined) throw new RowReject('quantity is required');
  decimalCell(row, 'rate', { nonNegative: true }, 'rate');
  decimalCell(row, 'value', { nonNegative: true }, 'value', 'amount');

  const asOnRaw = cell(row, 'asondate', 'ason', 'date');
  if (asOnRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOnRaw)) throw new RowReject('asOnDate must be in YYYY-MM-DD form');
    const asOn = parseIsoDate(asOnRaw);
    if (asOn.getTime() < fyStart.getTime() || asOn.getTime() > fyEnd.getTime()) {
      throw new RowReject('asOnDate falls outside the target financial year');
    }
  }
}

// ── batch history ────────────────────────────────────────────────────────────

export async function listImportBatches(
  auth: AuthContext,
  query: { entity?: string; page: number; pageSize: number },
) {
  const where: Prisma.ImportBatchWhereInput = {
    tenantId: auth.tenantId,
    ...(query.entity ? { entityType: query.entity } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.importBatch.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(query) }),
    prisma.importBatch.count({ where }),
  ]);

  return { data: rows.map(serializeImportBatch), page: query.page, pageSize: query.pageSize, total };
}

export async function getImportBatch(auth: AuthContext, id: string) {
  const batch = await prisma.importBatch.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!batch) throw notFound('Import batch not found');
  return serializeImportBatch(batch);
}
