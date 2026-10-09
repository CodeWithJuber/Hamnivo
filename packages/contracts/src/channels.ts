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
