/**
 * When a proactive prompt may show (W19). The brand's settings bound everything (at most three a
 * day, at least an hour after a dismissal); this keeps to them on the visitor's device, and the
 * loader never shows a prompt while the chat is open.
 */

export interface Trigger {
  id: string;
  kind: 'page_path' | 'time_on_page' | 'returning_visitor';
  path: string | null;
  seconds: number;
  visits: number | null;
  message: string;
}

export interface ProactiveConfig {
  enabled: boolean;
  maxPerDay: number;
  dismissHours: number;
  triggers: Trigger[];
}

/** What the device remembers: prompts shown today, the end of a dismissal, and visits. */
export interface Memory {
  day: string;
  shown: number;
  until: number;
  visits: number;
  last: string;
}

/** The calendar day in the visitor's own time zone. */
export const dayOf = (now: Date): string =>
  `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

/** Counts a visit once per day, and starts each day's count of prompts again. */
export function visit(memory: Memory | null, now: Date): Memory {
  const day = dayOf(now);
  const known = memory ?? { day, shown: 0, until: 0, visits: 0, last: '' };
  return {
    day,
    shown: known.day === day ? known.shown : 0,
    until: known.until,
    visits: known.last === day ? known.visits : known.visits + 1,
    last: day,
  };
}

/** A path matches its own page and the pages below it (`/pricing` → `/pricing/teams`). */
export function pathMatches(path: string | null, pathname: string): boolean {
  if (!path) return true;
  const base = path.replace(/\/+$/, '');
  return base === '' || pathname === base || pathname.startsWith(`${base}/`);
}

/** The prompts that may show on this page now, in the brand's order. */
export function eligible(
  config: ProactiveConfig,
  memory: Memory,
  now: number,
  pathname: string,
): Trigger[] {
  if (!config.enabled) return [];
  if (memory.shown >= Math.min(3, Math.max(0, config.maxPerDay))) return [];
  if (now < memory.until) return [];
  return config.triggers.filter(
    (trigger) =>
      pathMatches(trigger.path, pathname) &&
      (trigger.kind !== 'returning_visitor' || memory.visits >= (trigger.visits ?? 1_000)),
  );
}

export const shown = (memory: Memory): Memory => ({ ...memory, shown: memory.shown + 1 });

/** After a dismissal, no prompt for the brand's quiet time (1 hour to 7 days). */
export const dismissed = (memory: Memory, now: number, hours: number): Memory => ({
  ...memory,
  until: now + Math.min(168, Math.max(1, hours)) * 3_600_000,
});
