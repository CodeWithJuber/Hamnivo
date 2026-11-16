import { describe, expect, it } from 'vitest';
import {
  AutomationDefinition,
  allRoutes,
  HostToFrame,
  LauncherConfig,
  PromptLimits,
  parsePart,
  partsToPlainText,
  ReactionRequest,
  SendMessageRequest,
  WidgetAppearance,
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

  it('keeps the launcher on the screen, and leaves its place out until a brand chooses one', () => {
    const ok = (layout: unknown) => WidgetSettings.safeParse({ layout }).success;
    expect(ok({ offset: { x: 0, y: 400 }, hideOnMobile: true })).toBe(true);
    expect(ok({ offset: { x: -1, y: 20 } })).toBe(false);
    expect(ok({ offset: { x: 20, y: 401 } })).toBe(false);
    expect(ok({ offset: { x: 20.5, y: 20 } })).toBe(false);
    expect(WidgetSettings.parse({}).layout).not.toHaveProperty('offset');
    expect(WidgetSettings.parse({}).help).not.toHaveProperty('followUps');
  });
});

describe('the brand’s look (W03)', () => {
  it('reads a look saved before light or dark and the launcher could be chosen', () => {
    const old = WidgetAppearance.parse({ primaryColor: '#0B5D3B' });
    expect(old.theme).toBeUndefined();
    expect(old.headerStyle).toBeUndefined();
    expect(old.launcherIcon).toBeUndefined();
    expect(old.launcherSize).toBeUndefined();
  });

  it('accepts only the offered themes, headers and launchers', () => {
    const ok = (look: object) =>
      WidgetAppearance.safeParse({ primaryColor: '#0B5D3B', ...look }).success;
    expect(
      ok({ theme: 'dark', headerStyle: 'plain', launcherIcon: 'sparkle', launcherSize: 'large' }),
    ).toBe(true);
    expect(ok({ theme: 'sepia' })).toBe(false);
    expect(ok({ headerStyle: 'gradient' })).toBe(false);
    expect(ok({ launcherIcon: 'rocket' })).toBe(false);
    expect(ok({ launcherSize: 'xl' })).toBe(false);
  });

  it('lets an older launcher configuration without them still parse', () => {
    const launcher = {
      widgetId: 'wid_1',
      version: 1,
      locale: 'en',
      dir: 'ltr',
      layout: { mode: 'bubble', position: 'bottom-right' },
      launcher: {
        accent: '#0B5D3B',
        onAccent: '#FFFFFF',
        openLabel: 'Open chat',
        closeLabel: 'Close chat',
        title: 'Chat',
        dismissLabel: 'Dismiss',
        unreadLabel: '{count} unread',
      },
      proactive: { enabled: false, maxPerDay: 1, dismissHours: 24, triggers: [], rules: [] },
    };
    expect(LauncherConfig.safeParse(launcher).success).toBe(true);
    expect(
      LauncherConfig.safeParse({
        ...launcher,
        theme: 'dark',
        layout: { ...launcher.layout, offset: { x: 24, y: 88 }, hideOnMobile: true },
        launcher: { ...launcher.launcher, icon: 'help', size: 'small' },
      }).success,
    ).toBe(true);
  });
});

describe('website prompt limits (W19, G21)', () => {
  it('shows at most one prompt a day by default', () => {
    expect(PromptLimits.parse({})).toEqual({ maxPerDay: 1, dismissHours: 24 });
  });

  it('bounds the limits so no configuration can spam a visitor', () => {
    const ok = (value: unknown) => PromptLimits.safeParse(value).success;
    expect(ok({ maxPerDay: 3 })).toBe(true);
    expect(ok({ maxPerDay: 4 })).toBe(false);
    expect(ok({ dismissHours: 0 })).toBe(false);
    expect(ok({ dismissHours: 169 })).toBe(false);
  });
});

describe('automations (G21)', () => {
  const prompt = {
    event: { type: 'page_view', seconds: 30 },
    conditions: [{ field: 'page_url', op: 'contains', value: '/pricing' }],
    actions: [{ type: 'show_prompt', message: { en: 'Questions about plans? Ask us.' } }],
  };
  const ok = (value: unknown) => AutomationDefinition.safeParse(value).success;

  it('fills in "all" and no conditions', () => {
    expect(
      AutomationDefinition.parse({
        event: { type: 'chat_started' },
        actions: [{ type: 'make_ticket' }],
      }),
    ).toEqual({
      event: { type: 'chat_started', seconds: 0 },
      match: 'all',
      conditions: [],
      actions: [{ type: 'make_ticket' }],
    });
  });

  it('types each condition by its field', () => {
    expect(ok(prompt)).toBe(true);
    const condition = (c: unknown) => ok({ ...prompt, conditions: [c] });
    expect(condition({ field: 'visit_count', op: 'at_least', value: 3 })).toBe(true);
    expect(condition({ field: 'visit_count', op: 'contains', value: 3 })).toBe(false);
    expect(condition({ field: 'country', op: 'is', value: ['AE', 'SA'] })).toBe(true);
    expect(condition({ field: 'country', op: 'is', value: [] })).toBe(false);
    expect(condition({ field: 'hours_open', op: 'is', value: 'yes' })).toBe(false);
    expect(condition({ field: 'page_url', op: 'contains', value: '' })).toBe(false);
    expect(condition({ field: 'mood', op: 'is', value: ['happy'] })).toBe(false);
  });

  it('bounds conditions, actions and words', () => {
    expect(ok({ ...prompt, actions: [] })).toBe(false);
    expect(ok({ ...prompt, actions: Array.from({ length: 6 }, () => prompt.actions[0]) })).toBe(
      false,
    );
    expect(
      ok({ ...prompt, conditions: Array.from({ length: 11 }, () => prompt.conditions[0]) }),
    ).toBe(false);
    expect(
      ok({ ...prompt, actions: [{ type: 'show_prompt', message: { en: 'x'.repeat(161) } }] }),
    ).toBe(false);
    expect(ok({ ...prompt, event: { type: 'customer_waiting', seconds: 3601 } })).toBe(false);
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
    expect(allRoutes.publishAutomation?.auth).toBe('staff_session');
    expect(allRoutes.launcherConfig?.auth).toBe('public');
    expect(allRoutes.uploadAttachment?.rawBody?.contentType).toBe('application/octet-stream');
  });
});
