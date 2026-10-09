/**
 * What each channel can carry (W24). Studio's composer, the AI and automations read it, so a
 * reply is never written that the channel cannot deliver.
 */
export type ChannelName = 'chat' | 'email' | 'whatsapp' | 'telegram' | 'other';

export interface ChannelCapabilities {
  /** Product and order cards render as cards; elsewhere they fall back to text and a link. */
  richCards: boolean;
  attachments: boolean;
  /** The longest text one message may have; null when the channel sets no limit. */
  maxLength: number | null;
  /**
   * Hours after the customer's last message in which free text may be sent. WhatsApp allows only
   * approved template messages after 24 hours. Null: no window.
   */
  replyWindowHours: number | null;
}

export const CHANNEL_CAPABILITIES: Record<ChannelName, ChannelCapabilities> = {
  chat: { richCards: true, attachments: true, maxLength: null, replyWindowHours: null },
  email: { richCards: false, attachments: true, maxLength: null, replyWindowHours: null },
  whatsapp: { richCards: false, attachments: true, maxLength: 4096, replyWindowHours: 24 },
  telegram: { richCards: false, attachments: true, maxLength: 4096, replyWindowHours: null },
  other: { richCards: false, attachments: true, maxLength: null, replyWindowHours: null },
};

/** Chatwoot's channel class as Hamnivo names the channel. */
export function channelNameOf(channelType: string): ChannelName {
  switch (channelType) {
    case 'Channel::Api':
    case 'Channel::WebWidget':
      return 'chat';
    case 'Channel::Email':
      return 'email';
    case 'Channel::Whatsapp':
      return 'whatsapp';
    case 'Channel::Telegram':
      return 'telegram';
    default:
      return 'other';
  }
}

/**
 * Whether free text may still be sent. With no customer message yet the window has not opened:
 * on WhatsApp a business may not start a conversation with free text.
 */
export function replyWindowOpen(
  channel: ChannelName,
  lastCustomerMessageAt: Date | null,
  now: Date,
): boolean {
  const hours = CHANNEL_CAPABILITIES[channel].replyWindowHours;
  if (hours === null) return true;
  if (!lastCustomerMessageAt) return false;
  return now.getTime() - lastCustomerMessageAt.getTime() < hours * 3_600_000;
}

/** When the window closes, for the composer to say so; null when the channel has none. */
export function replyWindowClosesAt(
  channel: ChannelName,
  lastCustomerMessageAt: Date | null,
): Date | null {
  const hours = CHANNEL_CAPABILITIES[channel].replyWindowHours;
  if (hours === null || !lastCustomerMessageAt) return null;
  return new Date(lastCustomerMessageAt.getTime() + hours * 3_600_000);
}
