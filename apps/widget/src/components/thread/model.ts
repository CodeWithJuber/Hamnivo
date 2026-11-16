import type { ThreadMessageLike } from '@assistant-ui/react';
import type { OutgoingAttachment, OutgoingMessage } from '@hamnivo/client';
import type { DeliveryState, Message, MessagePart, ReactionEmoji } from '@hamnivo/contracts';
import type { ParticipantKind } from '@hamnivo/ui/components/participant-badge';
import type { Part } from '../../commerce/Cards.js';
import { place } from './grouping.js';

export interface Source {
  id: string;
  title: string;
  url: string | null;
  excerpt: string | null;
  /** Whether the source may have changed since the answer read it (G06). */
  freshness: 'current' | 'stale' | 'expired';
}

export type AttachmentPart = Extract<MessagePart, { type: 'attachment' }>;

/** What a bubble needs of a message, carried in the thread message's `metadata.custom`. */
export interface Custom {
  kind: ParticipantKind;
  name: string;
  role: string;
  /** The sender's picture, when the gateway has one. */
  avatarUrl?: string | null;
  state: 'accepted' | OutgoingMessage['state'];
  clientMessageId?: string;
  /** Knowledge an AI answer cites, numbered as in its text (G06). */
  sources?: Source[];
  /** A card (quote, receipt…) from Hamnivo's records, rendered instead of text. */
  card?: Part;
  /** Memories an AI answer used (G19): shown as memories, never as something said now. */
  memories?: string[];
  /** The confirmed message's id and time (for deleting and reacting). */
  messageId?: string;
  createdAt?: string;
  delivery?: DeliveryState | null;
  /** Files the message carries (W09), and those of a message still being sent. */
  files?: AttachmentPart[];
  pendingFiles?: OutgoingAttachment[];
  /** Places, contacts and parts this widget does not know (W24). */
  extras?: MessagePart[];
  /** Words of parts the chat has no picture for (a task's update, a notice): shown as text. */
  notes?: string[];
  deleted?: boolean;
  /** A reaction whose message is not on screen: it keeps a line of its own (W22). */
  reaction?: { emoji: ReactionEmoji };
  /** The visitor's reactions to this message, shown on it. */
  reactions?: ReactionEmoji[];
  /** The first reply the visitor had not seen when the conversation opened (W05). */
  firstUnread?: boolean;
  /** The visitor's newest confirmed message, which shows "Sent" or "Read" (W06). */
  lastMine?: boolean;
  /** The API's code for a failed send, to explain it. */
  errorCode?: string;
  /** First and last of its sender's turn: the first says who is writing. */
  first: boolean;
  last: boolean;
  /** The day that starts with this message (`YYYY-MM-DD`), for the line above it. */
  day: string | null;
  /** Questions the assistant offers next; only on the newest answer. */
  suggestions?: string[];
  /** The newest message on screen: what can be done with it is always in view. */
  latest?: boolean;
}

export const textOf = (m: Message) =>
  m.parts
    .map((p) => (p.type === 'text' ? p.text : p.type === 'card' ? p.fallbackText : ''))
    .join('\n')
    .trim();

/** Words of a message for announcements, naming what was shared. */
export const spokenOf = (m: Message, file: (name: string) => string) =>
  [textOf(m), ...m.parts.flatMap((p) => (p.type === 'attachment' ? [file(p.name)] : []))]
    .filter(Boolean)
    .join(' ');

const cardOf = (m: Message): Part | undefined => m.parts.find((p): p is Part => p.type === 'card');
const memoriesOf = (m: Message): string[] =>
  m.parts.flatMap((p) => (p.type === 'memory' ? [p.key] : []));
const sourcesOf = (m: Message): Source[] =>
  m.parts.flatMap((p) =>
    p.type === 'source'
      ? [
          {
            id: p.sourceId,
            title: p.title,
            url: p.url,
            excerpt: p.excerpt,
            freshness: p.freshness,
          },
        ]
      : [],
  );
const filesOf = (m: Message): AttachmentPart[] =>
  m.parts.filter((p): p is AttachmentPart => p.type === 'attachment');
const extrasOf = (m: Message): MessagePart[] =>
  m.parts.filter((p) => p.type === 'location' || p.type === 'contact' || p.type === 'unknown');
const notesOf = (m: Message): string[] =>
  m.parts.flatMap((p) =>
    p.type === 'notice' && p.notice !== 'message_deleted'
      ? [p.text]
      : p.type === 'task_update'
        ? [p.title]
        : p.type === 'action_receipt'
          ? [p.summary]
          : [],
  );
export const deletedOf = (m: Message) =>
  m.parts.some((p) => p.type === 'notice' && p.notice === 'message_deleted');
export const reactionOf = (m: Message) => {
  const part = m.parts.find((p) => p.type === 'reaction');
  return part?.type === 'reaction' ? { emoji: part.emoji, messageId: part.messageId } : undefined;
};
/**
 * Questions the assistant offers after an answer. The part is newer than this widget's contract
 * types, so it is read by its shape: a list of short texts, at most four.
 */
const suggestionsOf = (m: Message): string[] =>
  m.parts.flatMap((p) => {
    const part = p as { type: string; items?: unknown };
    return part.type === 'suggestions' && Array.isArray(part.items)
      ? part.items.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      : [];
  });

