import { describe, expect, it } from 'vitest';
import {
  dayOf,
  dismissed,
  eligible,
  type ProactiveConfig,
  pathMatches,
  shown,
  type Trigger,
  visit,
} from '../src/proactive.js';

const trigger = (overrides: Partial<Trigger>): Trigger => ({
  id: 't',
  kind: 'time_on_page',
  path: null,
  seconds: 10,
  visits: null,
  message: 'Need a hand?',
  ...overrides,
});

const config = (overrides: Partial<ProactiveConfig> = {}): ProactiveConfig => ({
  enabled: true,
  maxPerDay: 1,
  dismissHours: 24,
  triggers: [
    trigger({ id: 'pricing', kind: 'page_path', path: '/pricing', seconds: 5 }),
    trigger({ id: 'linger' }),
    trigger({ id: 'back', kind: 'returning_visitor', visits: 3, seconds: 0 }),
  ],
  ...overrides,
});

const day = (date: string) => new Date(`${date}T12:00:00`);
const ids = (triggers: Trigger[]) => triggers.map((t) => t.id);

describe('proactive prompts (W19)', () => {
  it('match a page and the pages below it, and any page without a path', () => {
    expect(pathMatches('/pricing', '/pricing')).toBe(true);
    expect(pathMatches('/pricing', '/pricing/teams')).toBe(true);
    expect(pathMatches('/pricing/', '/pricing')).toBe(true);
    expect(pathMatches('/pricing', '/pricingx')).toBe(false);
    expect(pathMatches('/', '/anything')).toBe(true);
    expect(pathMatches(null, '/anything')).toBe(true);
  });

  it('count visits once per day, and the prompts shown per day', () => {
    let memory = visit(null, day('2026-10-01'));
    expect(memory).toMatchObject({ visits: 1, shown: 0 });
    memory = visit(shown(memory), day('2026-10-01'));
    expect(memory).toMatchObject({ visits: 1, shown: 1 });
    memory = visit(memory, day('2026-10-02'));
    expect(memory).toMatchObject({ visits: 2, shown: 0, day: dayOf(day('2026-10-02')) });
  });

  it('show nothing when off, after the day’s limit, or while a dismissal lasts', () => {
    const now = Date.now();
    const fresh = visit(null, new Date(now));
    expect(ids(eligible(config(), fresh, now, '/pricing/teams'))).toEqual(['pricing', 'linger']);
    expect(ids(eligible(config(), fresh, now, '/about'))).toEqual(['linger']);
    expect(eligible(config({ enabled: false }), fresh, now, '/pricing')).toEqual([]);
    expect(eligible(config(), shown(fresh), now, '/pricing')).toEqual([]);
    // A brand that allows more still gets at most three a day.
    let busy = fresh;
    for (let i = 0; i < 3; i += 1) busy = shown(busy);
    expect(eligible(config({ maxPerDay: 10 }), busy, now, '/pricing')).toEqual([]);
    const quiet = dismissed(fresh, now, 12);
    expect(eligible(config(), quiet, now + 11 * 3_600_000, '/pricing')).toEqual([]);
    expect(eligible(config(), quiet, now + 12 * 3_600_000 + 1, '/pricing')).not.toEqual([]);
    // A dismissal lasts at least an hour, whatever the setting says.
    expect(dismissed(fresh, now, 0).until).toBe(now + 3_600_000);
  });

  it('greet returning visitors from the brand’s chosen visit', () => {
    let memory = visit(null, day('2026-10-01'));
    memory = visit(memory, day('2026-10-02'));
    expect(ids(eligible(config(), memory, 0, '/'))).toEqual(['linger']);
    memory = visit(memory, day('2026-10-03'));
    expect(ids(eligible(config(), memory, 0, '/'))).toEqual(['linger', 'back']);
  });
});
