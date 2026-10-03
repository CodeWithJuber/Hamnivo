/**
 * Billing periods are calendar months in UTC: `[start, end)`, named `YYYY-MM`. Usage limits reset
 * at the start of each period, and invoices cover one period.
 */

export interface BillingPeriod {
  key: string;
  start: Date;
  end: Date;
}

const KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

function monthPeriod(year: number, monthIndex: number): BillingPeriod {
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { key, start, end };
}

/** The period that contains `at`. */
export function periodOf(at: Date): BillingPeriod {
  return monthPeriod(at.getUTCFullYear(), at.getUTCMonth());
}

export class InvalidPeriodError extends Error {
  override name = 'InvalidPeriodError';
}

/** The period named `YYYY-MM`. */
export function periodFromKey(key: string): BillingPeriod {
  const match = KEY.exec(key);
  if (!match) throw new InvalidPeriodError(`Expected a period like 2026-09, got "${key}"`);
  return monthPeriod(Number(match[1]), Number(match[2]) - 1);
}

export function previousPeriod(period: BillingPeriod): BillingPeriod {
  return periodOf(new Date(period.start.getTime() - 1));
}

/** Whole seconds from `now` until the period ends (at least 1 while it is running). */
export function secondsUntilEnd(period: BillingPeriod, now: Date): number {
  return Math.max(1, Math.ceil((period.end.getTime() - now.getTime()) / 1000));
}
