/**
 * FR-718 / BR-9 — basic audit log.
 *
 * "Captures entity type, entity id, action, actor, branch and timestamp; for
 *  edits/deletes, retains at least the key before/after values … Audit entries
 *  are append-only (cannot be edited/deleted from the UI) and are tenant/branch
 *  scoped."
 *
 * Every module writes through this one helper; there is deliberately no update
 * or delete counterpart.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';

export type AuditAction = 'CREATE' | 'UPDATE' | 'VOID' | 'DELETE' | 'EXPORT' | 'LOGIN' | 'ROLLOVER' | (string & {});

export interface AuditInput {
  tenantId: string;
  entityType: string;
  entityId: string;
  action: AuditAction;
  branchId?: string | null;
  actorId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Pass the transaction client when the audited change is itself transactional. */
  tx?: Prisma.TransactionClient;
}

/**
 * Coerce an arbitrary snapshot into storable JSON. Prisma `Decimal` and `Date`
 * both carry a `toJSON`, so money values land as exact strings, never floats
 * (BR-1). Anything unserialisable is dropped rather than failing the audited
 * business action.
 */
function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const serialised = JSON.stringify(value);
    if (serialised === undefined) return undefined;
    return JSON.parse(serialised) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}

/** Append one audit row. Never mutates or removes existing rows. */
export async function recordAudit(input: AuditInput): Promise<void> {
  const client = input.tx ?? prisma;
  await client.auditLog.create({
    data: {
      tenantId: input.tenantId,
      branchId: input.branchId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      actorId: input.actorId && input.actorId.length > 0 ? input.actorId : null,
      before: toJson(input.before),
      after: toJson(input.after),
    },
  });
}

/**
 * Reduce a Prisma row to the "key values" FR-718 asks edits to retain, so audit
 * payloads stay small and readable.
 */
export function auditSnapshot<T extends Record<string, unknown>>(row: T | null | undefined, fields: Array<keyof T>): Record<string, unknown> | undefined {
  if (!row) return undefined;
  const out: Record<string, unknown> = {};
  for (const field of fields) out[String(field)] = row[field];
  return out;
}
