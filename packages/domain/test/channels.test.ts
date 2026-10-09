import { describe, expect, it } from 'vitest';
import {
  CHANNEL_CAPABILITIES,
  channelNameOf,
  replyWindowClosesAt,
  replyWindowOpen,
} from '../src/channels.js';

const at = (iso: string) => new Date(iso);

describe('replyWindowOpen (W24)', () => {
  it('lets WhatsApp send free text for 24 hours after the customer wrote', () => {
    const last = at('2026-10-09T10:00:00Z');
    expect(replyWindowOpen('whatsapp', last, at('2026-10-10T09:59:59Z'))).toBe(true);
    expect(replyWindowOpen('whatsapp', last, at('2026-10-10T10:00:00Z'))).toBe(false);
    expect(replyWindowClosesAt('whatsapp', last)?.toISOString()).toBe('2026-10-10T10:00:00.000Z');
  });

  it('never opens on WhatsApp before the customer writes', () => {
    expect(replyWindowOpen('whatsapp', null, at('2026-10-09T10:00:00Z'))).toBe(false);
  });

  it('has no window on the other channels', () => {
    const long = at('2020-01-01T00:00:00Z');
    for (const channel of ['chat', 'email', 'telegram', 'other'] as const) {
      expect(replyWindowOpen(channel, long, at('2026-10-09T10:00:00Z'))).toBe(true);
      expect(replyWindowClosesAt(channel, long)).toBeNull();
    }
  });
});

describe('channel capabilities (W24)', () => {
  it('names Chatwoot channel classes', () => {
    expect(channelNameOf('Channel::Api')).toBe('chat');
    expect(channelNameOf('Channel::Whatsapp')).toBe('whatsapp');
    expect(channelNameOf('Channel::Telegram')).toBe('telegram');
    expect(channelNameOf('Channel::Line')).toBe('other');
  });

  it('keeps cards to web chat', () => {
    expect(
      Object.entries(CHANNEL_CAPABILITIES)
        .filter(([, c]) => c.richCards)
        .map(([name]) => name),
    ).toEqual(['chat']);
  });
});
