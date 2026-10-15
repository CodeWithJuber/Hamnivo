import type { InboxAlertKind } from '@hamnivo/contracts';
import { concernsStaff } from './unread.js';

/** What the alert decision needs to know about one conversation. */
export interface AlertChat {
  id: string;
  authorityStatus: string;
  ownerMode: string;
  ownerStaffId: string | null;
  ownerReason: string | null;
  ownerChangedAt: Date | null;
  createdAt: Date;
  customerName: string | null;
  /** When the chat went past its reply-time target (H12); null while it is within it. */
  slaBreachedAt?: Date | null;
}

/** A customer message (the newest one of a chat is enough to alert). */
export interface AlertMessage {
  conversationId: string;
  messageId: string;
  text: string | null;
  at: Date;
}

export interface DerivedAlert {
  /** The same alert always has the same key, so a stream never sends it twice. */
  key: string;
  kind: InboxAlertKind;
  conversationId: string;
  customerName: string;
  preview: string | null;
  at: Date;
}

/** Why a chat was given to a person by someone else (their own takeover is not an alert). */
const ASSIGNED_BY_OTHERS = new Set(['staff_assign', 'authority_assignment']);

const waiting = (chat: AlertChat) =>
  chat.ownerMode === 'WAITING_HUMAN' || chat.ownerMode === 'PAUSED';

/** The start of a message for an alert: one line, at most 200 characters. */
export function previewOf(text: string | null | undefined): string | null {
  const flat = text?.replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, 200) : null;
}

/** What a stream remembers about a message it has looked at. */
export const messageKey = (message: Pick<AlertMessage, 'conversationId' | 'messageId'>) =>
  `${message.conversationId}:message:${message.messageId}`;

export interface AlertDecision {
  alerts: DerivedAlert[];
  /**
   * The newest message of each chat that was looked at, alerted or not. A stream keeps these so a
   * message that was already shown (for example as the words of "a chat is waiting") does not
   * alert a second time when the next look overlaps the last one.
   */
  looked: string[];
}

/**
 * Which alerts a staff member should get for chats that changed since `since`:
 * - `chat_waiting`: a chat came to wait for a person (a new chat, a hand-off from the AI, a chat
 *   put back in the queue);
 * - `assigned`: a chat was assigned or transferred to this person by someone else;
 * - `customer_message`: the customer wrote in a chat that is theirs or waiting for a person;
 * - `sla_overdue`: a chat that is theirs or waiting for a person went past its reply-time target
 *   (H12), once per deadline. It comes first: an overdue chat is the most urgent thing to hear.
 * One chat gets one alert per batch, the most important first: a chat that just started waiting or
 * was just assigned already says a customer is there, so its message adds no second alert.
 * Only open chats alert, and only chats that concern the person. `seen` holds the keys a stream
 * has already handled, so looks that overlap never alert twice.
 */
export function deriveAlerts(input: {
  me: string;
  since: Date;
  chats: AlertChat[];
  messages: AlertMessage[];
  seen?: ReadonlySet<string>;
}): AlertDecision {
  const since = input.since.getTime();
  const seen = input.seen ?? new Set<string>();
  /** The newest customer message of each chat, of any age: the words an alert shows. */
  const latest = new Map<string, AlertMessage>();
  for (const message of input.messages) {
    const known = latest.get(message.conversationId);
    if (!known || known.at.getTime() <= message.at.getTime()) {
      latest.set(message.conversationId, message);
    }
  }

  const alerts: DerivedAlert[] = [];
  const looked: string[] = [];
  for (const chat of input.chats) {
    if (chat.authorityStatus !== 'open' && chat.authorityStatus !== 'pending') continue;
    if (!concernsStaff(chat, input.me)) continue;
    const name = chat.customerName?.trim() || 'Visitor';
    const message = latest.get(chat.id);
    if (message) looked.push(messageKey(message));
    const breachedAt = chat.slaBreachedAt ?? null;
    const overdueKey = breachedAt ? `${chat.id}:sla:${breachedAt.getTime()}` : null;
    if (breachedAt && overdueKey && breachedAt.getTime() > since && !seen.has(overdueKey)) {
      alerts.push({
        key: overdueKey,
        kind: 'sla_overdue',
        conversationId: chat.id,
        customerName: name,
        preview: previewOf(message?.text),
        at: breachedAt,
      });
      continue;
    }
    const changedAt = chat.ownerChangedAt ?? chat.createdAt;
    const waitingKey = `${chat.id}:waiting:${changedAt.getTime()}`;
    if (waiting(chat) && changedAt.getTime() > since && !seen.has(waitingKey)) {
      alerts.push({
        key: waitingKey,
        kind: 'chat_waiting',
        conversationId: chat.id,
        customerName: name,
        preview: previewOf(message?.text),
        at: changedAt,
      });
      continue;
    }
    const assignedKey = `${chat.id}:assigned:${chat.ownerChangedAt?.getTime()}`;
    if (
      chat.ownerMode === 'HUMAN_ACTIVE' &&
      chat.ownerChangedAt &&
      chat.ownerChangedAt.getTime() > since &&
      chat.ownerReason &&
      ASSIGNED_BY_OTHERS.has(chat.ownerReason) &&
      !seen.has(assignedKey)
    ) {
      alerts.push({
        key: assignedKey,
        kind: 'assigned',
        conversationId: chat.id,
        customerName: name,
        preview: previewOf(message?.text),
        at: chat.ownerChangedAt,
      });
      continue;
    }
    // A message alerts only when it is new: after the last look, and not shown before. Older ones
    // only give an alert its words.
    if (message && message.at.getTime() > since && !seen.has(messageKey(message))) {
      alerts.push({
        key: messageKey(message),
        kind: 'customer_message',
        conversationId: chat.id,
        customerName: name,
        preview: previewOf(message.text),
        at: message.at,
      });
    }
  }
  return { alerts, looked };
}
