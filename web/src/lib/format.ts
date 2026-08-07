/**
 * FR-122 / FR-720 — Indian presentation on the client. The *server* is the source
 * of truth for every computed amount (BR-1/BR-7); this only formats strings it is
 * given, and never does money arithmetic.
 */

/** "1234567.89" → "12,34,567.89" */
export function formatIndian(value: string | number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);

  const negative = num < 0;
  const fixed = Math.abs(num).toFixed(decimals);
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

export function money(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return `₹${formatIndian(value, 2).replace(/^-/, '')}`.replace(/^₹/, Number(value) < 0 ? '-₹' : '₹');
}

/** Drop trailing zeros on a 4-decimal rate: "40.0000" → "40" */
export function rate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return formatIndian(n, 4).replace(/\.?0+$/, '');
}

export function qty(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return formatIndian(n, 4).replace(/\.?0+$/, '');
}

const DATE_FMT = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});

const DATETIME_FMT = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

/** BR-10 — stored UTC, displayed IST. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : DATE_FMT.format(d);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : DATETIME_FMT.format(d);
}

/** yyyy-mm-dd for <input type="date"> */
export function toDateInput(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export const VERTICAL_LABELS: Record<string, string> = {
  FLEX_LARGE_FORMAT: 'Flex / Large format',
  OFFSET: 'Offset',
  DIGITAL: 'Digital',
  SCREEN: 'Screen',
};

export const ROLE_LABELS: Record<string, string> = {
  OWNER_ADMIN: 'Owner / Admin',
  ACCOUNTS: 'Accounts',
  SALES_COUNTER: 'Sales / Counter',
  PRODUCTION_MANAGER: 'Production Manager',
  OPERATOR: 'Operator',
  DELIVERY: 'Delivery',
};
