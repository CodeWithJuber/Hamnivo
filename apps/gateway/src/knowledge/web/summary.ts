import type { WebSyncResult, WebSyncSchedule } from '@hamnivo/contracts';
import type { SkipReason } from './crawler.js';

const HOUR = 3_600_000;
const INTERVAL_MS = { daily: 24 * HOUR, weekly: 7 * 24 * HOUR } as const;

/** When a website is read again after a read that ended at `from`; `null` for `manual`. */
export function nextRunAfter(
  schedule: WebSyncSchedule,
  from: Date,
  result: WebSyncResult,
): Date | null {
  if (schedule === 'manual') return null;
  const interval = INTERVAL_MS[schedule];
  // A read that got nowhere is tried again sooner than a day or a week.
  return new Date(from.getTime() + (result === 'failed' ? Math.min(interval, 6 * HOUR) : interval));
}

/** When a website whose schedule was just set is first read: now, or one interval after its last. */
export function firstRunFor(
  schedule: WebSyncSchedule,
  lastRunAt: Date | null,
  now: Date,
): Date | null {
  if (schedule === 'manual') return null;
  const due = lastRunAt ? lastRunAt.getTime() + INTERVAL_MS[schedule] : now.getTime();
  return new Date(Math.max(now.getTime(), due));
}

/** Why a page was left out, in words for the start address (the one a person typed). */
export const SKIP_TEXT: Record<SkipReason, string> = {
  robots: 'The site’s robots.txt asks readers to stay away from this address.',
  offsite: 'The address leads to another site, which is not read.',
  noindex: 'The page asks not to be indexed (noindex), so it was left out.',
  type: 'The address is not a web page or a PDF.',
  duplicate: 'The page is a copy of another one that was read.',
  empty:
    'No readable text was found on the page. A page that needs JavaScript to show its text cannot be read.',
};

const MAX_PROBLEMS = 10;

/** What one read counts as it goes: the figures behind the summary a person sees afterwards. */
export class Tally {
  /** Pages kept: read and readable (new, changed or unchanged). */
  kept = 0;
  added = 0;
  updated = 0;
  unchanged = 0;
  retired = 0;
  /** Addresses that could not be read (not counting pages that are simply gone). */
  failed = 0;
  readonly skipped: Record<SkipReason, number> = {
    robots: 0,
    offsite: 0,
    noindex: 0,
    type: 0,
    duplicate: 0,
    empty: 0,
  };
  readonly problems: { url: string; reason: string }[] = [];

  problem(url: string, reason: string): void {
    if (this.problems.length < MAX_PROBLEMS) {
      this.problems.push({ url: url.slice(0, 300), reason });
    }
  }
}
