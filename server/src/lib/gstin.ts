/**
 * BR-6 — "GSTIN is validated for 15-char format + checksum".
 * FR-101 · FR-113 · FR-114 · FR-201 · FR-509.
 */

/** GST state codes (first two digits of a GSTIN). 97 = Other Territory, 99 = Centre. */
export const STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (Old)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
};

export function isValidStateCode(code: string | null | undefined): boolean {
  return !!code && Object.prototype.hasOwnProperty.call(STATE_CODES, code);
}

export function stateName(code: string): string {
  return STATE_CODES[code] ?? 'Unknown';
}

/** 2-digit state + 10-char PAN + entity number + 'Z' + checksum. */
export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
/** FR-102 — 4 letters + '0' + 6 alphanumeric. */
export const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;

const CODEPOINTS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The official GSTIN mod-36 check character over the first 14 characters. */
export function gstinCheckDigit(first14: string): string {
  const mod = CODEPOINTS.length; // 36
  let factor = 2;
  let sum = 0;

  for (let i = first14.length - 1; i >= 0; i--) {
    const codePoint = CODEPOINTS.indexOf(first14[i]);
    if (codePoint < 0) throw new Error(`Invalid GSTIN character "${first14[i]}"`);
    let digit = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    digit = Math.floor(digit / mod) + (digit % mod);
    sum += digit;
  }

  return CODEPOINTS[(mod - (sum % mod)) % mod];
}

export type GstinProblem = 'FORMAT' | 'CHECKSUM' | 'STATE_CODE';

export interface GstinValidation {
  valid: boolean;
  problem?: GstinProblem;
  message?: string;
  stateCode?: string;
  pan?: string;
}

export function validateGstin(raw: string | null | undefined): GstinValidation {
  const gstin = (raw ?? '').trim().toUpperCase();

  if (!GSTIN_REGEX.test(gstin)) {
    return { valid: false, problem: 'FORMAT', message: 'GSTIN must be 15 characters in the format 22AAAAA0000A1Z5' };
  }

  const stateCode = gstin.slice(0, 2);
  if (!isValidStateCode(stateCode)) {
    return { valid: false, problem: 'STATE_CODE', message: `Unknown GST state code "${stateCode}"`, stateCode };
  }

  if (gstinCheckDigit(gstin.slice(0, 14)) !== gstin[14]) {
    return { valid: false, problem: 'CHECKSUM', message: 'GSTIN checksum invalid', stateCode };
  }

  return { valid: true, stateCode, pan: gstin.slice(2, 12) };
}

export function isValidGstin(raw: string | null | undefined): boolean {
  return validateGstin(raw).valid;
}

/** FR-101 — "State code derived from GSTIN positions 1–2 sets the firm's home state". */
export function stateCodeFromGstin(raw: string | null | undefined): string | null {
  const v = validateGstin(raw);
  return v.stateCode ?? null;
}

/** FR-101 — "PAN embedded in GSTIN must equal the PAN field when both present." */
export function panFromGstin(raw: string | null | undefined): string | null {
  const gstin = (raw ?? '').trim().toUpperCase();
  return GSTIN_REGEX.test(gstin) ? gstin.slice(2, 12) : null;
}

export function isValidPan(raw: string | null | undefined): boolean {
  return PAN_REGEX.test((raw ?? '').trim().toUpperCase());
}

export function isValidIfsc(raw: string | null | undefined): boolean {
  return IFSC_REGEX.test((raw ?? '').trim().toUpperCase());
}

/**
 * Build a syntactically valid GSTIN from a state code + PAN — used by seeds,
 * fixtures and tests so they never hard-code a number that fails BR-6.
 */
export function buildGstin(stateCode: string, pan: string, entityCode = '1'): string {
  const base = `${stateCode}${pan.toUpperCase()}${entityCode}Z`;
  return base + gstinCheckDigit(base);
}
