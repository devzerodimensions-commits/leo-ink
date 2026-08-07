/**
 * Conformance tests for the shared utilities:
 *   §3.7 FR-122 Indian number format, FR-123 amount-in-words, §9.5 FR-720
 *   BR-6 / FR-101 / FR-102 GSTIN, PAN and IFSC validation
 *   §3.2 FR-104 financial-year derivation
 *   §3.3 FR-106 numbering-series rendering and the 16-char GST limit
 */
import { describe, it, expect } from 'vitest';
import { formatIndian, formatCurrency, amountInWords, integerToIndianWords } from '../src/lib/indianFormat.js';
import {
  validateGstin,
  isValidGstin,
  stateCodeFromGstin,
  panFromGstin,
  isValidIfsc,
  isValidPan,
  buildGstin,
  gstinCheckDigit,
  STATE_CODES,
} from '../src/lib/gstin.js';
import { fyLabel, fyStartYear, fyLabelForDate, fyRange, isWithinFy } from '../src/lib/fy.js';
import { renderNumber, validateRenderedLength, GST_DOC_NUMBER_MAX_LENGTH } from '../src/lib/numbering.js';
import { D, round2, apportion, applyRounding, sum } from '../src/lib/money.js';

describe('FR-122 — Indian lakh/crore number formatting', () => {
  it('AC1: 1234567.89 renders as 12,34,567.89', () => {
    expect(formatIndian(1234567.89)).toBe('12,34,567.89');
  });

  it('AC2: 100000 renders as ₹1,00,000.00 in currency form', () => {
    expect(formatCurrency(100000)).toBe('₹1,00,000.00');
  });

  it('groups 2-2-3 across the crore boundary', () => {
    expect(formatIndian(250000000, 0)).toBe('25,00,00,000');
    expect(formatIndian(999.5)).toBe('999.50');
    expect(formatIndian(-1234567.89)).toBe('-12,34,567.89');
  });

  it('FR-720 AC1: 2500000 shows 25,00,000.00', () => {
    expect(formatIndian(2500000)).toBe('25,00,000.00');
  });

  it('formatting never loses precision — it reads the exact decimal it is given', () => {
    expect(formatIndian('12345678901.99')).toBe('12,34,56,78,901.99');
  });
});

describe('FR-123 / FR-720 — amount in words (rupees & paise)', () => {
  it('AC1: ₹12,34,567.89 → "Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only"', () => {
    expect(amountInWords(1234567.89)).toBe(
      'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only',
    );
  });

  it('AC2: a whole-rupee payable of ₹1,235.00 reads without a paise clause', () => {
    expect(amountInWords(1235)).toBe('Rupees One Thousand Two Hundred Thirty Five Only');
  });

  it('FR-720 AC1: 2500000 → "Rupees Twenty Five Lakh Only"', () => {
    expect(amountInWords(2500000)).toBe('Rupees Twenty Five Lakh Only');
  });

  it('FR-720 AC2: 120500.50 includes the paise component', () => {
    expect(amountInWords(120500.5)).toBe(
      'Rupees One Lakh Twenty Thousand Five Hundred and Fifty Paise Only',
    );
  });

  it('the configured style can spell zero paise explicitly instead', () => {
    expect(amountInWords(1235, { zeroPaiseStyle: 'explicit' })).toBe(
      'Rupees One Thousand Two Hundred Thirty Five and Zero Paise Only',
    );
  });

  it('handles the Indian scale up to crore', () => {
    expect(integerToIndianWords(0)).toBe('Zero');
    expect(integerToIndianWords(19)).toBe('Nineteen');
    expect(integerToIndianWords(100)).toBe('One Hundred');
    expect(integerToIndianWords(1_00_000)).toBe('One Lakh');
    expect(integerToIndianWords(1_00_00_000)).toBe('One Crore');
    expect(integerToIndianWords(12_34_56_789)).toBe(
      'Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine',
    );
  });

  it('the words derive from the ROUNDED payable so they match the printed total (FR-123 rule)', () => {
    const { payable } = applyRounding(1234.6, 'NORMAL', 0);
    expect(payable.toFixed(2)).toBe('1235.00');
    expect(amountInWords(payable)).toBe('Rupees One Thousand Two Hundred Thirty Five Only');
  });
});

