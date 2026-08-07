/**
 * FR-106 / FR-107 / FR-303 · BR-3 — document numbering.
 *
 * "Every statutory document number is unique, gap-free, sequential, per document
 *  type, per branch, and resets each financial year … Numbers are allocated at
 *  finalisation (not draft) and never reused, even on void."
 *
 * Concurrency safety comes from `SELECT … FOR UPDATE` inside the caller's
 * transaction, so two simultaneous commits get consecutive distinct numbers.
 */
import type { Prisma, DocType } from '@prisma/client';
import { AppError } from '../http/errors.js';

export interface SeriesShape {
  prefix: string;
  suffix: string;
  padding: number;
  nextNumber: number;
}

export interface RenderContext {
  branchCode?: string;
  fyLabel?: string;
}

/**
 * FR-106 — "Prefix/suffix support tokens for branch code and FY label
 * (e.g., `INV/{BR}/{FY}/0001`)".
 */
export function renderNumber(series: SeriesShape, seq: number, ctx: RenderContext = {}): string {
  const body = String(seq).padStart(Math.max(0, series.padding), '0');
  const expand = (s: string) =>
    s.replace(/\{BR\}/g, ctx.branchCode ?? '').replace(/\{FY\}/g, ctx.fyLabel ?? '');
  return `${expand(series.prefix)}${body}${expand(series.suffix)}`;
}

/** FR-106 — "rendered number must be ≤16 characters for tax invoices to remain GST-compliant." */
export const GST_DOC_NUMBER_MAX_LENGTH = 16;

export const GST_LENGTH_ENFORCED_DOCS: DocType[] = ['INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE'];

export function validateRenderedLength(docType: DocType, rendered: string): void {
  if (GST_LENGTH_ENFORCED_DOCS.includes(docType) && rendered.length > GST_DOC_NUMBER_MAX_LENGTH) {
    throw new AppError(
      `A ${docType} number may not exceed ${GST_DOC_NUMBER_MAX_LENGTH} characters (rendered "${rendered}" is ${rendered.length})`,
      422,
      'DOC_NUMBER_TOO_LONG',
    );
  }
}

export interface AllocateArgs {
  tx: Prisma.TransactionClient;
  tenantId: string;
  docType: DocType;
  branchId: string | null;
  fyId: string | null;
  branchCode?: string;
  fyLabel?: string;
}

/**
 * Atomically consume the next number in a series and return the rendered string.
 * MUST be called inside a transaction that only commits when the document commits —
 * that is what makes the final sequence gap-free (FR-107).
 */
export async function allocateNumber({
  tx,
  tenantId,
  docType,
  branchId,
  fyId,
  branchCode,
  fyLabel,
}: AllocateArgs): Promise<{ number: string; seq: number; seriesId: string }> {
  // Lock the series row for the duration of the transaction.
  // `nextNumber` carries no @map, so the Postgres column is the camel-cased "nextNumber"
  // and MUST stay double-quoted — unquoted it folds to lowercase and errors 42703.
  const locked = await tx.$queryRawUnsafe<Array<{ id: string; prefix: string; suffix: string; padding: number; nextNumber: number }>>(
    `SELECT id, prefix, suffix, padding, "nextNumber"
       FROM numbering_series
      WHERE "tenantId" = $1
        AND "docType" = $2::"DocType"
        AND ("branchId" = $3 OR ($3 IS NULL AND "branchId" IS NULL))
        AND ("fyId" = $4 OR ($4 IS NULL AND "fyId" IS NULL))
        AND active = true
      FOR UPDATE`,
    tenantId,
    docType,
    branchId,
    fyId,
  );

  const row = locked[0];
  if (!row) {
    throw new AppError(
      `No active numbering series configured for ${docType}. Add one in Settings → Document Numbering.`,
      422,
      'NUMBERING_SERIES_MISSING',
    );
  }

  const seq = row.nextNumber;
  const rendered = renderNumber(
    { prefix: row.prefix, suffix: row.suffix, padding: row.padding, nextNumber: seq },
    seq,
    { branchCode, fyLabel },
  );

  validateRenderedLength(docType, rendered);

  await tx.numberingSeries.update({
    where: { id: row.id },
    data: { nextNumber: seq + 1, lastIssuedAt: new Date() },
  });

  return { number: rendered, seq, seriesId: row.id };
}

/** Default series shipped by the setup wizard (FR-100: "pre-seeds … default numbering series"). */
export const DEFAULT_SERIES: Array<{ docType: DocType; prefix: string; padding: number }> = [
  { docType: 'QUOTATION', prefix: 'QUO/{FY}/', padding: 5 },
  { docType: 'JOBCARD', prefix: 'JC/{FY}/', padding: 5 },
  { docType: 'INVOICE', prefix: 'INV/', padding: 5 },
  { docType: 'PROFORMA', prefix: 'PI/{FY}/', padding: 5 },
  { docType: 'DELIVERY_CHALLAN', prefix: 'DC/{FY}/', padding: 5 },
  { docType: 'PURCHASE_ORDER', prefix: 'PO/{FY}/', padding: 5 },
  { docType: 'GRN', prefix: 'GRN/{FY}/', padding: 5 },
  { docType: 'CREDIT_NOTE', prefix: 'CN/', padding: 5 },
  { docType: 'DEBIT_NOTE', prefix: 'DN/', padding: 5 },
  { docType: 'RECEIPT', prefix: 'RCP/{FY}/', padding: 5 },
  { docType: 'PAYMENT', prefix: 'PAY/{FY}/', padding: 5 },
];
