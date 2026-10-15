import { TZDate } from '@date-fns/tz';

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** One opening span in local time, "HH:MM" to "HH:MM" (close may be "24:00"). */
export interface OpeningInterval {
  open: string;
  close: string;
}

/**
 * When people are scheduled to answer (W11). Times are local to `timezone`; a span never crosses
 * midnight (split it in two), and `closedDates` (YYYY-MM-DD, local) close whole days.
 */
export interface BusinessHours {
  timezone: string;
  weekly: Record<Weekday, OpeningInterval[]>;
  closedDates: string[];
}

/** How far ahead nextOpening looks before giving up (a schedule with no hours at all). */
const HORIZON_DAYS = 14;

const minutes = (hhmm: string): number => {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

const pad = (n: number) => String(n).padStart(2, '0');

function localDate(date: TZDate): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whether the time zone is one the runtime knows (IANA names such as "Asia/Karachi"). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Whether people are scheduled to be working at `at`. */
export function isOpen(hours: BusinessHours, at: Date): boolean {
  const local = new TZDate(at.getTime(), hours.timezone);
  if (hours.closedDates.includes(localDate(local))) return false;
  const day = WEEKDAYS[local.getDay()] as Weekday;
  const now = local.getHours() * 60 + local.getMinutes();
  return hours.weekly[day].some((span) => now >= minutes(span.open) && now < minutes(span.close));
}

/**
 * The next time people start working after `at`, or null when the schedule has no opening in the
 * next two weeks. Local times that do not exist (a clock change) move forward to the next real
 * minute.
 */
export function nextOpening(hours: BusinessHours, at: Date): Date | null {
  const start = new TZDate(at.getTime(), hours.timezone);
  for (let offset = 0; offset <= HORIZON_DAYS; offset += 1) {
    const day = new TZDate(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + offset,
      12,
      0,
      hours.timezone,
    );
    if (hours.closedDates.includes(localDate(day))) continue;
    const spans = [...hours.weekly[WEEKDAYS[day.getDay()] as Weekday]].sort(
      (a, b) => minutes(a.open) - minutes(b.open),
    );
    for (const span of spans) {
      const open = minutes(span.open);
      const candidate = new TZDate(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        Math.floor(open / 60),
        open % 60,
        hours.timezone,
      );
      if (candidate.getTime() > at.getTime()) return new Date(candidate.getTime());
    }
  }
  return null;
}

/** How far ahead the business-time functions look (a year covers any real schedule). */
const BUSINESS_HORIZON_DAYS = 366;

/**
 * The open spans of one local day as instants, merged and in order. A day's spans never cross
 * midnight; "24:00" ends at the next local midnight.
 */
function daySpans(hours: BusinessHours, day: TZDate): [number, number][] {
  if (hours.closedDates.includes(localDate(day))) return [];
  const at = (m: number) =>
    new TZDate(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      Math.floor(m / 60),
      m % 60,
      hours.timezone,
    ).getTime();
  const spans = [...hours.weekly[WEEKDAYS[day.getDay()] as Weekday]]
    .map((span) => [minutes(span.open), minutes(span.close)] as const)
    .filter(([open, close]) => close > open)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [open, close] of spans) {
    const start = at(open);
    const end = at(close);
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else if (end > start) merged.push([start, end]);
  }
  return merged;
}

/** Local noon of the day `offset` days after the day that holds `at` (noon dodges clock changes). */
function localDay(hours: BusinessHours, at: Date, offset: number): TZDate {
  const start = new TZDate(at.getTime(), hours.timezone);
  return new TZDate(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + offset,
    12,
    0,
    hours.timezone,
  );
}

/**
 * Working minutes between two times (H12): only the time inside the schedule counts. With no
 * schedule every minute counts. Fractions are kept; callers round for display.
 */
export function businessMinutesBetween(hours: BusinessHours | null, from: Date, to: Date): number {
  const start = from.getTime();
  const end = to.getTime();
  if (end <= start) return 0;
  if (!hours) return (end - start) / 60_000;
  let total = 0;
  for (let offset = 0; offset <= BUSINESS_HORIZON_DAYS; offset += 1) {
    const day = localDay(hours, from, offset);
    for (const [open, close] of daySpans(hours, day)) {
      if (open >= end) return total / 60_000;
      const a = Math.max(open, start);
      const b = Math.min(close, end);
      if (b > a) total += b - a;
    }
    if (day.getTime() - 12 * 3_600_000 > end) break;
  }
  return total / 60_000;
}

/**
 * The time `minutes` working minutes after `from` (H12): the clock only runs while the schedule
 * is open. With no schedule it is plain time. Null when the schedule has no opening within a
 * year, so the deadline can never come.
 */
export function addBusinessMinutes(
  hours: BusinessHours | null,
  from: Date,
  minutes: number,
): Date | null {
  if (!hours) return new Date(from.getTime() + minutes * 60_000);
  let remaining = Math.max(0, minutes) * 60_000;
  const start = from.getTime();
  for (let offset = 0; offset <= BUSINESS_HORIZON_DAYS; offset += 1) {
    for (const [open, close] of daySpans(hours, localDay(hours, from, offset))) {
      const a = Math.max(open, start);
      if (close <= a) continue;
      if (remaining <= close - a) return new Date(a + remaining);
      remaining -= close - a;
    }
  }
  return null;
}
