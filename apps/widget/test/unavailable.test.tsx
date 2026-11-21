import { HamnivoApiError, HamnivoClient, MemoryStorage } from '@hamnivo/client';
import type { WidgetConfig } from '@hamnivo/contracts';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { Home } from '../src/components/Home.js';
import { initI18n, LOCALES, resources } from '../src/i18n.js';
import { chatAvailable, isChatUnavailable } from '../src/useChat.js';

/**
 * When chat isn't available to a visitor (H20: a team blocked them), the chat says only that, in
 * neutral words: never that they were blocked. Help search stays, and nothing starts a chat.
 */

beforeAll(async () => {
  await initI18n('en');
});

/** Every string of a resource tree. */
function strings(tree: object): string[] {
  return Object.values(tree).flatMap((value) =>
    typeof value === 'string' ? [value] : value && typeof value === 'object' ? strings(value) : [],
  );
}

const availability = (): WidgetConfig['availability'] => ({
  humanAvailable: false,
  nextOpenAt: null,
  timezone: 'UTC',
  staffOnline: false,
  hoursSet: false,
  open: true,
});

describe('the words for chat that isn’t available', () => {
  it('say only that chat isn’t available, in every language', () => {
    expect(resources.en.translation.surface.unavailable.notice).toBe(
      'Chat isn’t available right now.',
    );
    for (const locale of LOCALES) {
      const notice = resources[locale].translation.surface.unavailable.notice;
      expect(notice.trim(), locale).not.toBe('');
      expect(resources[locale].translation.surface.delivery.causes.unavailable, locale).toBe(
        notice,
      );
    }
  });

  it('never tell a visitor they were blocked, in any language', () => {
    const blocked: Record<string, RegExp> = {
      en: /\bblock/i,
      ar: /حظر|محظور/,
      hi: /ब्लॉक|अवरुद्ध/,
      ur: /بلاک/,
    };
    for (const locale of LOCALES) {
      const said = strings(resources[locale].translation).filter((text) =>
        blocked[locale]?.test(text),
      );
      expect(said, locale).toEqual([]);
    }
  });
});

describe('whether chat is available', () => {
  const session = (chatAvailableNow: boolean) =>
    ({ config: { chatAvailable: chatAvailableNow } }) as Parameters<
      typeof chatAvailable
    >[0]['session'];

  it('follows the session, and a write the gateway refused', () => {
    expect(chatAvailable({ session: session(true), unavailable: false })).toBe(true);
    expect(chatAvailable({ session: session(false), unavailable: false })).toBe(false);
    expect(chatAvailable({ session: session(true), unavailable: true })).toBe(false);
    expect(chatAvailable({ session: null, unavailable: false })).toBe(true);
  });

  it('knows the gateway’s refusal from other errors', () => {
    expect(isChatUnavailable(new HamnivoApiError(403, 'CHAT_UNAVAILABLE', false, null))).toBe(true);
    expect(isChatUnavailable(new HamnivoApiError(403, 'CONSENT_REQUIRED', false, null))).toBe(
      false,
    );
    expect(isChatUnavailable(new Error('CHAT_UNAVAILABLE'))).toBe(false);
  });
});

describe('the home screen while chat isn’t available', () => {
  const client = new HamnivoClient({
    apiBase: 'https://api.test',
    widgetId: 'wid_test',
    storage: new MemoryStorage(),
  });

  it('keeps help search and the questions, but nothing starts a chat or leaves a message', () => {
    const html = renderToString(
      <Home
        client={client}
        greeting="Hello! Ask us anything."
        prompt={null}
        suggestions={['Where is my order?']}
        search={true}
        availability={availability()}
        locale="en"
        onContact={() => undefined}
        available={false}
        onAsk={() => undefined}
        disclosure="I'm Noor Books's AI assistant."
      />,
    );
    expect(html).toContain('data-testid="help-search"');
    expect(html).toContain('Where is my order?');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Where is my order\?<\/button>/);
    expect(html).not.toContain('contact-card');
    expect(html).not.toContain('Leave a message');
    // Who can answer is beside the point while chat isn't available.
    expect(html).not.toContain('data-testid="availability"');
    expect(html.toLowerCase()).not.toContain('block');
  });
});
