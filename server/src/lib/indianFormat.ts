/**
 * FR-122 · FR-123 · FR-720 — Indian number presentation and amount-in-words.
 * Shared utility: presentation only, stored values stay exact decimals.
 */
import { D, Numeric, round2 } from './money.js';

/**
 * FR-122 — Indian digit grouping: last three digits, then pairs.
 *   1234567.89 → "12,34,567.89"
 */
export function formatIndian(value: Numeric, decimals = 2): string {
  const dec = D(value);
  const negative = dec.isNegative();
  const fixed = dec.abs().toFixed(decimals);
  const [whole, fraction] = fixed.split('.');

  let grouped: string;
  if (whole.length <= 3) {
    grouped = whole;
  } else {
    const lastThree = whole.slice(-3);
    const rest = whole.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree;
  }

  const out = fraction ? `${grouped}.${fraction}` : grouped;
  return negative ? `-${out}` : out;
}

/** FR-122 — currency display: 100000 → "₹1,00,000.00" */
export function formatCurrency(value: Numeric): string {
  const dec = D(value);
  const body = formatIndian(dec.abs(), 2);
  return dec.isNegative() ? `-₹${body}` : `₹${body}`;
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o === 0 ? TENS[t] : `${TENS[t]} ${ONES[o]}`;
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${ONES[h]} Hundred`);
  if (rest > 0) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/**
 * Indian-scale words for a non-negative integer (crore / lakh / thousand / hundred).
 * Handles up to 99,99,99,99,999 (arab) which is far beyond any print-shop invoice.
 */
export function integerToIndianWords(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('integerToIndianWords expects a non-negative integer');
  const n = Math.trunc(value);
  if (n === 0) return 'Zero';

  const parts: string[] = [];
  const arab = Math.floor(n / 1_00_00_00_000);
  const crore = Math.floor((n % 1_00_00_00_000) / 1_00_00_000);
  const lakh = Math.floor((n % 1_00_00_000) / 1_00_000);
  const thousand = Math.floor((n % 1_00_000) / 1000);
  const rest = n % 1000;

  if (arab > 0) parts.push(`${twoDigits(arab)} Arab`);
  if (crore > 0) parts.push(`${twoDigits(crore)} Crore`);
  if (lakh > 0) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest > 0) parts.push(threeDigits(rest));

  return parts.join(' ');
}

export interface AmountInWordsOptions {
  /** FR-123 — "zero paise renders '... and Zero Paise Only' or omits paise per a configured style." */
  zeroPaiseStyle?: 'omit' | 'explicit';
  currencyWord?: string;
}

/**
 * FR-123 / FR-720 — convert a payable to English words in the Indian system.
 *   1234567.89 → "Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only"
 *   1235       → "Rupees One Thousand Two Hundred Thirty Five Only"
 *
 * Caller must pass the ROUNDED payable (post FR-112) so the words match the
 * printed grand total exactly.
 */
export function amountInWords(value: Numeric, options: AmountInWordsOptions = {}): string {
  const { zeroPaiseStyle = 'omit', currencyWord = 'Rupees' } = options;

  const dec = round2(value);
  const negative = dec.isNegative();
  const abs = dec.abs();

  const rupees = abs.floor().toNumber();
  const paise = abs.minus(abs.floor()).times(100).round().toNumber();

  const rupeeWords = integerToIndianWords(rupees);

  let text: string;
  if (paise > 0) {
    text = `${currencyWord} ${rupeeWords} and ${integerToIndianWords(paise)} Paise Only`;
  } else if (zeroPaiseStyle === 'explicit') {
    text = `${currencyWord} ${rupeeWords} and Zero Paise Only`;
  } else {
    text = `${currencyWord} ${rupeeWords} Only`;
  }

  return negative ? `Minus ${text}` : text;
}
