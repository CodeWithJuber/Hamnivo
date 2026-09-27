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
