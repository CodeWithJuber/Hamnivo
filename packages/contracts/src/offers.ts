import { z } from 'zod';
import { Timestamp } from './common.js';
import { LanguageSlice } from './decisions.js';
import { typeId } from './ids.js';
import { InboxConversation } from './inbox.js';

/**
 * Hand-off offered to one person at a time (HNV-10-03, HNV-10-06, H02). When a team works in
 * `offer` mode, a conversation handed to it is offered to the best person who is online, under
 * their limit and speaks the customer's language. They accept it (it becomes theirs) or decline it
 * with a reason; no answer in time or a decline moves it to the next person, and after three it
 * waits in the team's queue. An offer is not ownership: colleagues can still claim it.
 */

export const OfferDeclineReason = z.enum(['at_capacity', 'not_my_area', 'going_offline', 'other']);
export type OfferDeclineReason = z.infer<typeof OfferDeclineReason>;

/** The conversations offered to me now, each with its offer (`offer` is set). */
export const OfferList = z.object({ items: z.array(InboxConversation) }).meta({ id: 'OfferList' });
export type OfferList = z.infer<typeof OfferList>;

export const DeclineOfferRequest = z
  .object({
    reason: OfferDeclineReason,
    note: z.string().trim().max(500).optional(),
  })
  .meta({ id: 'DeclineOfferRequest' });

export const OfferDecisionResult = z
  .object({
    conversationId: typeId('conversation'),
    state: z.enum(['accepted', 'declined']),
  })
  .meta({ id: 'OfferDecisionResult' });
export type OfferDecisionResult = z.infer<typeof OfferDecisionResult>;

/** How one person takes offered conversations: the languages they answer in and their limit. */
export const RoutingProfile = z
  .object({
    staffMemberId: typeId('staff'),
    displayName: z.string(),
    languages: z.array(LanguageSlice),
    /** Null: no limit. */
    maxOpenChats: z.int().min(1).max(50).nullable(),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: 'RoutingProfile' });
export type RoutingProfile = z.infer<typeof RoutingProfile>;

export const RoutingProfileList = z
  .object({ items: z.array(RoutingProfile) })
  .meta({ id: 'RoutingProfileList' });
export type RoutingProfileList = z.infer<typeof RoutingProfileList>;

export const SetRoutingProfileRequest = z
  .object({
    languages: z.array(LanguageSlice).max(12),
    maxOpenChats: z.int().min(1).max(50).nullable(),
  })
  .meta({ id: 'SetRoutingProfileRequest' });
