import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import type { QueryClient } from '@tanstack/react-query';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { inboxKeys } from '../src/lib/inbox';
import type { InboxPreferences } from '../src/lib/inbox-alerts';
import { AlertSettingsForm } from '../src/pages/inbox/AlertSettings';
import { UnreadBadge } from '../src/pages/inbox/InboxPage';
import { DesktopPromptCard, InboxToolbar, StaffStatus } from '../src/pages/inbox/InboxToolbar';
import { CustomerTypingLine } from '../src/pages/inbox/Typing';
import { renderStudio, TENANT_ID, textOf } from './render';

beforeAll(async () => {
  await initI18n('en');
});

const AGENT = ['conversations.read', 'conversations.reply'];

const preferences = (
  alerts: Partial<InboxPreferences['alerts']> = {},
  availability: InboxPreferences['availability'] = { choice: 'online', effective: 'online' },
): InboxPreferences => ({
  alerts: {
    sounds: {
      muted: false,
      volume: 60,
      newChat: 'chime',
      customerMessage: 'pop',
      assigned: 'bell',
    },
    desktop: { enabled: true, showPreview: true },
    ...alerts,
  },
  availability,
});

const seedPreferences = (value: InboxPreferences) => (client: QueryClient) =>
  client.setQueryData([TENANT_ID, ...inboxKeys.preferences], value);

const render = (screen: React.ReactNode, seed?: (client: QueryClient) => void) =>
  renderStudio({
    at: '/inbox',
    permissions: AGENT,
    screen: <AnnouncerProvider>{screen}</AnnouncerProvider>,
    ...(seed ? { seed } : {}),
  });

/** The value attribute of the option the browser would show as chosen in a select with this id. */
const chosen = (html: string, id: string) => {
  const select = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`));
  const option = select?.[1]?.match(/<option[^>]*value="([^"]*)"[^>]*selected/);
  return option?.[1];
};

describe('your status', () => {
  it('lets you choose online, away or offline, and says what customers are told', async () => {
    const html = await render(<InboxToolbar />, seedPreferences(preferences()));
    const text = textOf(html);
    expect(text).toContain('Your status');
    expect(chosen(html, 'my-status')).toBe('online');
    for (const word of ['Online', 'Away', 'Offline']) expect(text).toContain(word);
    expect(text).toContain('Customers are told a person is online only while someone');
    expect(text).toContain('Alerts');
  });

  it('shows what you chose, and says so when your team sees you as away', async () => {
    const away = await render(
      <InboxToolbar />,
      seedPreferences(preferences({}, { choice: 'away', effective: 'away' })),
    );
    expect(chosen(away, 'my-status')).toBe('away');
    expect(textOf(away)).not.toContain('Studio has not been used');

    const idle = await render(
      <InboxToolbar />,
      seedPreferences(preferences({}, { choice: 'online', effective: 'away' })),
    );
    expect(chosen(idle, 'my-status')).toBe('online');
    expect(textOf(idle)).toContain('Your team sees you as away: Studio has not been used');
  });

  it('names a teammate’s status in words, not only by a dot', async () => {
    for (const [status, word] of [
      ['online', 'Online'],
      ['away', 'Away'],
      ['offline', 'Offline'],
    ] as const) {
      const html = await render(<StaffStatus status={status} />);
      expect(textOf(html)).toBe(word);
      expect(html).toContain(`data-status="${status}"`);
    }
  });
});

describe('sounds and desktop alerts settings', () => {
  it('shows what the person chose for each event, with a button to hear it', async () => {
    const html = await render(
      <AlertSettingsForm />,
      seedPreferences(
        preferences({
          sounds: {
            muted: false,
            volume: 35,
            newChat: 'bell',
            customerMessage: 'none',
            assigned: 'ping',
          },
        }),
      ),
    );
    expect(chosen(html, 'sound-new-chat')).toBe('bell');
    expect(chosen(html, 'sound-customer-message')).toBe('none');
    expect(chosen(html, 'sound-assigned')).toBe('ping');
    const text = textOf(html);
    for (const label of [
      'A chat is waiting for a person',
      'A customer writes in your chat, or in a chat nobody has taken',
      'A chat is assigned or transferred to you',
      'Mute all sounds',
      'Volume',
      'Desktop alerts',
      'Show the start of the customer’s message',
    ]) {
      expect(text).toContain(label);
    }
    // All five sounds, and "No sound", can be picked.
    for (const sound of ['Chime', 'Pop', 'Bell', 'Drop', 'Ping', 'No sound']) {
      expect(text).toContain(sound);
    }
    expect(html).toMatch(/<input[^>]*id="alert-volume"[^>]*value="35"/);
    expect(html).toContain('aria-valuetext="35 percent"');
    // A button to play each sound that is set, none for "No sound".
    expect(html).toContain('aria-label="Play Bell"');
    expect(html).toContain('aria-label="Play Ping"');
    expect(html).toContain('aria-label="Play No sound"');
    expect(text).not.toContain('No sound will play');
  });

  it('says plainly when nothing will play, and does not offer to play', async () => {
    const muted = await render(
      <AlertSettingsForm />,
      seedPreferences(
        preferences({
          sounds: {
            muted: true,
            volume: 60,
            newChat: 'chime',
            customerMessage: 'pop',
            assigned: 'bell',
          },
        }),
      ),
    );
    expect(textOf(muted)).toContain(
      'No sound will play while sounds are muted or the volume is at 0.',
    );
    expect(muted).toMatch(/<input[^>]*id="alert-volume"[^>]*disabled/);
    const buttons = [...muted.matchAll(/<button[^>]*aria-label="Play [^"]*"[^>]*>/g)];
    expect(buttons).toHaveLength(3);
    for (const [button] of buttons) expect(button).toContain('disabled');
  });

  it('says what this browser can do about desktop alerts', async () => {
    // Tests run without a browser, so there is nothing to ask permission from.
    const html = await render(<AlertSettingsForm />, seedPreferences(preferences()));
    expect(textOf(html)).toContain('This browser cannot show desktop alerts.');
  });

  it('asks for permission in words, with a button, and lets the person say not now', async () => {
    const html = await render(
      <DesktopPromptCard onAllow={() => undefined} onLater={() => undefined} />,
    );
    const text = textOf(html);
    expect(text).toContain('Hear about new chats while Studio is in the background');
    expect(text).toContain('Allow desktop alerts');
    expect(text).toContain('Not now');
  });
});

describe('unread chats and typing', () => {
  it('shows how many messages are unread, and says it in a sentence for a screen reader', async () => {
    const html = await render(<UnreadBadge count={3} />);
    expect(html).toContain('data-testid="unread-badge"');
    expect(html).toContain('<span aria-hidden="true">3</span>');
    expect(textOf(html)).toContain('Unread messages: 3');
    expect(textOf(await render(<UnreadBadge count={120} />))).toContain('99+');
  });

  it('says who is typing, and keeps its space when nobody is', async () => {
    const detail = (customerTyping: boolean) =>
      ({ customerTyping, customer: { displayName: 'Maya Khan' } }) as Parameters<
        typeof CustomerTypingLine
      >[0]['detail'];
    const typing = await render(<CustomerTypingLine detail={detail(true)} />);
    expect(textOf(typing)).toBe('Maya Khan is typing…');
    // Not announced to a screen reader every time the customer starts again.
    expect(typing).toContain('aria-live="off"');
    const quiet = await render(<CustomerTypingLine detail={detail(false)} />);
    expect(textOf(quiet)).toBe('');
    expect(quiet).toContain('min-h-6');
  });
});
