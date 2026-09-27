import type { DeliveryState, Message, Sender } from '@hamnivo/contracts';
import type { OwnerMode } from '@hamnivo/db/schema';
import type { AuthorityMessage } from '@hamnivo/domain';

export type CustomerStatus = 'open' | 'waiting_for_person' | 'with_person' | 'resolved';
export type Responder = 'ai' | 'person' | 'none';

/** What the customer is told about a conversation: who answers, never staff-only details. */
export function customerView(
  mode: OwnerMode,
  authorityStatus: string,
): { status: CustomerStatus; responder: Responder } {
  if (authorityStatus === 'resolved') return { status: 'resolved', responder: 'none' };
  switch (mode) {
    case 'AI_ACTIVE':
      return { status: 'open', responder: 'ai' };
    case 'WAITING_HUMAN':
      return { status: 'waiting_for_person', responder: 'none' };
    case 'HUMAN_ACTIVE':
      return { status: 'with_person', responder: 'person' };
    case 'PAUSED':
      return { status: 'open', responder: 'none' };
  }
}

/** AI and people are always labelled as what they are (W04, U09). */
export function senderOf(message: AuthorityMessage): Sender {
  const sender = message.sender;
  switch (sender.kind) {
    case 'contact':
      return { kind: 'customer', displayName: sender.name?.trim() || 'Customer' };
    case 'bot':
      return {
        kind: 'ai_agent',
        displayName: sender.name?.trim() || 'AI assistant',
        roleLabel: 'AI assistant',
      };
    case 'user':
      return {
        kind: 'human_agent',
        displayName: sender.name?.trim() || 'Support agent',
        roleLabel: 'Support agent',
      };
    default:
      return { kind: 'system', displayName: 'System' };
  }
}

/** Authority message → the public Message contract (customer or staff lane). */
export function contractMessage(input: {
  message: AuthorityMessage;
  id: string;
  conversationId: string;
  sequence: number | null;
  clientMessageId: string | null;
  delivery: DeliveryState | null;
}): Message {
  const text = input.message.text?.trim();
  return {
    id: input.id,
    conversationId: input.conversationId,
    sequence: input.sequence,
    sender: senderOf(input.message),
    visibility: input.message.private ? 'internal' : 'public',
    parts: [
      {
        type: 'text',
        text: text || (input.message.attachments.length > 0 ? '[attachment]' : '[empty message]'),
        format: 'plain',
      },
    ],
    createdAt: input.message.createdAt.toISOString(),
    clientMessageId: input.clientMessageId,
    delivery: input.delivery,
    language: null,
  };
}

/** Which journal lane carries an authority message, if any (activity stays out of both). */
export function laneOf(message: AuthorityMessage): 'customer' | 'staff' | null {
  if (message.direction === 'activity') return null;
  return message.private ? 'staff' : 'customer';
}