describe('BR-6 / FR-101 — GSTIN format and checksum validation', () => {
  it('AC1: an invalid checksum is rejected with "GSTIN checksum invalid"', () => {
    const good = buildGstin('27', 'AABCS1429B');
    // Flip the check digit to something else.
    const badChar = good[14] === '0' ? '1' : '0';
    const bad = good.slice(0, 14) + badChar;

    const result = validateGstin(bad);
    expect(result.valid).toBe(false);
    expect(result.problem).toBe('CHECKSUM');
    expect(result.message).toBe('GSTIN checksum invalid');
  });

  it('AC2: a valid GSTIN yields the home state from its first two digits', () => {
    const gstin = buildGstin('27', 'AABCS1429B');
    expect(isValidGstin(gstin)).toBe(true);
    expect(stateCodeFromGstin(gstin)).toBe('27');
    expect(STATE_CODES['27']).toBe('Maharashtra');
  });

  it('rejects anything that is not 15 characters in the statutory shape', () => {
    for (const bad of ['', '27AABCS1429B1Z', 'AABCS1429B1Z5XX', '27aabcs1429b1z5', '271234512345678']) {
      expect(validateGstin(bad).valid).toBe(false);
    }
  });

  it('FR-101 — the PAN embedded at positions 3-12 is extractable for the "PAN must match" rule', () => {
    const gstin = buildGstin('29', 'AAECB1234F');
    expect(panFromGstin(gstin)).toBe('AAECB1234F');
    expect(isValidPan('AAECB1234F')).toBe(true);
    expect(isValidPan('AAECB1234')).toBe(false);
  });

  it('the check digit is the documented mod-36 algorithm', () => {
    // Known-good published example: 27AAPFU0939F1ZV
    expect(gstinCheckDigit('27AAPFU0939F1Z')).toBe('V');
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
  });

  it('an unknown state code is rejected even when the shape is right', () => {
    const gstin = buildGstin('27', 'AABCS1429B');
    const bogusState = '88' + gstin.slice(2, 14);
    const withCheck = bogusState + gstinCheckDigit(bogusState);
    expect(validateGstin(withCheck).problem).toBe('STATE_CODE');
  });
});

describe('FR-102 — IFSC validation', () => {
  it('accepts the 4-letter + 0 + 6-alphanumeric form and rejects the rest', () => {
    expect(isValidIfsc('HDFC0000123')).toBe(true);
    expect(isValidIfsc('SBIN0001234')).toBe(true);
    expect(isValidIfsc('HDFC1000123')).toBe(false); // 5th char must be 0
    expect(isValidIfsc('HDF00000123')).toBe(false); // needs 4 letters
    expect(isValidIfsc('HDFC000012')).toBe(false); // too short
  });
});

