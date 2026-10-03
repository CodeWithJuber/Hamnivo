import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import {
  CODE_PATTERN,
  DEFAULT_TAG_COLOR,
  insertAt,
  isNotSetUp,
  LIMITS,
  paletteColor,
  REPLY_DETAILS,
  refusedField,
  TAG_COLORS,
  TAG_PATTERN,
} from '../src/lib/library';
import { matches } from '../src/pages/library/RepliesSection';
import { tagChange } from '../src/pages/library/TagsSection';

const problem = (extra: Record<string, unknown>) =>
  ({ code: 'VALIDATION_FAILED', status: 422, title: 'x', ...extra }) as never;

describe('adding a detail to a saved reply', () => {
  it('puts it where the cursor was and leaves the cursor after it', () => {
    expect(insertAt('Hello , welcome', '{{contact.first_name}}', 6, 6)).toEqual({
      text: 'Hello {{contact.first_name}}, welcome',
      cursor: 6 + '{{contact.first_name}}'.length,
    });
  });

  it('replaces what was selected', () => {
    expect(insertAt('Hello NAME!', '{{agent.name}}', 6, 10)).toEqual({
      text: 'Hello {{agent.name}}!',
      cursor: 6 + '{{agent.name}}'.length,
    });
  });

  it('goes at the end when the cursor is past it, and at the start when before it', () => {
    expect(insertAt('Hi', '{{x}}', 99, 99).text).toBe('Hi{{x}}');
    expect(insertAt('Hi', '{{x}}', -4, -1).text).toBe('{{x}}Hi');
    expect(insertAt('', '{{x}}', 0, 0)).toEqual({ text: '{{x}}', cursor: 5 });
  });

  it('offers only details the chat account knows how to fill in', () => {
    expect(REPLY_DETAILS.map((d) => d.token)).toEqual([
      '{{contact.first_name}}',
      '{{contact.name}}',
      '{{agent.name}}',
      '{{inbox.name}}',
    ]);
  });
});

describe('tag colours', () => {
  it('starts a new tag on the chat account’s own blue', () => {
    expect(DEFAULT_TAG_COLOR).toBe('#1f93ff');
    expect(TAG_COLORS[0]?.id).toBe('blue');
  });

  it('knows a ready-made colour in any letter case, and not one made elsewhere', () => {
    expect(paletteColor('#1F93FF')?.id).toBe('blue');
    expect(paletteColor('#16a34a')?.id).toBe('green');
    expect(paletteColor('#123456')).toBeUndefined();
    expect(paletteColor(null)).toBeUndefined();
  });

  it('has eight different colours, each a six-digit code', () => {
    expect(new Set(TAG_COLORS.map((c) => c.hex)).size).toBe(8);
    for (const color of TAG_COLORS) expect(color.hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('names of short codes and tags', () => {
  it('lets a short code hold letters of any script with their marks, numbers, - and _', () => {
    for (const ok of [
      'refund-policy',
      'vip_2',
      'Order',
      'عميل',
      'टैग',
      'वापसी',
      'گاہک',
      '2fa',
      'x',
    ]) {
      expect(CODE_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of ['two words', 'a/b', 'a{b}', 'hi!', '', 'a.b']) {
      expect(CODE_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('holds a tag to the chat service’s own rule', () => {
    for (const ok of ['vip', 'order-problem', 'vip_2', 'عميل', 'گاہک', '2fa', 'ab']) {
      expect(TAG_PATTERN.test(ok), ok).toBe(true);
    }
    // One character, a name that starts with - or _, spaces, symbols, and letters with vowel signs.
    for (const bad of ['x', '-vip', '_vip', 'two words', 'a/b', 'hi!', '', 'a.b', 'टैग']) {
      expect(TAG_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('uses the limits the gateway enforces', () => {
    expect(LIMITS).toEqual({ code: 40, text: 5000, tag: 50, description: 200 });
  });
});

describe('what the gateway refused', () => {
  it('names the field it refused', () => {
    const error = new ApiError(
      422,
      'VALIDATION_FAILED',
      problem({ fields: [{ path: 'shortCode', message: 'taken' }] }),
    );
    expect(refusedField(error, 'shortCode')).toBe(true);
    expect(refusedField(error, 'content')).toBe(false);
    expect(refusedField(new Error('x'), 'shortCode')).toBe(false);
    expect(refusedField(null, 'shortCode')).toBe(false);
  });

  it('knows a brand that has no chat account yet', () => {
    expect(
      isNotSetUp(new ApiError(422, 'VALIDATION_FAILED', problem({ reason: 'no_chat_account' }))),
    ).toBe(true);
    expect(isNotSetUp(new ApiError(422, 'VALIDATION_FAILED', problem({})))).toBe(false);
    expect(
      isNotSetUp(new ApiError(403, 'SCOPE_DENIED', problem({ reason: 'no_chat_account' }))),
    ).toBe(false);
  });
});

describe('searching saved replies', () => {
  const reply = {
    id: 'srp_1',
    shortCode: 'Refund-Policy',
    content: 'You can return it within 30 days.',
  };

  it('matches the short code or the text, in any letter case', () => {
    expect(matches(reply as never, 'refund')).toBe(true);
    expect(matches(reply as never, 'WITHIN 30')).toBe(true);
    expect(matches(reply as never, 'shipping')).toBe(false);
  });

  it('matches everything when nothing is typed', () => {
    expect(matches(reply as never, '')).toBe(true);
    expect(matches(reply as never, '   ')).toBe(true);
  });
});

describe('what a tag form sends', () => {
  const vip = { title: 'vip', description: 'Top customers', color: '#FF8800' };

  it('sends everything for a new tag, in lower case, leaving out an empty description', () => {
    expect(tagChange(null, { name: '  VIP ', description: ' Top ', color: '#1f93ff' })).toEqual({
      title: 'vip',
      description: 'Top',
      color: '#1f93ff',
    });
    expect(tagChange(null, { name: 'refund', description: '  ', color: '#16a34a' })).toEqual({
      title: 'refund',
      color: '#16a34a',
    });
  });

  it('sends only the tag’s name when nothing else changed', () => {
    expect(tagChange(vip, { name: 'vip', description: 'Top customers', color: '#ff8800' })).toEqual(
      {
        was: 'vip',
      },
    );
  });

  it('sends only what changed, and clears a description with null', () => {
    expect(
      tagChange(vip, { name: 'Gold', description: 'Top customers', color: '#ff8800' }),
    ).toEqual({
      was: 'vip',
      title: 'gold',
    });
    expect(tagChange(vip, { name: 'vip', description: '', color: '#ff8800' })).toEqual({
      was: 'vip',
      description: null,
    });
    expect(tagChange(vip, { name: 'vip', description: 'Top customers', color: '#16a34a' })).toEqual(
      {
        was: 'vip',
        color: '#16a34a',
      },
    );
  });

  it('treats a tag without a colour as the default one', () => {
    const plain = { title: 'refund', description: null, color: null };
    expect(tagChange(plain, { name: 'refund', description: '', color: DEFAULT_TAG_COLOR })).toEqual(
      {
        was: 'refund',
      },
    );
  });
});
