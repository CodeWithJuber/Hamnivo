import { z } from 'zod';
import { Timestamp } from './common.js';
import type { RouteDef } from './routes.js';

/**
 * Blocking visitors (H20). A block covers the customer behind a chat, the browser they used and,
 * for a customer the website signed in, that account everywhere. No IP address is stored, so a
 * visitor who clears their browser comes back unblocked; the brand accepts that. A blocked
 * visitor is told only that chat is not available: never that they were blocked.
 */

export const BlockDuration = z.enum(['day', 'week', 'month', 'always']);
export type BlockDuration = z.infer<typeof BlockDuration>;

export const BlockVisitorRequest = z
  .object({
    /** Why, for the team (never shown to the visitor). */
    reason: z.string().trim().min(1).max(500),
    duration: BlockDuration,
    /** Also close the chat it came from. */
    closeChat: z.boolean().default(true),
  })
  .meta({ id: 'BlockVisitorRequest' });

export const VisitorBlock = z
  .object({
    id: z.string(),
    brandId: z.string(),
    /** How staff know the visitor: their name, or "Visitor" and a short code. */
    who: z.string(),
    signedIn: z.boolean(),
    customerId: z.string().nullable(),
    visitorId: z.string().nullable(),
    /** The chat it came from, while it exists. */
    conversationId: z.string().nullable(),
    reason: z.string(),
    createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    createdAt: Timestamp,
    /** Null: until someone lifts it. */
    expiresAt: Timestamp.nullable(),
    liftedAt: Timestamp.nullable(),
    liftedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    active: z.boolean(),
  })
  .meta({ id: 'VisitorBlock' });
export type VisitorBlock = z.infer<typeof VisitorBlock>;

export const VisitorBlockList = z
  .object({ items: z.array(VisitorBlock) })
  .meta({ id: 'VisitorBlockList' });
export type VisitorBlockList = z.infer<typeof VisitorBlockList>;

export const ListVisitorBlocksQuery = z.object({
  brandId: z.string().optional(),
  /** `active` (the default) or every block of the last 90 days. */
  status: z.enum(['active', 'all']).default('active'),
});

const conversationParams = z.object({
  conversationId: z.string().meta({ description: 'Conversation ID (conv_…)' }),
});

export const blockRoutes = {
  blockConversationVisitor: {
    method: 'post',
    path: '/v1/inbox/conversations/{conversationId}/block',
    operationId: 'blockConversationVisitor',
    summary:
      'Block the customer of this chat, their browser and their signed-in account; optionally close the chat (visitors.block)',
    tags: ['Inbox'],
    auth: 'staff_session',
    params: conversationParams,
    body: BlockVisitorRequest,
    success: { status: 201, description: 'The block', schema: VisitorBlock },
  },
  blockLiveVisitor: {
    method: 'post',
    path: '/v1/visitors/{visitorId}/block',
    operationId: 'blockLiveVisitor',
    summary: 'Block a visitor on the website, and the customer they chat as (visitors.block)',
    tags: ['Visitors'],
    auth: 'staff_session',
    params: z.object({ visitorId: z.string().meta({ description: 'Visitor ID (vis_…)' }) }),
    body: BlockVisitorRequest.omit({ closeChat: true }),
    success: { status: 201, description: 'The block', schema: VisitorBlock },
  },
  listVisitorBlocks: {
    method: 'get',
    path: '/v1/visitors/blocks',
    operationId: 'listVisitorBlocks',
    summary: 'Blocked visitors, newest first (visitors.block)',
    tags: ['Visitors'],
    auth: 'staff_session',
    query: ListVisitorBlocksQuery,
    success: { status: 200, description: 'Blocks', schema: VisitorBlockList },
  },
  liftVisitorBlock: {
    method: 'delete',
    path: '/v1/visitors/blocks/{blockId}',
    operationId: 'liftVisitorBlock',
    summary: 'Unblock: the visitor can chat again at once (visitors.block)',
    tags: ['Visitors'],
    auth: 'staff_session',
    params: z.object({ blockId: z.string().meta({ description: 'Block ID (blk_…)' }) }),
    success: { status: 200, description: 'The lifted block', schema: VisitorBlock },
  },
} as const satisfies Record<string, RouteDef>;
