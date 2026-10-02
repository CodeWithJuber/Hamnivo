/** Why a conversation the AI could have held went to people instead. */
export type AiHandoffReason =
  | 'no_agent'
  | 'assist_mode'
  | 'ai_stopped'
  | 'ai_unavailable'
  | 'ai_blocked'
  | 'customer_request';

/** Internal notes for staff (the staff lane), in the operator's language. */
export const HANDOFF_NOTES: Record<AiHandoffReason, string> = {
  no_agent: 'No AI agent is published for this brand, so a person needs to answer.',
  assist_mode:
    "This brand's AI agent only suggests replies as internal notes. A person answers the customer.",
  ai_stopped: 'AI replies are stopped by a kill switch. Please answer the customer.',
  ai_unavailable: 'The AI could not answer because the model was unavailable. Please answer.',
  ai_blocked: 'The AI reply was held back because it broke the honesty rules. Please answer.',
  customer_request: 'The customer asked to talk to a person, so the AI stepped back.',
};

/**
 * Notes for hand-offs a live check decided (staff lane). The conversation's ownership reason stays
 * one of the reasons above; the note says which check and why.
 */
export const CHECK_HANDOFF_NOTES = {
  unsupported_answer:
    'The AI reply was held back: the knowledge it cited did not support it. Please answer.',
} as const;