/** The visitor's newest message a reply is owed for: not a reaction, not a deleted message. */
export const lastQuestion = (messages: readonly Message[]) =>
  messages.findLast((m) => m.sender.kind === 'customer' && !deletedOf(m) && !reactionOf(m));

const built = new WeakMap<object, { signature: string; message: ThreadMessageLike }>();

/** The same thread message for the same input, so a bubble that did not change is not redrawn. */
function once(source: object, signature: string, build: () => ThreadMessageLike) {
  const known = built.get(source);
  if (known?.signature === signature) return known.message;
  const message = build();
  built.set(source, { signature, message });
  return message;
}

/**
 * The conversation as the thread shows it: confirmed messages in order, then the visitor's
 * messages still on their way. A reaction to a message on screen is shown on that message; one
 * whose message is not loaded keeps its own line. Each message knows whether it starts or ends
 * its sender's turn, and whether a day starts with it.
 */
export function toThread(
  messages: readonly Message[],
  pending: readonly OutgoingMessage[],
  you: string,
  firstUnreadId: string | null,
): ThreadMessageLike[] {
  const lastMine = lastQuestion(messages)?.id;
  const onScreen = new Set(messages.map((m) => m.id));
  const reactions = new Map<string, ReactionEmoji[]>();
  const shown = messages.filter((m) => {
    const reaction = reactionOf(m);
    if (!reaction || deletedOf(m) || !onScreen.has(reaction.messageId)) return true;
    const given = reactions.get(reaction.messageId) ?? [];
    if (!given.includes(reaction.emoji)) given.push(reaction.emoji);
    reactions.set(reaction.messageId, given);
    return false;
  });
  const newest = pending.length === 0 ? shown.at(-1) : undefined;
  const placed = place([
    ...shown.map((m) => ({
      author: m.sender.id ?? `${m.sender.kind}:${m.sender.displayName}`,
      at: Date.parse(m.createdAt),
      alone: m.sender.kind === 'system' || cardOf(m) !== undefined || reactionOf(m) !== undefined,
    })),
    ...pending.map(() => ({ author: 'me', at: null })),
  ]);
  const confirmed = shown.map((m, index): ThreadMessageLike => {
    const spot = placed[index] ?? { first: true, last: true, day: null };
    const given = reactions.get(m.id) ?? [];
    const suggestions =
      m === newest && m.sender.kind === 'ai_agent' ? suggestionsOf(m).slice(0, 4) : [];
    const signature = [
      you,
      spot.first,
      spot.last,
      spot.day,
      m.id === firstUnreadId,
      m.id === lastMine,
      given.join(''),
      suggestions.length,
      m === newest,
    ].join('|');
    return once(m, signature, () => {
      const kind: ParticipantKind =
        m.sender.kind === 'ai_agent' ? 'ai_primary' : (m.sender.kind as ParticipantKind);
      const deleted = deletedOf(m);
      const card = cardOf(m);
      const reaction = reactionOf(m);
      return {
        id: m.id,
        role:
          m.sender.kind === 'customer'
            ? 'user'
            : m.sender.kind === 'system'
              ? 'system'
              : 'assistant',
        content: [{ type: 'text', text: deleted ? '' : textOf(m) }],
        createdAt: new Date(m.createdAt),
        metadata: {
          custom: {
            kind,
            name: m.sender.kind === 'customer' ? you : m.sender.displayName,
            role: m.sender.roleLabel ?? '',
            avatarUrl: m.sender.avatarUrl ?? null,
            state: 'accepted',
            sources: sourcesOf(m),
            ...(card ? { card } : {}),
            memories: memoriesOf(m),
            messageId: m.id,
            createdAt: m.createdAt,
            delivery: m.delivery,
            files: deleted ? [] : filesOf(m),
            extras: deleted ? [] : extrasOf(m),
            notes: deleted ? [] : notesOf(m),
            deleted,
            ...(reaction ? { reaction: { emoji: reaction.emoji } } : {}),
            reactions: given,
            firstUnread: m.id === firstUnreadId,
            lastMine: m.id === lastMine,
            first: spot.first,
            last: spot.last,
            day: spot.day,
            suggestions,
            latest: m === newest,
          } satisfies Custom,
        },
      };
    });
  });
  const unsent = pending.map((p, index): ThreadMessageLike => {
    const spot = placed[shown.length + index] ?? { first: true, last: true, day: null };
    const signature = [you, p.state, p.errorCode ?? '', p.text, spot.first, spot.last].join('|');
    return once(p, signature, () => ({
      id: `pending-${p.clientMessageId}`,
      role: 'user',
      content: [{ type: 'text', text: p.text }],
      createdAt: new Date(p.createdAt),
      metadata: {
        custom: {
          kind: 'customer',
          name: you,
          role: '',
          state: p.state,
          clientMessageId: p.clientMessageId,
          pendingFiles: p.attachments ?? [],
          ...(p.errorCode ? { errorCode: p.errorCode } : {}),
          first: spot.first,
          last: spot.last,
          day: null,
        } satisfies Custom,
      },
    }));
  });
  return [...confirmed, ...unsent];
}
