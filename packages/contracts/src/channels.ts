import { z } from 'zod';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';
import type { RouteDef } from './routes.js';

/**
 * Channels (ADR 0013): the email, WhatsApp and Telegram inboxes of a brand's Chatwoot account.
 * Chatwoot creates their conversations; Hamnivo adopts them, so they reach the inbox, routing,
 * automations and, where the owner allows it, the AI. Web chat is the brand's widget, not listed.
 */

export const ChannelKind = z.enum(['email', 'whatsapp', 'telegram', 'other']);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const ChannelInbox = z
  .object({
    id: typeId('inbox'),
    /** Null until the owner says which brand it answers for. */
    brandId: typeId('brand').nullable(),
    kind: ChannelKind,
    /** The inbox's name in Chatwoot. */
    name: z.string(),
    /** The address customers write to: an email address, a phone number or `@bot` name. */
    address: z.string().nullable(),
    /** `connected`; `needs_attention` when the last check found a problem; `paused`. */
    status: z.enum(['connected', 'needs_attention', 'paused']),
    /** What the last check found, in Chatwoot's words. */
    problem: z.string().nullable(),
    /** The AI answers new conversations here. Off until the owner turns it on. */
    aiAnswers: z.boolean(),
    /** The team new conversations go to; null leaves them to routing. */
    defaultTeamId: typeId('team').nullable(),
    /** Conversations started in the last 7 days. */
    conversationsThisWeek: z.int().nonnegative(),
    /** When a conversation or message last came in. */
    lastEventAt: Timestamp.nullable(),
    pausedAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: 'ChannelInbox' });
export type ChannelInbox = z.infer<typeof ChannelInbox>;

export const ChannelInboxList = z
  .object({ items: z.array(ChannelInbox) })
  .meta({ id: 'ChannelInboxList' });
export type ChannelInboxList = z.infer<typeof ChannelInboxList>;

export const UpdateChannelRequest = z
  .object({
    /** Claims a channel that answers for no brand yet; a channel never moves between brands. */
    brandId: typeId('brand').optional(),
    aiAnswers: z.boolean().optional(),
    defaultTeamId: typeId('team').nullable().optional(),
    /** Paused: new conversations are left in Chatwoot; ones already here carry on. */
    paused: z.boolean().optional(),
  })
  .meta({ id: 'UpdateChannelRequest' });
export type UpdateChannelRequest = z.infer<typeof UpdateChannelRequest>;

const brandParams = z.object({
  brandId: z.string().meta({ description: 'Brand ID (brd_…)' }),
});

export const channelRoutes = {
  listChannels: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/channels',
    operationId: 'listChannels',
    summary:
      "The brand's email, WhatsApp and Telegram channels, and those of its Chatwoot account that answer for no brand yet (integrations.manage)",
    tags: ['Channels'],
    auth: 'staff_session',
    params: brandParams,
    success: { status: 200, description: 'Channels', schema: ChannelInboxList },
  },
  findChannels: {
    method: 'post',
    path: '/v1/admin/brands/{brandId}/channels/find',
    operationId: 'findChannels',
    summary:
      "Looks for inboxes made in the brand's Chatwoot account since the last check (integrations.manage)",
    tags: ['Channels'],
    auth: 'staff_session',
    params: brandParams,
    success: { status: 200, description: 'Channels', schema: ChannelInboxList },
  },
  updateChannel: {
    method: 'put',
    path: '/v1/admin/channels/{channelId}',
    operationId: 'updateChannel',
    summary:
      'Turns the AI on or off for a channel, sets its team, pauses it or claims it for a brand (integrations.manage)',
    tags: ['Channels'],
    auth: 'staff_session',
    params: z.object({ channelId: z.string().meta({ description: 'Channel ID (inb_…)' }) }),
    body: UpdateChannelRequest,
    success: { status: 200, description: 'The channel', schema: ChannelInbox },
  },
} as const satisfies Record<string, RouteDef>;

// ------------------------------------------------------------------ email (D13)

const server = {
  address: z.string().trim().min(1).max(255),
  port: z.int().min(1).max(65_535),
  login: z.string().trim().min(1).max(320),
};
const password = z.string().min(1).max(500);

/** Incoming mail: Chatwoot reads the mailbox over IMAP. */
export const ImapSettings = z.object({ ...server, ssl: z.boolean() });
/** Outgoing mail: replies are sent from the same address over SMTP. */
export const SmtpSettings = z.object({ ...server, security: z.enum(['starttls', 'tls', 'none']) });

