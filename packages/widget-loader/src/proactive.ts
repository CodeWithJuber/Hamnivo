import { type BrowserCondition, browserMatches, deviceOf } from '@hamnivo/domain/automations';

/**
 * When a website prompt may show (W19, G21). The brand's limits bound everything (at most three a
 * day, at least an hour after a dismissal); this keeps to them on the visitor's device, and the
 * loader never shows a prompt while the chat is open.
 */

/**
 * A website automation (G21) that may prompt this visitor. The gateway already checked what it
 * knows; `when` holds the conditions only the browser can check: all of them, or one when `any`.
 */
export interface Rule {
  id: string;
  seconds: number;
  any: boolean;
  when: BrowserCondition[];
  message: string;
}

export interface ProactiveConfig {
  enabled: boolean;
  maxPerDay: number;
  dismissHours: number;
  rules?: Rule[];
}

/** What the loader knows about this page view. */
export interface Page {
  /** The address without the origin: `/pricing?plan=pro`. */
  path: string;
  referrer: string;
  /** The window's width, for the device class. */
  width: number;
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

/** The prompts that may show on this page now, in the brand's order. */
export function eligible(config: ProactiveConfig, memory: Memory, now: number, page: Page): Rule[] {
  if (!config.enabled) return [];
  if (memory.shown >= Math.min(3, Math.max(0, config.maxPerDay))) return [];
  if (now < memory.until) return [];
  const facts = {
    page_url: page.path,
    referrer: page.referrer,
    visit_count: memory.visits,
    device: deviceOf(page.width),
  };
  return (config.rules ?? []).filter((rule) => browserMatches(rule, facts));
}

export const shown = (memory: Memory): Memory => ({ ...memory, shown: memory.shown + 1 });

/** After a dismissal, no prompt for the brand's quiet time (1 hour to 7 days). */
export const dismissed = (memory: Memory, now: number, hours: number): Memory => ({
  ...memory,
  until: now + Math.min(168, Math.max(1, hours)) * 3_600_000,
});
