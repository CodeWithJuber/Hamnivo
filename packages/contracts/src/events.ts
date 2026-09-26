import { z } from 'zod';
import { Lane, Timestamp } from './common.js';
import { DeliveryState, Message } from './conversations.js';
import { Participant } from './participants.js';

/**
 * Canonical event envelope (blueprint §9) shared by SSE, long-poll, webhooks and the SDK. The
 * envelope does not make its contents authorized: customer streams never include staff-lane events.
 */
export const SCHEMA_VERSION = '1.0';

export const EventType = z.enum([
  'message.created',
  'message.updated',
  'message.redacted',
  'message.delta',
  'message.draft_discarded',
  'delivery.updated',
  'conversation.updated',
  'conversation.resolved',
  'conversation.reopened',
  'participant.joined',
  'participant.left',
  'typing',
  'activity',
  'handoff.requested',
  'handoff.accepted',
  'action.updated',
  'approval.requested',
  'approval.updated',
]);
export type EventType = z.infer<typeof EventType>;

/** Transient events stream to live subscribers only; they have no journal sequence and are never replayed. */
export const TRANSIENT_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'message.delta',
  'typing',
  'activity',
]);

const envelopeBase = {
  schemaVersion: z.string().regex(/^1\.\d+$/),
  eventId: z.string(),
  conversationId: z.string(),
  /** Journal sequence (gapless per conversation); null for transient events. */
  sequence: z.int().nonnegative().nullable(),
  occurredAt: Timestamp,
  correlationId: z.string().nullable(),
  lane: Lane,
};

const ev = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ ...envelopeBase, type: z.literal(type), data });

export const MessageCreatedEvent = ev('message.created', z.object({ message: Message }));
export const MessageUpdatedEvent = ev('message.updated', z.object({ message: Message }));
export const MessageRedactedEvent = ev(
  'message.redacted',
  z.object({ messageId: z.string(), reason: z.enum(['deleted', 'retention', 'privacy_request']) }),
);
export const MessageDeltaEvent = ev(
  'message.delta',
  z.object({
    runId: z.string(),
    draftId: z.string(),
    index: z.int().nonnegative(),
    textDelta: z.string(),
  }),
);
export const DraftDiscardedEvent = ev(
  'message.draft_discarded',
  z.object({
    runId: z.string(),
    draftId: z.string(),
    reason: z.enum(['takeover', 'cancelled', 'failed', 'superseded']),
  }),
);
export const DeliveryUpdatedEvent = ev(
  'delivery.updated',
  z.object({ messageId: z.string(), state: DeliveryState }),
);
export const ConversationUpdatedEvent = ev(
  'conversation.updated',
  z.object({
    status: z.enum(['open', 'waiting_for_person', 'with_person', 'resolved']),
    responder: z.enum(['ai', 'person', 'none']),
  }),
);
export const ConversationResolvedEvent = ev(
  'conversation.resolved',
  z.object({ canReopen: z.boolean() }),
);
export const ConversationReopenedEvent = ev('conversation.reopened', z.object({}));
export const ParticipantJoinedEvent = ev(
  'participant.joined',
  z.object({ participant: Participant }),
);
export const ParticipantLeftEvent = ev('participant.left', z.object({ participantId: z.string() }));
export const TypingEvent = ev(
  'typing',
  z.object({ participantId: z.string(), displayName: z.string(), typing: z.boolean() }),
);
/** Real activity ("Checking order", "Waiting for approval") — no fabricated progress or private reasoning. */
export const ActivityEvent = ev(
  'activity',
  z.object({
    runId: z.string(),
    label: z.string().max(120),
    state: z.enum(['started', 'finished']),
  }),
);
export const HandoffRequestedEvent = ev(
  'handoff.requested',
  z.object({
    handoffId: z.string(),
    availability: z.enum(['person_available', 'queued', 'offline']),
  }),
);
export const HandoffAcceptedEvent = ev(
  'handoff.accepted',
  z.object({ handoffId: z.string(), participant: Participant }),
);
export const ActionUpdatedEvent = ev(
  'action.updated',
  z.object({
    actionId: z.string(),
    outcome: z.enum([
      'requested',
      'awaiting_approval',
      'approved',
      'executing',
      'completed',
      'failed',
      'unknown',
      'cancelled',
    ]),
    summary: z.string().max(300),
  }),
);
export const ApprovalRequestedEvent = ev(
  'approval.requested',
  z.object({ approvalId: z.string(), messageId: z.string(), expiresAt: Timestamp }),
);
export const ApprovalUpdatedEvent = ev(
  'approval.updated',
  z.object({
    approvalId: z.string(),
    status: z.enum(['approved', 'denied', 'expired', 'superseded']),
  }),
);

export const HamnivoEvent = z
  .discriminatedUnion('type', [
    MessageCreatedEvent,
    MessageUpdatedEvent,
    MessageRedactedEvent,
    MessageDeltaEvent,
    DraftDiscardedEvent,
    DeliveryUpdatedEvent,
    ConversationUpdatedEvent,
    ConversationResolvedEvent,
    ConversationReopenedEvent,
    ParticipantJoinedEvent,
    ParticipantLeftEvent,
    TypingEvent,
    ActivityEvent,
    HandoffRequestedEvent,
    HandoffAcceptedEvent,
    ActionUpdatedEvent,
    ApprovalRequestedEvent,
    ApprovalUpdatedEvent,
  ])
  .meta({ id: 'HamnivoEvent' });
export type HamnivoEvent = z.infer<typeof HamnivoEvent>;
export type HamnivoEventOf<T extends EventType> = Extract<HamnivoEvent, { type: T }>;

export type ParsedEvent =
  | { kind: 'event'; event: HamnivoEvent }
  /** A newer server sent an event type this client does not know; it may be safely ignored. */
  | { kind: 'unknown'; type: string; sequence: number | null }
  | { kind: 'invalid'; reason: string };

/** Lenient parser for clients: unknown event types are surfaced, not thrown (E04). */
export function parseEvent(input: unknown): ParsedEvent {
  const parsed = HamnivoEvent.safeParse(input);
  if (parsed.success) return { kind: 'event', event: parsed.data };
  const record =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if (typeof record.type === 'string' && !EventType.safeParse(record.type).success) {
    const sequence = typeof record.sequence === 'number' ? record.sequence : null;
    return { kind: 'unknown', type: record.type, sequence };
  }
  return {
    kind: 'invalid',
    reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

/** Stream control frames sent alongside events on SSE/long-poll. */
export const StreamControl = z.discriminatedUnion('control', [
  z.object({ control: z.literal('heartbeat'), at: Timestamp }),
  z.object({
    control: z.literal('resync_required'),
    reason: z.enum(['cursor_expired', 'gap_detected', 'access_changed']),
  }),
  z.object({ control: z.literal('auth_expired') }),
]);
export type StreamControl = z.infer<typeof StreamControl>;
