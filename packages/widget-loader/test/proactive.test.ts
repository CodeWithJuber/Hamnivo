import { describe, expect, it } from 'vitest';
import {
  dayOf,
  dismissed,
  eligible,
  type Page,
  type ProactiveConfig,
  type Rule,
  shown,
  visit,
} from '../src/proactive.js';

const rule = (overrides: Partial<Rule>): Rule => ({
  id: 't',
  seconds: 10,
  any: false,
  when: [],
  message: 'Need a hand?',
  ...overrides,
});

const config = (overrides: Partial<ProactiveConfig> = {}): ProactiveConfig => ({
  enabled: true,
  maxPerDay: 1,
  dismissHours: 24,
  rules: [
    rule({ id: 'pricing', when: [['page_url', 'starts_with', '/pricing']], seconds: 5 }),
    rule({ id: 'linger' }),
    rule({ id: 'back', when: [['visit_count', 'at_least', 3]], seconds: 0 }),
  ],
  ...overrides,
});

const page = (path: string, overrides: Partial<Page> = {}): Page => ({
  path,
  referrer: '',
  width: 1280,
  ...overrides,
});
const day = (date: string) => new Date(`${date}T12:00:00`);
const ids = (rules: Rule[]) => rules.map((r) => r.id);

describe('website prompts (W19, G21)', () => {
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
    expect(ids(eligible(config(), fresh, now, page('/pricing/teams')))).toEqual([
      'pricing',
      'linger',
    ]);
    expect(ids(eligible(config(), fresh, now, page('/about')))).toEqual(['linger']);
    expect(eligible(config({ enabled: false }), fresh, now, page('/pricing'))).toEqual([]);
    expect(eligible(config(), shown(fresh), now, page('/pricing'))).toEqual([]);
    // A brand that allows more still gets at most three a day.
    let busy = fresh;
    for (let i = 0; i < 3; i += 1) busy = shown(busy);
    expect(eligible(config({ maxPerDay: 10 }), busy, now, page('/pricing'))).toEqual([]);
    const quiet = dismissed(fresh, now, 12);
    expect(eligible(config(), quiet, now + 11 * 3_600_000, page('/pricing'))).toEqual([]);
    expect(eligible(config(), quiet, now + 12 * 3_600_000 + 1, page('/pricing'))).not.toEqual([]);
    // A dismissal lasts at least an hour, whatever the setting says.
    expect(dismissed(fresh, now, 0).until).toBe(now + 3_600_000);
  });

  it('greet returning visitors from the brand’s chosen visit', () => {
    let memory = visit(null, day('2026-10-01'));
    memory = visit(memory, day('2026-10-02'));
    expect(ids(eligible(config(), memory, 0, page('/')))).toEqual(['linger']);
    memory = visit(memory, day('2026-10-03'));
    expect(ids(eligible(config(), memory, 0, page('/')))).toEqual(['linger', 'back']);
  });

  it('check the referrer, the device and "any" in the browser', () => {
    const fresh = visit(null, new Date());
    const rules = config({
      rules: [
        rule({ id: 'search', when: [['referrer', 'contains', 'google.']] }),
        rule({ id: 'phone', when: [['device', 'is', ['mobile']]] }),
        rule({
          id: 'either',
          any: true,
          when: [
            ['page_url', 'contains', '/checkout'],
            ['referrer', 'contains', 'newsletter'],
          ],
        }),
      ],
    });
    expect(
      ids(eligible(rules, fresh, 0, page('/', { referrer: 'https://www.google.com/' }))),
    ).toEqual(['search']);
    expect(ids(eligible(rules, fresh, 0, page('/', { width: 375 })))).toEqual(['phone']);
    expect(ids(eligible(rules, fresh, 0, page('/checkout?step=2')))).toEqual(['either']);
    expect(
      ids(eligible(rules, fresh, 0, page('/', { referrer: 'https://mail.example/newsletter' }))),
    ).toEqual(['either']);
  });

  it('show nothing from a config without rules (a gateway from before G21)', () => {
    const fresh = visit(null, new Date());
    expect(
      eligible({ enabled: true, maxPerDay: 1, dismissHours: 24 }, fresh, 0, page('/')),
    ).toEqual([]);
  });
});
