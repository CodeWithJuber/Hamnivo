/**
 * AI drafts awaiting review (HNV-09-05, G03): the rules for deciding on a draft an assist-mode
 * agent wrote. A draft answers one customer message for whoever handles the conversation; it is
 * only worth sending while nothing has moved since.
 */

export type AiDraftOwnerMode = 'AI_ACTIVE' | 'WAITING_HUMAN' | 'HUMAN_ACTIVE' | 'PAUSED';

/** Why a person cannot approve, edit or reject a draft now. */
export type AiDraftRefusal =
  /** It was decided already, or went stale (the customer wrote again, among others). */
  | 'not_pending'
  | 'resolved'
  /** The AI answers the conversation itself. */
  | 'ai_owns'
  /** A colleague handles the conversation; only they reply. */
  | 'colleague_owns';

export interface AiDraftFacts {
  /** Stale drafts are marked as soon as the conversation moves on, in the same transaction. */
  state: 'pending' | 'approved' | 'edited' | 'rejected' | 'superseded';
}

export interface AiDraftConversation {
  ownerMode: AiDraftOwnerMode;
  ownerStaffId: string | null;
  status: 'open' | 'pending' | 'snoozed' | 'resolved';
}

/** Null when `me` may decide on the draft now; otherwise why not. */
export function checkAiDraftDecision(
  draft: AiDraftFacts,
  conversation: AiDraftConversation,
  me: string,
): AiDraftRefusal | null {
  if (draft.state !== 'pending') return 'not_pending';
  if (conversation.status === 'resolved') return 'resolved';
  if (conversation.ownerMode === 'AI_ACTIVE') return 'ai_owns';
  if (conversation.ownerMode === 'HUMAN_ACTIVE' && conversation.ownerStaffId !== me) {
    return 'colleague_owns';
  }
  return null;
}

/** Sent as written (spacing aside) is an approval; anything else is an edit. */
export function draftOutcome(original: string, sent: string | undefined): 'approved' | 'edited' {
  if (sent === undefined) return 'approved';
  return sent.trim() === original.trim() ? 'approved' : 'edited';
}

/**
 * A pending draft stays when a person picks the conversation up from the queue: it was written for
 * whoever would take it. Any other change of hands (to a colleague, back to the AI, back to the
 * queue) means it was written for someone else, so it goes stale.
 */
export function draftSurvivesOwnerChange(from: AiDraftOwnerMode, to: AiDraftOwnerMode): boolean {
  return (from === 'WAITING_HUMAN' || from === 'PAUSED') && to === 'HUMAN_ACTIVE';
}