/** A mailbox's settings as Studio shows them back: never a password. */
export const EmailChannelSettings = z
  .object({
    name: z.string().trim().min(1).max(100),
    address: z.email().max(320),
    imap: ImapSettings,
    smtp: SmtpSettings,
  })
  .meta({ id: 'EmailChannelSettings' });
export type EmailChannelSettings = z.infer<typeof EmailChannelSettings>;

/**
 * Connects the brand's own mailbox. The passwords go straight to Chatwoot, which keeps them;
 * Hamnivo stores none. Chatwoot signs in to the mailbox before it accepts it.
 */
export const ConnectEmailRequest = z
  .object({
    name: z.string().trim().min(1).max(100),
    address: z.email().max(320),
    imap: ImapSettings.extend({ password }),
    smtp: SmtpSettings.extend({ password }),
    aiAnswers: z.boolean().default(false),
    defaultTeamId: typeId('team').nullable().default(null),
  })
  .meta({ id: 'ConnectEmailRequest' });
export type ConnectEmailRequest = z.infer<typeof ConnectEmailRequest>;

/** Changes a mailbox's settings; a password is sent only to change it. */
export const UpdateEmailRequest = z
  .object({
    name: z.string().trim().min(1).max(100),
    address: z.email().max(320),
    imap: ImapSettings.extend({ password: password.optional() }),
    smtp: SmtpSettings.extend({ password: password.optional() }),
  })
  .meta({ id: 'UpdateEmailRequest' });
export type UpdateEmailRequest = z.infer<typeof UpdateEmailRequest>;

export interface EmailProvider {
  id: string;
  name: string;
  /** Address domains that suggest this provider. */
  domains: string[];
  imap: { address: string; port: number; ssl: boolean } | null;
  smtp: { address: string; port: number; security: 'starttls' | 'tls' | 'none' } | null;
  /** Where to make the app password the provider asks for instead of the account password. */
  appPasswordUrl: string | null;
  /** False: the provider no longer accepts passwords over IMAP (Microsoft); connect it in Chatwoot. */
  passwordsWork: boolean;
}

/** Common providers' mail servers, for "Find my settings". `custom` fills nothing. */
export const EMAIL_PROVIDERS: readonly EmailProvider[] = [
  {
    id: 'gmail',
    name: 'Gmail / Google Workspace',
    domains: ['gmail.com', 'googlemail.com'],
    imap: { address: 'imap.gmail.com', port: 993, ssl: true },
    smtp: { address: 'smtp.gmail.com', port: 587, security: 'starttls' },
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    passwordsWork: true,
  },
  {
    id: 'zoho',
    name: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    imap: { address: 'imap.zoho.com', port: 993, ssl: true },
    smtp: { address: 'smtp.zoho.com', port: 465, security: 'tls' },
    appPasswordUrl: 'https://accounts.zoho.com/home#security/app_password',
    passwordsWork: true,
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    domains: ['yahoo.com', 'ymail.com'],
    imap: { address: 'imap.mail.yahoo.com', port: 993, ssl: true },
    smtp: { address: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
    appPasswordUrl: 'https://login.yahoo.com/account/security/app-passwords',
    passwordsWork: true,
  },
  {
    id: 'fastmail',
    name: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    imap: { address: 'imap.fastmail.com', port: 993, ssl: true },
    smtp: { address: 'smtp.fastmail.com', port: 465, security: 'tls' },
    appPasswordUrl: 'https://app.fastmail.com/settings/security/apps',
    passwordsWork: true,
  },
  {
    id: 'microsoft',
    name: 'Outlook / Microsoft 365',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    imap: null,
    smtp: null,
    appPasswordUrl: null,
    passwordsWork: false,
  },
  {
    id: 'custom',
    name: 'Another provider',
    domains: [],
    imap: null,
    smtp: null,
    appPasswordUrl: null,
    passwordsWork: true,
  },
];

const channelParams = z.object({
  channelId: z.string().meta({ description: 'Channel ID (inb_…)' }),
});

export const emailChannelRoutes = {
  connectEmail: {
    method: 'post',
    path: '/v1/admin/brands/{brandId}/channels/email',
    operationId: 'connectEmail',
    summary:
      "Connects the brand's mailbox (IMAP and SMTP) through Chatwoot, which keeps the passwords (integrations.manage)",
    tags: ['Channels'],
    auth: 'staff_session',
    params: brandParams,
    body: ConnectEmailRequest,
    success: { status: 201, description: 'The channel', schema: ChannelInbox },
  },
  getEmailSettings: {
    method: 'get',
    path: '/v1/admin/channels/{channelId}/email',
    operationId: 'getEmailSettings',
    summary: "A mailbox's settings as Chatwoot has them, without passwords (integrations.manage)",
    tags: ['Channels'],
    auth: 'staff_session',
    params: channelParams,
    success: { status: 200, description: 'Settings', schema: EmailChannelSettings },
  },
  updateEmailSettings: {
    method: 'put',
    path: '/v1/admin/channels/{channelId}/email',
    operationId: 'updateEmailSettings',
    summary: "Changes a mailbox's settings; passwords only when sent (integrations.manage)",
    tags: ['Channels'],
    auth: 'staff_session',
    params: channelParams,
    body: UpdateEmailRequest,
    success: { status: 200, description: 'The channel', schema: ChannelInbox },
  },
} as const satisfies Record<string, RouteDef>;

// ------------------------------------------------------------------ WhatsApp and Telegram (D14)

const answering = {
  aiAnswers: z.boolean().default(false),
  defaultTeamId: typeId('team').nullable().default(null),
};

/**
 * Connects a WhatsApp Business number on Meta's Cloud API. The access token goes straight to
 * Chatwoot, which checks it with Meta and keeps it; Hamnivo stores none.
 */
export const ConnectWhatsappRequest = z
  .object({
    name: z.string().trim().min(1).max(100),
    /** International format: `+` and the country code, then the number. */
    phoneNumber: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/),
    phoneNumberId: z
      .string()
      .trim()
      .regex(/^\d{5,30}$/),
    businessAccountId: z
      .string()
      .trim()
      .regex(/^\d{5,30}$/),
    accessToken: z.string().trim().min(20).max(1000),
    ...answering,
  })
  .meta({ id: 'ConnectWhatsappRequest' });
