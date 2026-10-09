import { describe, expect, it } from 'vitest';
import {
  type AutomationDefinition,
  browserMatches,
  checkCondition,
  definitionProblems,
  deviceOf,
  evaluate,
  excludesAi,
  splitForBrowser,
  textMatches,
} from '../src/automations/index.js';

const rule = (over: Partial<AutomationDefinition> = {}): AutomationDefinition => ({
  event: { type: 'chat_started', seconds: 0 },
  match: 'all',
  conditions: [],
  actions: [{ type: 'add_note', text: 'Hello' }],
  ...over,
});

describe('textMatches', () => {
  it.each([
    ['contains', '/pricing', '/en/pricing/teams', true],
    ['contains', 'PRICING', '/pricing', true],
    ['not_contains', '/pricing', '/about', true],
    ['not_contains', '/pricing', '/pricing', false],
    ['starts_with', '/shop', '/shop/cart', true],
    ['starts_with', '/shop', '/en/shop', false],
    ['is', '/pricing', '/pricing/', true],
    ['is', '/pricing/', '/pricing', true],
    ['is', '/', '/', true],
    ['is', '/pricing', '/pricing/teams', false],
  ] as const)('%s %s against %s → %s', (op, expected, subject, result) => {
    expect(textMatches(op, expected, subject)).toBe(result);
  });
});

describe('checkCondition', () => {
  it('treats an unknown fact as unknown, whatever the operator', () => {
    expect(checkCondition({ field: 'page_url', op: 'not_contains', value: '/x' }, {})).toBeNull();
    expect(checkCondition({ field: 'country', op: 'is_not', value: ['DE'] }, {})).toBeNull();
    expect(checkCondition({ field: 'hours_open', op: 'is', value: false }, {})).toBeNull();
    expect(
      checkCondition({ field: 'tag', op: 'is_not', value: ['vip'] }, { tag: null }),
    ).toBeNull();
  });

  it('counts visits both ways', () => {
    const facts = { visit_count: 3 };
    expect(checkCondition({ field: 'visit_count', op: 'at_least', value: 3 }, facts)).toBe(true);
    expect(checkCondition({ field: 'visit_count', op: 'at_least', value: 4 }, facts)).toBe(false);
    expect(checkCondition({ field: 'visit_count', op: 'at_most', value: 3 }, facts)).toBe(true);
  });

  it('matches a language by its first part', () => {
    const c = { field: 'language', op: 'is', value: ['ar'] } as const;
    expect(checkCondition({ ...c, value: ['ar'] }, { language: 'ar-EG' })).toBe(true);
    expect(checkCondition({ ...c, value: ['ar'] }, { language: 'en' })).toBe(false);
  });

  it('finds a tag among several, ignoring case', () => {
    const facts = { tag: ['Billing', 'vip'] };
    expect(checkCondition({ field: 'tag', op: 'is', value: ['VIP'] }, facts)).toBe(true);
    expect(checkCondition({ field: 'tag', op: 'is_not', value: ['vip'] }, facts)).toBe(false);
    expect(checkCondition({ field: 'tag', op: 'is_not', value: ['refund'] }, facts)).toBe(true);
  });

  it('compares flags and choices', () => {
    expect(
      checkCondition({ field: 'hours_open', op: 'is', value: false }, { hours_open: false }),
    ).toBe(true);
    expect(
      checkCondition({ field: 'owner', op: 'is_not', value: ['ai'] }, { owner: 'waiting' }),
    ).toBe(true);
    expect(
      checkCondition({ field: 'country', op: 'is', value: ['ae', 'SA'] }, { country: 'AE' }),
    ).toBe(true);
  });
});

describe('evaluate', () => {
  const conditions = [
    { field: 'page_url', op: 'contains', value: '/pricing' },
    { field: 'country', op: 'is', value: ['AE'] },
  ] as AutomationDefinition['conditions'];

  it('needs every condition for "all" and one for "any"', () => {
    const facts = { page_url: '/pricing', country: 'DE' };
    expect(evaluate({ match: 'all', conditions }, facts)).toEqual({
      matched: false,
      conditions: [true, false],
    });
    expect(evaluate({ match: 'any', conditions }, facts).matched).toBe(true);
  });

  it('never matches on unknown facts', () => {
    expect(evaluate({ match: 'any', conditions }, {})).toEqual({
      matched: false,
      conditions: [null, null],
    });
  });

  it('matches a rule without conditions', () => {
    expect(evaluate({ match: 'all', conditions: [] }, {}).matched).toBe(true);
    expect(evaluate({ match: 'any', conditions: [] }, {}).matched).toBe(true);
  });
});

describe('excludesAi', () => {
  it.each([
    [{ field: 'owner', op: 'is', value: ['waiting'] }, 'all', true],
    [{ field: 'owner', op: 'is', value: ['waiting', 'person'] }, 'all', true],
    [{ field: 'owner', op: 'is', value: ['ai', 'waiting'] }, 'all', false],
    [{ field: 'owner', op: 'is_not', value: ['ai'] }, 'all', true],
    [{ field: 'owner', op: 'is_not', value: ['person'] }, 'all', false],
    [{ field: 'owner', op: 'is_not', value: ['ai'] }, 'any', false],
    [{ field: 'owner', op: 'is', value: [] }, 'all', false],
  ] as const)('%j with %s → %s', (condition, match, expected) => {
    expect(excludesAi({ match, conditions: [condition as never] })).toBe(expected);
  });
});

