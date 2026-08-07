/**
 * FR-104 / FR-105 — India-standard financial year (1 April → 31 March).
 * All timestamps are stored UTC and displayed IST (BR-10); FY boundaries are
 * computed on calendar dates so a 31-March document never slips a year.
 */

/** The FY start year for a given date: 15-Feb-2027 → 2026 (FY 2026-27). */
export function fyStartYear(date: Date): number {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0 = Jan
  return month >= 3 ? year : year - 1; // April (3) onwards belongs to that year's FY
}

/** FR-104 — "`fy_label` auto-formats as `YYYY-YY` (e.g., 2026-27)". */
export function fyLabel(startYear: number): string {
  const endShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endShort}`;
}

export function fyLabelForDate(date: Date): string {
  return fyLabel(fyStartYear(date));
}

/** FR-104 — start fixed to 1-April, end auto-set to 31-March of the next year. */
export function fyRange(startYear: number): { startDate: Date; endDate: Date; fyLabel: string } {
  return {
    startDate: new Date(Date.UTC(startYear, 3, 1)),
    endDate: new Date(Date.UTC(startYear + 1, 2, 31)),
    fyLabel: fyLabel(startYear),
  };
}

export function fyRangeForDate(date: Date) {
  return fyRange(fyStartYear(date));
}

/** True when `date` falls inside the FY [startDate, endDate] inclusive. */
export function isWithinFy(date: Date, startDate: Date, endDate: Date): boolean {
  const d = toDateOnly(date).getTime();
  return d >= toDateOnly(startDate).getTime() && d <= toDateOnly(endDate).getTime();
}

/** Strip time so date comparisons are calendar comparisons. */
export function toDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const IST_OFFSET_MINUTES = 5 * 60 + 30;

/** BR-10 — "All timestamps stored in UTC, displayed in IST." Tenant-day for TAT maths. */
export function tenantToday(now: Date = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}
