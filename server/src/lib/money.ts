/**
 * Money primitives — BR-1 (§10): "All monetary, quantity-rate and tax values use
 * fixed-precision decimals. Floating-point arithmetic on money is prohibited."
 *
 * Every amount in Leo Ink flows through these helpers so the single documented
 * rounding policy of FR-215 ("half-up to 2 decimals at defined steps") holds
 * identically on a quotation and on the invoice it becomes.
 */
// Named import, not default: decimal.js@10.6.0's decimal.d.ts declares both
// `export declare class Decimal` and `export declare function Decimal(n)`. A class and a
// function cannot merge, so the *default* export collapses to the namespace alone and every
// `new Decimal()` / `: Decimal` downstream fails (TS2351 / TS2709). The named binding
// resolves to the class. `export var Decimal` exists in decimal.mjs and `.Decimal` on the
// CJS build, so runtime behaviour is identical in both module formats.
import { Decimal } from 'decimal.js';

// Half-up everywhere, with generous working precision before the explicit rounds.
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 40 });

export { Decimal };

export type Numeric = Decimal | number | string | null | undefined;

/** Coerce anything (including Prisma Decimal / null) to a Decimal. Null-ish → 0. */
export function D(value: Numeric): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  if (value instanceof Decimal) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number in money math: ${value}`);
    // Route through the string form so a float literal never leaks binary error.
    return new Decimal(value.toString());
  }
  return new Decimal(String(value));
}

/** Currency precision — 2 decimals, half-up (FR-215). */
export function round2(value: Numeric): Decimal {
  return D(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Rate precision — BR-1: "rates may hold up to 4" decimals. */
export function round4(value: Numeric): Decimal {
  return D(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

export const ZERO = new Decimal(0);

export function sum(values: Numeric[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(D(v)), new Decimal(0));
}

export type RoundingMode = 'NORMAL' | 'UP' | 'DOWN' | 'NONE';

export interface RoundOffResult {
  /** The value actually payable after rounding. */
  payable: Decimal;
  /** rounded − computed. FR-112: total 1234.60 → payable 1235.00, roundOff +0.40. */
  roundOff: Decimal;
}

/**
 * FR-112 / FR-215 — round the grand total and expose the adjustment separately.
 * `precision` 0 = nearest rupee, 2 = paise. Line and tax figures are untouched
 * (FR-502: round-off "must never alter reported taxable value or tax heads").
 */
export function applyRounding(total: Numeric, mode: RoundingMode = 'NORMAL', precision = 0): RoundOffResult {
  const computed = round2(total);
  if (mode === 'NONE') return { payable: computed, roundOff: new Decimal(0) };

  const dpMode =
    mode === 'UP' ? Decimal.ROUND_CEIL : mode === 'DOWN' ? Decimal.ROUND_FLOOR : Decimal.ROUND_HALF_UP;

  const payable = computed.toDecimalPlaces(precision, dpMode);
  return { payable, roundOff: round2(payable.minus(computed)) };
}

/**
 * Distribute `total` across `weights` pro-rata, guaranteeing the parts sum back to
 * `total` exactly at 2 decimals — the residue from rounding lands on the largest
 * weight. Used for bill-level discount apportionment (FR-214 / FR-502).
 */
export function apportion(total: Numeric, weights: Numeric[]): Decimal[] {
  const amount = round2(total);
  if (amount.isZero() || weights.length === 0) return weights.map(() => new Decimal(0));

  const wDec = weights.map(D);
  const weightTotal = sum(wDec);

  if (weightTotal.isZero()) {
    // Degenerate: nothing to weight by — spread equally, residue on the first part.
    const each = round2(amount.dividedBy(weights.length));
    const parts = wDec.map(() => each);
    parts[0] = round2(amount.minus(each.times(weights.length - 1)));
    return parts;
  }

  const parts = wDec.map((w) => round2(amount.times(w).dividedBy(weightTotal)));
  const residue = amount.minus(sum(parts));
  if (!residue.isZero()) {
    let biggest = 0;
    for (let i = 1; i < wDec.length; i++) if (wDec[i].greaterThan(wDec[biggest])) biggest = i;
    parts[biggest] = round2(parts[biggest].plus(residue));
  }
  return parts;
}

/** Serialise a Decimal for JSON responses without ever going through a float. */
export function money(value: Numeric): string {
  return round2(value).toFixed(2);
}

export function rate(value: Numeric): string {
  return round4(value).toFixed(4);
}