export type ConnectWhatsappRequest = z.infer<typeof ConnectWhatsappRequest>;

/** What to paste into Meta's webhook set-up for a WhatsApp channel. */
export const WhatsappSetup = z
  .object({
    callbackUrl: z.url(),
    /** Chatwoot's verify token; null until Chatwoot reports it. */
    verifyToken: z.string().nullable(),
  })
  .meta({ id: 'WhatsappSetup' });
export type WhatsappSetup = z.infer<typeof WhatsappSetup>;

export const ConnectedWhatsapp = z
  .object({ channel: ChannelInbox, setup: WhatsappSetup })
  .meta({ id: 'ConnectedWhatsapp' });
export type ConnectedWhatsapp = z.infer<typeof ConnectedWhatsapp>;

/** Connects a Telegram bot made with @BotFather; Chatwoot checks the token and keeps it. */
export const ConnectTelegramRequest = z
  .object({
    name: z.string().trim().min(1).max(100),
    botToken: z
      .string()
      .trim()
      .regex(/^\d{3,15}:[\w-]{20,100}$/),
    ...answering,
  })
  .meta({ id: 'ConnectTelegramRequest' });
export type ConnectTelegramRequest = z.infer<typeof ConnectTelegramRequest>;

export const messagingChannelRoutes = {
  connectWhatsapp: {
    method: 'post',
    path: '/v1/admin/brands/{brandId}/channels/whatsapp',
    operationId: 'connectWhatsapp',
    summary:
      'Connects a WhatsApp Business number (Cloud API) through Chatwoot, which keeps the access token (integrations.manage)',
    tags: ['Channels'],
    auth: 'staff_session',
    params: brandParams,
    body: ConnectWhatsappRequest,
    success: {
      status: 201,
      description: 'The channel and its Meta set-up',
      schema: ConnectedWhatsapp,
    },
  },
  getWhatsappSetup: {
    method: 'get',
    path: '/v1/admin/channels/{channelId}/whatsapp',
    operationId: 'getWhatsappSetup',
    summary:
      "The callback address and verify token for Meta's webhook set-up (integrations.manage)",
    tags: ['Channels'],
    auth: 'staff_session',
    params: channelParams,
    success: { status: 200, description: 'Set-up', schema: WhatsappSetup },
  },
  connectTelegram: {
    method: 'post',
    path: '/v1/admin/brands/{brandId}/channels/telegram',
    operationId: 'connectTelegram',
    summary:
      'Connects a Telegram bot through Chatwoot, which keeps the bot token (integrations.manage)',
    tags: ['Channels'],
    auth: 'staff_session',
    params: brandParams,
    body: ConnectTelegramRequest,
    success: { status: 201, description: 'The channel', schema: ChannelInbox },
  },
} as const satisfies Record<string, RouteDef>;
