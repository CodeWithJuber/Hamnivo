import { describe, expect, it } from 'vitest';
import {
  allRoutes,
  HostToFrame,
  ProactiveSettings,
  parsePart,
  partsToPlainText,
  ReactionRequest,
  SendMessageRequest,
  WidgetSettings,
} from '../src/index.js';

describe('extended content (W24)', () => {
  it('parses locations and contacts, and degrades invalid ones to text instead of failing', () => {
    const place = parsePart({
      type: 'location',
      latitude: 25.2048,
      longitude: 55.2708,
      label: 'Noor Books, Al Fahidi',
    });
    expect(place.type).toBe('location');
    const person = parsePart({
      type: 'contact',
      name: 'Aisha Khan',
      phone: '+971 4 123 4567',
      email: 'aisha@example.com',
    });
    expect(person.type).toBe('contact');
    expect(partsToPlainText([place, person])).toBe(
      'Noor Books, Al Fahidi (25.20480, 55.27080)\nAisha Khan, +971 4 123 4567, aisha@example.com',
    );
    // Out of range, or a phone field that carries a link: unknown, rendered as its fallback text.
    expect(parsePart({ type: 'location', latitude: 91, longitude: 0, label: null }).type).toBe(
      'unknown',
    );
    expect(
      parsePart({
        type: 'contact',
        name: 'x',
        phone: 'javascript:alert(1)',
        email: null,
        fallbackText: 'Contact: x',
      }),
    ).toEqual({ type: 'unknown', originalType: 'contact', fallbackText: 'Contact: x' });
  });

  it('keeps a future part as text when it offers some', () => {
    expect(parsePart({ type: 'poll', text: 'Which size?' })).toEqual({
      type: 'unknown',
      originalType: 'poll',
      fallbackText: 'Which size?',
    });
  });
});

describe('reactions (W22)', () => {
  it('accepts only the offered reactions', () => {
    const clientMessageId = '8f14e45f-ceea-467a-9a3e-2d2f0b5c4a11';
    expect(ReactionRequest.safeParse({ clientMessageId, emoji: '👍' }).success).toBe(true);
    expect(ReactionRequest.safeParse({ clientMessageId, emoji: '<b>' }).success).toBe(false);
    const part = parsePart({ type: 'reaction', emoji: '❤️', messageId: 'msg_x' });
    expect(partsToPlainText([part])).toBe('❤️');
  });

  it('does not let a customer send a reaction part as a message', () => {
    const sent = SendMessageRequest.safeParse({
      clientMessageId: '8f14e45f-ceea-467a-9a3e-2d2f0b5c4a11',
      parts: [{ type: 'reaction', emoji: '👍', messageId: 'msg_x' }],
    });
    expect(sent.success).toBe(false);
  });
});

describe('widget settings (W02, W09, W17, W23, W25)', () => {
  it('fills safe defaults', () => {
    const settings = WidgetSettings.parse({});
    expect(settings).toEqual({
      layout: { mode: 'bubble', position: 'bottom-right' },
      attachments: {
        enabled: true,
        allowedTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'],
        maxMegabytes: 10,
        maxFiles: 5,
      },
      help: { suggestions: [], search: true },
      deletion: { windowMinutes: 10 },
      notifications: { email: true },
    });
  });

  it('never allows file types outside the safe list or limits above the ceiling', () => {
    const bad = (value: unknown) => WidgetSettings.safeParse(value).success;
    expect(bad({ attachments: { allowedTypes: ['image/svg+xml'] } })).toBe(false);
    expect(bad({ attachments: { allowedTypes: ['application/zip'] } })).toBe(false);
    expect(bad({ attachments: { maxMegabytes: 11 } })).toBe(false);
    expect(bad({ attachments: { maxFiles: 6 } })).toBe(false);
    expect(bad({ layout: { mode: 'floating' } })).toBe(false);
    expect(bad({ deletion: { windowMinutes: 61 } })).toBe(false);
  });
});

describe('proactive prompts (W19)', () => {
  const trigger = {
    id: 'pricing-help',
    kind: 'page_path',
    path: '/pricing',
    message: { en: 'Questions about plans? Ask us.' },
  };

  it('is off by default, with at most one prompt a day', () => {
    expect(ProactiveSettings.parse({})).toMatchObject({
      enabled: false,
      triggers: [],
      maxPerDay: 1,
      dismissHours: 24,
    });
  });

  it('bounds the caps so no configuration can spam a visitor', () => {
    const ok = (value: unknown) => ProactiveSettings.safeParse(value).success;
    expect(ok({ enabled: true, triggers: [trigger], maxPerDay: 3 })).toBe(true);
    expect(ok({ enabled: true, triggers: [trigger], maxPerDay: 4 })).toBe(false);
    expect(ok({ enabled: true, triggers: [trigger], dismissHours: 0 })).toBe(false);
    expect(
      ok({ triggers: Array.from({ length: 6 }, (_, i) => ({ ...trigger, id: `t${i}` })) }),
    ).toBe(false);
    expect(ok({ triggers: [trigger, trigger] })).toBe(false);
  });

  it('checks each kind of trigger', () => {
    const one = (value: Record<string, unknown>) =>
      ProactiveSettings.safeParse({ triggers: [{ ...trigger, ...value }] }).success;
    expect(one({ path: null })).toBe(false);
    expect(one({ path: '/pricing?x=1' })).toBe(false);
    expect(one({ path: 'https://evil.example/' })).toBe(false);
    expect(one({ kind: 'time_on_page', path: null, seconds: 5 })).toBe(false);
    expect(one({ kind: 'time_on_page', path: null, seconds: 30 })).toBe(true);
    expect(one({ kind: 'returning_visitor', path: null })).toBe(false);
    expect(one({ kind: 'returning_visitor', path: null, visits: 2 })).toBe(true);
    expect(one({ message: { en: 'x'.repeat(161) } })).toBe(false);
    expect(one({ message: { ar: 'مرحبا' } })).toBe(false);
  });
});

describe('widget bridge (W19)', () => {
  const base = { source: 'hamnivo', v: 1, instanceId: 'default' } as const;
  it('carries only a trigger id when the chat opens from a prompt', () => {
    expect(
      HostToFrame.safeParse({ ...base, type: 'proactive', triggerId: 'pricing-help' }).success,
    ).toBe(true);
    expect(
      HostToFrame.safeParse({ ...base, type: 'proactive', triggerId: 'x'.repeat(33) }).success,
    ).toBe(false);
  });
});

describe('route registry', () => {
  it('keeps every customer route on the widget session, and settings on staff sessions', () => {
    const customer = Object.values(allRoutes).filter((r) =>
      /^\/v1\/widget\/(conversations|help|notifications)/.test(r.path),
    );
    expect(customer.length).toBeGreaterThan(10);
    expect(customer.every((r) => r.auth === 'widget_session')).toBe(true);
    expect(allRoutes.updateProactiveSettings?.auth).toBe('staff_session');
    expect(allRoutes.launcherConfig?.auth).toBe('public');
    expect(allRoutes.uploadAttachment?.rawBody?.contentType).toBe('application/octet-stream');
  });
});
