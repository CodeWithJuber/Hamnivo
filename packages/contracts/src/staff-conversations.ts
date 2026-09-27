import { z } from 'zod';
import { ClientMessageId, Timestamp } from './common.js';
import { CustomerConversationStatus } from './conversations.js';
import { typeId } from './ids.js';

/** Who may speak publicly in a conversation right now (ADR 0003). */
export const OwnerMode = z.enum(['AI_ACTIVE', 'WAITING_HUMAN', 'HUMAN_ACTIVE', 'PAUSED']);
export type OwnerMode = z.infer<typeof OwnerMode>;

/** Staff view of a conversation's control state. Messages stay in the conversation authority. */
export const StaffConversation = z
  .object({
    id: typeId('conversation'),
    brandId: typeId('brand').nullable(),
    ownerMode: OwnerMode,
    /** Increments on every owner change; AI publications carry the epoch they were started under. */
    ownershipEpoch: z.int().nonnegative(),
    owner: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('ai') }),
      z.object({ kind: z.literal('staff'), staffMemberId: typeId('staff') }),
      z.object({ kind: z.literal('external'), displayName: z.string() }),
      z.object({ kind: z.literal('none') }),
    ]),
    customerStatus: CustomerConversationStatus,
    authorityStatus: z.enum(['open', 'pending', 'resolved', 'snoozed']),
    lastActivityAt: Timestamp,
  })
  .meta({ id: 'StaffConversation' });
export type StaffConversation = z.infer<typeof StaffConversation>;

export const TakeoverRequest = z
  .object({
    /** The epoch the caller saw; a stale value returns OWNERSHIP_CHANGED instead of overriding. */
    expectedEpoch: z.int().nonnegative().optional(),
  })
  .meta({ id: 'TakeoverRequest' });

export const StaffMessageRequest = z
  .object({
    clientMessageId: ClientMessageId,
    text: z.string().trim().min(1).max(10_000),
    /** `internal` writes a private note that customers never see. */
    visibility: z.enum(['public', 'internal']).default('public'),
    /**
     * The ownership epoch the sender saw. A public reply is refused (OWNERSHIP_CHANGED) when the
     * owner changed since, so a reply written in a stale view is never sent.
     */
    expectedEpoch: z.int().nonnegative().optional(),
    /** Remove the sender's saved draft for this lane once the message is on its way. */
    clearDraft: z.boolean().default(false),
    /** The AI suggestion this reply started from (recorded for audit; it is still your reply). */
    suggestionId: typeId('run').optional(),
  })
  .meta({ id: 'StaffMessageRequest' });

export const StaffMessageResponse = z
  .object({
    messageId: typeId('message'),
    status: z.enum(['accepted', 'duplicate']),
  })
  .meta({ id: 'StaffMessageResponse' });