describe('definitionProblems', () => {
  it('accepts a sound chat rule', () => {
    expect(
      definitionProblems(
        rule({
          conditions: [{ field: 'owner', op: 'is', value: ['waiting'] }],
          actions: [
            { type: 'send_message', message: { en: 'Thanks, someone will reply soon.' } },
            { type: 'set_priority', priority: 'high' },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('refuses a message that could interrupt the AI', () => {
    expect(
      definitionProblems(rule({ actions: [{ type: 'send_message', message: { en: 'Hi' } }] })),
    ).toEqual([{ path: ['actions', 0, 'type'], code: 'message_needs_people' }]);
  });

  it('refuses a message after the chat closed', () => {
    expect(
      definitionProblems(
        rule({
          event: { type: 'chat_closed', seconds: 0 },
          conditions: [{ field: 'owner', op: 'is_not', value: ['ai'] }],
          actions: [{ type: 'send_message', message: { en: 'Bye' } }],
        }),
      ),
    ).toEqual([{ path: ['actions', 0, 'type'], code: 'message_after_close' }]);
  });

  it('keeps website rules to website conditions and a prompt', () => {
    expect(
      definitionProblems(
        rule({
          event: { type: 'page_view', seconds: 10 },
          conditions: [{ field: 'tag', op: 'is', value: ['vip'] }],
          actions: [{ type: 'add_note', text: 'x' }],
        }),
      ),
    ).toEqual([
      { path: ['conditions', 0, 'field'], code: 'field_not_allowed' },
      { path: ['actions', 0, 'type'], code: 'action_not_allowed' },
      { path: ['actions'], code: 'prompt_required' },
    ]);
  });

  it('refuses a repeated single action, but not two tags', () => {
    expect(
      definitionProblems(
        rule({
          actions: [
            { type: 'add_tag', tag: 'a' },
            { type: 'add_tag', tag: 'b' },
            { type: 'make_ticket' },
            { type: 'make_ticket' },
          ],
        }),
      ),
    ).toEqual([{ path: ['actions', 3, 'type'], code: 'action_repeated' }]);
  });

  it('checks the seconds an event waits', () => {
    expect(definitionProblems(rule({ event: { type: 'customer_waiting', seconds: 10 } }))).toEqual([
      { path: ['event', 'seconds'], code: 'seconds_out_of_range' },
    ]);
    expect(definitionProblems(rule({ event: { type: 'chat_started', seconds: 5 } }))).toEqual([
      { path: ['event', 'seconds'], code: 'seconds_out_of_range' },
    ]);
  });
});

describe('splitForBrowser', () => {
  const page = { field: 'page_url', op: 'contains', value: '/pricing' } as const;
  const country = { field: 'country', op: 'is', value: ['AE'] } as const;

  it('"all": the gateway decides its conditions, the browser gets the rest', () => {
    expect(
      splitForBrowser({ match: 'all', conditions: [page, country] }, { country: 'AE' }),
    ).toEqual({ any: false, when: [['page_url', 'contains', '/pricing']] });
    expect(
      splitForBrowser({ match: 'all', conditions: [page, country] }, { country: 'DE' }),
    ).toBeNull();
    expect(splitForBrowser({ match: 'all', conditions: [page, country] }, {})).toBeNull();
  });

  it('"any": a known condition settles it; otherwise the browser needs one of its own', () => {
    expect(
      splitForBrowser({ match: 'any', conditions: [page, country] }, { country: 'AE' }),
    ).toEqual({ any: false, when: [] });
    expect(
      splitForBrowser({ match: 'any', conditions: [page, country] }, { country: 'DE' }),
    ).toEqual({ any: true, when: [['page_url', 'contains', '/pricing']] });
    expect(splitForBrowser({ match: 'any', conditions: [country] }, { country: 'DE' })).toBeNull();
    expect(splitForBrowser({ match: 'any', conditions: [] }, {})).toEqual({ any: false, when: [] });
  });

  it('agrees with evaluate once the browser has its facts', () => {
    const conditions = [
      page,
      country,
      { field: 'visit_count', op: 'at_least', value: 2 },
      { field: 'device', op: 'is', value: ['mobile'] },
    ] as AutomationDefinition['conditions'];
    const browsers = [
      { page_url: '/pricing', referrer: '', visit_count: 3, device: 'mobile' as const },
      { page_url: '/about', referrer: '', visit_count: 1, device: 'desktop' as const },
      { page_url: '/pricing', referrer: '', visit_count: 1, device: 'mobile' as const },
    ];
    for (const match of ['all', 'any'] as const) {
      for (const countryCode of ['AE', 'DE']) {
        for (const browser of browsers) {
          const split = splitForBrowser({ match, conditions }, { country: countryCode });
          const loader = split !== null && browserMatches(split, browser);
          const whole = evaluate({ match, conditions }, { ...browser, country: countryCode });
          expect(loader, `${match} ${countryCode} ${JSON.stringify(browser)}`).toBe(whole.matched);
        }
      }
    }
  });
});

describe('deviceOf', () => {
  it('classes a window by width', () => {
    expect(deviceOf(375)).toBe('mobile');
    expect(deviceOf(800)).toBe('tablet');
    expect(deviceOf(1280)).toBe('desktop');
  });
});
