/** Why a conversation the AI could have held went to people instead. */
export type AiHandoffReason =
  | 'no_agent'
  | 'assist_mode'
  | 'ai_stopped'
  | 'ai_unavailable'
  | 'ai_blocked'
  | 'customer_request'
  | 'ai_escalated';

/** Internal notes for staff (the staff lane), in the operator's language. */
export const HANDOFF_NOTES: Record<AiHandoffReason, string> = {
  no_agent: 'No AI agent is published for this brand, so a person needs to answer.',
  assist_mode:
    "This brand's AI agent only suggests replies as internal notes. A person answers the customer.",
  ai_stopped: 'AI replies are stopped by a kill switch. Please answer the customer.',
  ai_unavailable: 'The AI could not answer because the model was unavailable. Please answer.',
  ai_blocked: 'The AI reply was held back because it broke the honesty rules. Please answer.',
  customer_request: 'The customer asked to talk to a person, so the AI stepped back.',
  ai_escalated: 'The escalation check passed this conversation to people. Please answer.',
};

/**
 * Notes for hand-offs a live check decided (staff lane). The conversation's ownership reason stays
 * one of the reasons above; the note says which check and why.
 */
export const CHECK_HANDOFF_NOTES = {
  unsupported_answer:
    'The AI reply was held back: the knowledge it cited did not support it. Please answer.',
  unbacked_claim:
    'The AI reply was held back: it said or promised a payment, refund or order change that ' +
    'Hamnivo has no receipt or commitment for. Please answer.',
  guard: 'The message guard passed this conversation to people. Please answer.',
  urgent:
    'URGENT: the message guard found that someone may be at risk. The AI sent safety wording ' +
    'and stepped back. Please answer now.',
} as const;

/** Why the message guard passed a conversation to people, one sentence per reason. */
export const GUARD_NOTES = {
  self_harm: 'The customer may be thinking of hurting themselves.',
  in_danger: 'The customer says someone may be in danger now.',
  threat: 'The customer threatens to hurt someone or damage something.',
  abuse: 'The customer insults or abuses the team or the assistant.',
} as const;

/** Why the escalation check (J04) passed a conversation to people, one sentence per reason. */
export const ESCALATION_NOTES = {
  wants_person: 'The customer seems to ask for a person.',
  safety: 'The customer describes a risk to health or safety.',
  legal_threat: 'The customer threatens legal action.',
  complaint: 'The customer wants to make a complaint.',
  unresolved_and_frustrated: 'The customer is frustrated that a problem is still not solved.',
} as const;