describe('FR-104 — financial year (1 April → 31 March)', () => {
  it('AC1: the label auto-formats as YYYY-YY and the end date is 31-March of the next year', () => {
    const { startDate, endDate, fyLabel: label } = fyRange(2026);
    expect(label).toBe('2026-27');
    expect(startDate.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(endDate.toISOString().slice(0, 10)).toBe('2027-03-31');
  });

  it('April onwards belongs to that year’s FY; January–March to the previous one', () => {
    expect(fyStartYear(new Date('2026-04-01T00:00:00Z'))).toBe(2026);
    expect(fyStartYear(new Date('2026-03-31T00:00:00Z'))).toBe(2025);
    expect(fyLabelForDate(new Date('2027-02-15T00:00:00Z'))).toBe('2026-27');
    expect(fyLabelForDate(new Date('2026-08-06T00:00:00Z'))).toBe('2026-27');
  });

  it('the label wraps the century correctly', () => {
    expect(fyLabel(2099)).toBe('2099-00');
    expect(fyLabel(2009)).toBe('2009-10');
  });

  it('AC2: a date outside the FY is detectable so posting can be blocked', () => {
    const { startDate, endDate } = fyRange(2026);
    expect(isWithinFy(new Date('2026-04-01T00:00:00Z'), startDate, endDate)).toBe(true);
    expect(isWithinFy(new Date('2027-03-31T00:00:00Z'), startDate, endDate)).toBe(true);
    expect(isWithinFy(new Date('2027-04-01T00:00:00Z'), startDate, endDate)).toBe(false);
    expect(isWithinFy(new Date('2026-03-31T00:00:00Z'), startDate, endDate)).toBe(false);
  });
});

describe('FR-106 — numbering series rendering', () => {
  it('AC1: series "INV/{BR}/{FY}/" with padding 4 for branch HO in FY 2026-27 previews as INV/HO/2026-27/0001', () => {
    const rendered = renderNumber(
      { prefix: 'INV/{BR}/{FY}/', suffix: '', padding: 4, nextNumber: 1 },
      1,
      { branchCode: 'HO', fyLabel: '2026-27' },
    );
    expect(rendered).toBe('INV/HO/2026-27/0001');
  });

  it('AC2: a tax-invoice number longer than 16 characters is blocked per the GST limit', () => {
    const long = renderNumber(
      { prefix: 'INVOICE/{BR}/{FY}/', suffix: '', padding: 6, nextNumber: 1 },
      1,
      { branchCode: 'HEADOFFICE', fyLabel: '2026-27' },
    );
    expect(long.length).toBeGreaterThan(GST_DOC_NUMBER_MAX_LENGTH);
    expect(() => validateRenderedLength('INVOICE', long)).toThrow(/16 characters/);
    // The same length is fine for a non-statutory document type.
    expect(() => validateRenderedLength('JOBCARD', long)).not.toThrow();
  });

  it('FR-230 — a quotation series renders QUO/2026-27/00001 and increments without gaps', () => {
    const series = { prefix: 'QUO/{FY}/', suffix: '', padding: 5, nextNumber: 1 };
    expect(renderNumber(series, 1, { fyLabel: '2026-27' })).toBe('QUO/2026-27/00001');
    expect(renderNumber(series, 2, { fyLabel: '2026-27' })).toBe('QUO/2026-27/00002');
  });
});

describe('BR-1 — money precision helpers', () => {
  it('rounds half-up to two decimals', () => {
    expect(round2('2.345').toFixed(2)).toBe('2.35');
    expect(round2('2.344').toFixed(2)).toBe('2.34');
    expect(round2('-2.345').toFixed(2)).toBe('-2.35');
  });

  it('never lets a float literal leak binary error into a stored amount', () => {
    expect(sum([0.1, 0.2]).toFixed(2)).toBe('0.30');
    expect(D(0.1).plus(D(0.2)).equals(D('0.3'))).toBe(true);
  });

  it('apportion always sums back to the total it distributes', () => {
    for (const total of ['10', '0.01', '999.99', '1234.57']) {
      for (const weights of [[1, 1, 1], [3, 7], [1, 0, 5, 2], [100]]) {
        const parts = apportion(total, weights);
        expect(sum(parts).toFixed(2)).toBe(round2(total).toFixed(2));
      }
    }
  });

  it('apportion handles a zero weight-total without dropping money', () => {
    const parts = apportion('10', [0, 0, 0]);
    expect(sum(parts).toFixed(2)).toBe('10.00');
  });

  it('applyRounding reports the adjustment separately in every mode', () => {
    expect(applyRounding('100.40', 'NORMAL', 0).payable.toFixed(2)).toBe('100.00');
    expect(applyRounding('100.40', 'NORMAL', 0).roundOff.toFixed(2)).toBe('-0.40');
    expect(applyRounding('100.40', 'UP', 0).payable.toFixed(2)).toBe('101.00');
    expect(applyRounding('100.60', 'DOWN', 0).payable.toFixed(2)).toBe('100.00');
    expect(applyRounding('100.60', 'NONE', 0).payable.toFixed(2)).toBe('100.60');
  });
});
