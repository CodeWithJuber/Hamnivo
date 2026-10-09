import type { InboundGuardReason } from '@hamnivo/domain';

/** Why a conversation the AI could have held went to people instead. */
export type AiHandoffReason =
  | 'no_agent'
  | 'assist_mode'
  | 'ai_stopped'
  | 'ai_unavailable'
  | 'ai_blocked'
  | 'ai_limit'
  | 'customer_request'
  | 'ai_escalated'
  | 'channel_ai_off';

/** Internal notes for staff (the staff lane), in the operator's language. */
export const HANDOFF_NOTES: Record<AiHandoffReason, string> = {
  no_agent: 'No AI agent is published for this brand, so a person needs to answer.',
  assist_mode:
    "This brand's AI agent only suggests replies as internal notes. A person answers the customer.",
  ai_stopped: 'AI replies are stopped by a kill switch. Please answer the customer.',
  ai_unavailable: 'The AI could not answer because the model was unavailable. Please answer.',
  ai_blocked: 'The AI reply was held back because it broke the honesty rules. Please answer.',
  ai_limit:
    "The workspace's AI replies for this billing period are used up (plan limit or budget). Please answer.",
  customer_request: 'The customer asked to talk to a person, so the AI stepped back.',
  ai_escalated: 'The escalation check passed this conversation to people. Please answer.',
  channel_ai_off: 'The AI does not answer on this channel, so a person needs to answer.',
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
} as const;

/** Why the message guard passed a conversation to people, one sentence per reason. */
export const GUARD_NOTES = {
  self_harm: 'The customer may be thinking of hurting themselves.',
  in_danger: 'The customer says someone may be in danger now.',
  threat: 'The customer threatens to hurt someone or damage something.',
  abuse: 'The customer insults or abuses the team or the assistant.',
} as const;

/**
 * What the urgent note (staff lane) says came of the safety wording for someone at risk. It comes
 * before the reasons: a hand-off packet is cut at a fixed length, so a reason may be lost, but not
 * whether wording was sent.
 */
const URGENT_OUTCOMES = {
  /** The AI had the conversation: it sent the wording and stepped back. */
  ai_sent: 'The AI sent safety wording and stepped back. Please answer now.',
  /** Nobody had it: Hamnivo sent the wording at once. */
  sent: 'Hamnivo sent safety wording to the customer. Please answer now.',
  /** A person has it: the wording is theirs to send, or follows (see `urgentNote`). */
  person: 'Please answer now.',
  /** One went out in the last 24 hours, so none goes out now. */
  held: 'No safety wording was sent: one was sent to this customer in the last 24 hours. Please answer now.',
  changed_hands:
    'No safety wording was sent: the conversation changed hands first. Please answer now.',
  ai_again:
    'No safety wording was sent: the AI has this conversation again. Please look at it now.',
  no_bot:
    'No safety wording was sent: no bot is set up to speak for this brand. Please answer now.',
} as const;
export type UrgentOutcome = keyof typeof URGENT_OUTCOMES;

/**
 * The urgent note for people when someone may be at risk (message guard): the finding, what came
 * of the safety wording, why, and, when a person has the conversation and the wording is still
 * to come, the words themselves, so they can send them first.
 */
export function urgentNote(
  outcome: UrgentOutcome,
  reasons: readonly InboundGuardReason[],
  wording?: { text: string; waitMinutes: number },
): string {
  return [
    'URGENT: the message guard found that someone may be at risk.',
    URGENT_OUTCOMES[outcome],
    ...reasons.map((reason) => GUARD_NOTES[reason]),
    ...(wording
      ? [
          `You can send this message yourself: “${wording.text}” If nobody has replied in ` +
            `${wording.waitMinutes} ${wording.waitMinutes === 1 ? 'minute' : 'minutes'}, Hamnivo ` +
            'will send that message itself.',
        ]
      : []),
  ].join(' ');
}

/** Why the escalation check (J04) passed a conversation to people, one sentence per reason. */
export const ESCALATION_NOTES = {
  wants_person: 'The customer seems to ask for a person.',
  safety: 'The customer describes a risk to health or safety.',
  legal_threat: 'The customer threatens legal action.',
  complaint: 'The customer wants to make a complaint.',
  unresolved_and_frustrated: 'The customer is frustrated that a problem is still not solved.',
} as const;
