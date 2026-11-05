import { z } from 'zod';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';
import { SourcePart } from './parts.js';
import { StaffMessageResponse } from './staff-conversations.js';

/**
 * AI drafts awaiting review (HNV-09-05, G03): in assist mode the AI writes a reply to each customer
 * message for people to approve, edit or reject. It is never sent on its own, and it cites only
 * public knowledge, so whatever it says can be shown to the customer. A draft goes stale when the
 * customer writes again, the conversation changes hands (a claim from the queue keeps it), a person
 * answers by hand, a newer draft replaces it or the conversation is resolved.
 */

export const AiDraftState = z.enum(['pending', 'approved', 'edited', 'rejected', 'superseded']);
export type AiDraftState = z.infer<typeof AiDraftState>;

export const AiDraftSupersededReason = z.enum([
  'customer_wrote',
  'owner_changed',
  'answered',
  'replaced',
  'resolved',
]);
export type AiDraftSupersededReason = z.infer<typeof AiDraftSupersededReason>;

export const AiDraftRejectReason = z.enum([
  'inaccurate',
  'incomplete',
  'wrong_tone',
  'not_needed',
  'other',
]);
export type AiDraftRejectReason = z.infer<typeof AiDraftRejectReason>;

export const AiDraft = z
  .object({
    id: typeId('aiDraft'),
    /** The run that wrote it (see Runs); sending it records this as the suggestion. */
    runId: typeId('run'),
    state: AiDraftState,
    supersededReason: AiDraftSupersededReason.nullable(),
    text: z.string(),
    sources: z.array(SourcePart),
    language: z.string().nullable(),
    agentName: z.string(),
    createdAt: Timestamp,
    /** When it stopped being pending, whatever ended it. */
    decidedAt: Timestamp.nullable(),
    /** Who approved, edited or rejected it; null while pending or when it went stale. */
    decidedBy: z.object({ staffMemberId: typeId('staff'), displayName: z.string() }).nullable(),
    rejectReason: AiDraftRejectReason.nullable(),
  })
  .meta({ id: 'AiDraft' });
export type AiDraft = z.infer<typeof AiDraft>;

/** The draft waiting for review, if any, and the one before it, to say how it ended. */
export const AiDraftList = z
  .object({ pending: AiDraft.nullable(), latest: AiDraft.nullable() })
  .meta({ id: 'AiDraftList' });
export type AiDraftList = z.infer<typeof AiDraftList>;

export const ApproveAiDraftRequest = z
  .object({
    /** Repeating a request replays it; it is also the sent message's `clientMessageId`. */
    clientRequestId: z.uuid(),
    /** The text as edited; leave it out to send the draft as it is. */
    text: z.string().trim().min(1).max(10_000).optional(),
    /** The ownership epoch the reviewer saw (ADR 0003). */
    expectedEpoch: z.int().nonnegative(),
  })
  .meta({ id: 'ApproveAiDraftRequest' });

export const RejectAiDraftRequest = z
  .object({
    clientRequestId: z.uuid(),
    reason: AiDraftRejectReason,
    note: z.string().trim().max(500).optional(),
  })
  .meta({ id: 'RejectAiDraftRequest' });

export const AiDraftDecisionResult = z
  .object({
    draft: AiDraft,
    /** The reply sent as the reviewer; absent for a rejection. */
    message: StaffMessageResponse.optional(),
  })
  .meta({ id: 'AiDraftDecisionResult' });
export type AiDraftDecisionResult = z.infer<typeof AiDraftDecisionResult>;
