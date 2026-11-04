import type { CustomerConversation, Message, PublicWidgetEvent } from '@hamnivo/contracts';

/**
 * What the website hears about the chat through `Hamnivo.on(...)` (blueprint §10). Only the facts
 * a page needs to react (a chat started, a person was asked for, a reply came), never what was
 * written: the conversation stays inside the chat's frame.
 */
export interface ChatSnapshot {
  conversationId: string | null;
  status: CustomerConversation['status'] | null;
  /** The newest message from the brand's side (AI, person or system), if any. */
  lastReplyId: string | null;
  lastReplyFrom: 'ai' | 'person' | 'system' | null;
  error: string | null;
}

export interface HostEvent {
  event: PublicWidgetEvent;
  payload: Record<string, string | number | boolean | null>;
}

const fromOf = (kind: Message['sender']['kind']): ChatSnapshot['lastReplyFrom'] =>
  kind === 'customer'
    ? null
    : kind === 'human_agent' || kind === 'guest'
      ? 'person'
      : kind === 'system'
        ? 'system'
        : 'ai';

/** The snapshot of the chat's state that events are worked out from. */
export function snapshotOf(state: {
  conversation: CustomerConversation | null;
  messages: readonly Message[];
  phase: string;
  error: string | null;
}): ChatSnapshot {
  const reply = state.messages.findLast((m) => m.sender.kind !== 'customer');
  return {
    conversationId: state.conversation?.id ?? null,
    status: state.conversation?.status ?? null,
    lastReplyId: reply?.id ?? null,
    lastReplyFrom: reply ? fromOf(reply.sender.kind) : null,
    error: state.phase === 'error' ? (state.error ?? 'unknown') : null,
  };
}

/**
 * The events between two snapshots. `known` holds conversations the visitor already had, so
 * opening an old one is not a new chat. A changed conversation reports no status change or reply:
 * it was opened, not changed.
 */
export function eventsBetween(
  before: ChatSnapshot,
  after: ChatSnapshot,
  known: ReadonlySet<string>,
): HostEvent[] {
  const events: HostEvent[] = [];
  const id = after.conversationId;
  if (after.error && after.error !== before.error) {
    events.push({ event: 'error', payload: { code: after.error } });
  }
  if (!id) return events;
  if (id !== before.conversationId) {
    if (!known.has(id))
      events.push({ event: 'conversation.started', payload: { conversationId: id } });
    return events;
  }
  if (after.status !== before.status) {
    if (after.status === 'waiting_for_person')
      events.push({ event: 'handoff.requested', payload: { conversationId: id } });
    if (after.status === 'with_person')
      events.push({ event: 'handoff.accepted', payload: { conversationId: id } });
    if (after.status === 'resolved')
      events.push({ event: 'conversation.resolved', payload: { conversationId: id } });
  }
  if (after.lastReplyId && after.lastReplyId !== before.lastReplyId && after.lastReplyFrom) {
    events.push({ event: 'message', payload: { conversationId: id, from: after.lastReplyFrom } });
  }
  return events;
}
