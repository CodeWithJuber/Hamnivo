/**
 * Business hours as a person edits and reads them (W11): a week of opening spans in one time
 * zone, and whole days without service. The gateway keeps `weekly` keyed by day (`sun` to `sat`)
 * with `HH:MM` times, where `24:00` closes at the end of the day; this turns that into something
 * a form can hold, says what is wrong before saving, and puts hours into words.
 */
import type { BusinessHours } from '@hamnivo/contracts';

/** Monday first, the order people read a week in; the keys are the contract's. */
export const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof WEEK)[number];

export interface Span {
  open: string;
  close: string;
}

export interface HoursDraft {
  timezone: string;
  weekly: Record<Day, Span[]>;
  /** `YYYY-MM-DD`, whole days without service. */
  closedDates: string[];
}

/** The most opening spans one day may have, and closed days one brand may list. */
export const MAX_SPANS = 6;
export const MAX_CLOSED_DATES = 366;

const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

export const emptyWeek = (): Record<Day, Span[]> => ({
  mon: [],
  tue: [],
  wed: [],
  thu: [],
  fri: [],
  sat: [],
  sun: [],
});

/** A new brand's hours start empty, in the time zone of the person setting them. */
export const emptyHours = (timezone: string): HoursDraft => ({
  timezone,
  weekly: emptyWeek(),
  closedDates: [],
});

/**
 * The working copy of stored hours. A closing time of `24:00` is shown as `00:00` (12:00 AM): a
 * time box cannot hold `24:00`, and "closes at midnight" reads the same either way.
 */
export function draftOfHours(hours: BusinessHours | null, fallbackZone: string): HoursDraft {
  if (!hours) return emptyHours(fallbackZone);
  const weekly = emptyWeek();
  for (const day of WEEK) {
    weekly[day] = hours.weekly[day].map((span) => ({
      open: span.open,
      close: span.close === '24:00' ? '00:00' : span.close,
    }));
  }
  return { timezone: hours.timezone, weekly, closedDates: [...hours.closedDates].sort() };
}

/** What is saved for a working copy: `00:00` as a closing time is the end of that day. */
export function bodyOfHours(draft: HoursDraft): BusinessHours {
  const weekly = emptyWeek();
  for (const day of WEEK) {
    weekly[day] = draft.weekly[day].map((span) => ({
      open: span.open,
      close: span.close === '00:00' ? '24:00' : span.close,
    }));
  }
  return {
    timezone: draft.timezone,
    weekly,
    closedDates: [...new Set(draft.closedDates)].sort(),
  };
}

export type HoursProblem =
  | { kind: 'time'; day: Day; index: number }
  | { kind: 'order'; day: Day; index: number }
  | { kind: 'overlap'; day: Day }
  | { kind: 'zone' }
  | { kind: 'date'; value: string };

/** Whether this is a time zone the browser (and so the gateway) knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone.length > 0 && zone.length <= 64;
  } catch {
    return false;
  }
}

/** What the gateway would refuse, in the order a person reads the form. */
export function problemsOfHours(draft: HoursDraft): HoursProblem[] {
  const problems: HoursProblem[] = [];
  if (!isTimeZone(draft.timezone)) problems.push({ kind: 'zone' });
  for (const day of WEEK) {
    const spans = draft.weekly[day];
    spans.forEach((span, index) => {
      if (!LOCAL_TIME.test(span.open) || !LOCAL_TIME.test(span.close)) {
        problems.push({ kind: 'time', day, index });
        return;
      }
      // Closing at 00:00 means the end of the day, which is after any opening time but 00:00.
      const close = span.close === '00:00' ? '24:00' : span.close;
      if (!(span.open < close)) problems.push({ kind: 'order', day, index });
    });
    const sorted = spans
      .filter((span) => LOCAL_TIME.test(span.open) && LOCAL_TIME.test(span.close))
      .map((span) => ({ open: span.open, close: span.close === '00:00' ? '24:00' : span.close }))
      .sort((a, b) => (a.open < b.open ? -1 : 1));
    if (sorted.some((span, i) => i > 0 && (sorted[i - 1] as Span).close > span.open)) {
      problems.push({ kind: 'overlap', day });
    }
  }
  for (const value of draft.closedDates) {
    if (!DATE.test(value)) problems.push({ kind: 'date', value });
  }
  return problems;
}

/** The whole week with every working day set to the same spans. */
export function weekOf(days: readonly Day[], spans: readonly Span[]): Record<Day, Span[]> {
  const weekly = emptyWeek();
  for (const day of days) weekly[day] = spans.map((span) => ({ ...span }));
  return weekly;
}

export const WEEKDAYS: readonly Day[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
export const WORKING_SPAN: Span = { open: '09:00', close: '17:00' };
export const ALL_DAY: Span = { open: '00:00', close: '00:00' };

/** A day's name in a language: `Monday`, `Mon`. */
export function dayName(day: Day, locale: string, style: 'long' | 'short' = 'long'): string {
  const index = WEEK.indexOf(day);
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 0, 5 + index)),
  );
}

const sameSpans = (a: readonly Span[], b: readonly Span[]) =>
  a.length === b.length &&
  a.every((span, i) => span.open === b[i]?.open && span.close === b[i]?.close);

export interface HoursGroup {
  /** Consecutive days (Monday first) that keep the same hours. */
  days: Day[];
  spans: Span[];
}

/** The days that are open, with runs of days that share hours put together. */
export function groupDays(weekly: Record<Day, Span[]>): HoursGroup[] {
  const groups: HoursGroup[] = [];
  for (const day of WEEK) {
    const spans = weekly[day];
    if (spans.length === 0) continue;
    const last = groups[groups.length - 1];
    const previous = last?.days[last.days.length - 1];
    if (
      last &&
      previous &&
      WEEK.indexOf(previous) === WEEK.indexOf(day) - 1 &&
      sameSpans(last.spans, spans)
    ) {
      last.days.push(day);
    } else {
      groups.push({ days: [day], spans: [...spans] });
    }
  }
  return groups;
}

/** `09:00 to 17:00, 18:00 to 20:00`: a day's spans, with `to` in the reader's language. */
export function spansText(spans: readonly Span[], to: string): string {
  return spans
    .map((span) => `${span.open} ${to} ${span.close === '00:00' ? '24:00' : span.close}`)
    .join(', ');
}

/** `Mon to Fri`, `Sat`: a run of days, with `to` in the reader's language. */
export function daysText(days: readonly Day[], locale: string, to: string): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return '';
  return days.length === 1
    ? dayName(first, locale, 'short')
    : `${dayName(first, locale, 'short')} ${to} ${dayName(last, locale, 'short')}`;
}
