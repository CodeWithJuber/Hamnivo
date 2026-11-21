import { z } from 'zod';
import { Card } from './cards.js';
import { Timestamp } from './common.js';
import { REACTIONS } from './constants.js';

/** Message parts (blueprint §9). Unknown future parts degrade to a safe fallback, never crash. */

export const TextPart = z
  .object({
    type: z.literal('text'),
    text: z.string().min(1).max(10_000),
    /** Markdown is sanitized on render; raw HTML is never executed. */
    format: z.enum(['plain', 'markdown']).default('plain'),
  })
  .meta({ id: 'TextPart' });

/** Why a file was refused (W09). Any failure to scan is a refusal, never a pass. */
export const AttachmentRejection = z.enum([
  'type_not_allowed',
  'too_large',
  'too_many',
  'malware_detected',
  'scan_unavailable',
  'unreadable',
]);
export type AttachmentRejection = z.infer<typeof AttachmentRejection>;

export const AttachmentPart = z
  .object({
    type: z.literal('attachment'),
    /**
     * The file's id (upl_…). Downloads go through the gateway, which checks the caller may see
     * the conversation it was sent in; the browser never receives an authority URL.
     */
    uploadId: z.string(),
    name: z.string().max(255),
    /** Detected from the file's bytes, never from its name or the declared type. */
    mimeType: z.string().max(127),
    sizeBytes: z.int().nonnegative(),
    /** Files are unavailable until scanning succeeds; scan failure denies access (W09). */
    status: z.enum(['quarantined', 'scanning', 'available', 'rejected']),
    rejectionReason: AttachmentRejection.optional(),
    /** Short-lived, authorization-checked download URL; present only when status is available. */
    url: z.url().optional(),
  })
  .meta({ id: 'AttachmentPart' });

/**
 * A shared place (W24). Clients show the label and coordinates as text, with a link to a public
 * map; they never embed a third-party map or treat the label as markup.
 */
export const LocationPart = z
  .object({
    type: z.literal('location'),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    /** A place name or address as the sender gave it (plain text). */
    label: z.string().max(300).nullable(),
  })
  .meta({ id: 'LocationPart' });

/** A shared contact card (W24): plain values only; links are built by the client (tel:, mailto:). */
export const ContactPart = z
  .object({
    type: z.literal('contact'),
    name: z.string().min(1).max(120),
    phone: z
      .string()
      .regex(/^\+?[0-9][0-9 ()\-.]{2,31}$/, 'Expected a phone number')
      .nullable(),
    email: z.email().max(254).nullable(),
  })
  .meta({ id: 'ContactPart' });

/** Reactions a customer can add to a reply (W22). */
export const ReactionEmoji = z.enum(REACTIONS);
export type ReactionEmoji = z.infer<typeof ReactionEmoji>;

/**
 * A reaction to an earlier message (W22). Authorities without reactions (Chatwoot CE) receive it
 * as a short reply that quotes the message, so staff read it as "👍" in reply to that message.
 */
export const ReactionPart = z
  .object({
    type: z.literal('reaction'),
    emoji: ReactionEmoji,
    /** The message reacted to (msg_…). */
    messageId: z.string(),
  })
  .meta({ id: 'ReactionPart' });

export const SourcePart = z
  .object({
    type: z.literal('source'),
    sourceId: z.string(),
    title: z.string().max(300),
    url: z.url().nullable(),
    version: z.string().max(40).nullable(),
    excerpt: z.string().max(600).nullable(),
    /** Evidence freshness is shown, not implied (G06). */
    freshness: z.enum(['current', 'stale', 'expired']),
  })
  .meta({ id: 'SourcePart' });

/**
 * A remembered preference an AI answer relied on (G19). It names the memory, never its value:
 * the customer opens "what we remember" to see or change it. Removed when the memory is deleted.
 */
export const MemoryPart = z
  .object({
    type: z.literal('memory'),
    memoryId: z.string(),
    /** The memory slot, such as `preferred_language`; clients show their own label for it. */
    key: z.string().max(60),
  })
  .meta({ id: 'MemoryPart' });

/**
 * Questions the customer might ask next, offered under the newest AI answer (up to three). The
 * client shows them as choices; picking one sends it as the customer's own message. They are a
 * suggestion, written after the answer was published, and never part of its text.
 */
export const SuggestionsPart = z
  .object({
    type: z.literal('suggestions'),
    items: z.array(z.string().min(1).max(120)).min(1).max(3),
  })
  .meta({ id: 'SuggestionsPart' });

export const CardPart = z
  .object({
    type: z.literal('card'),
    card: Card,
    fallbackText: z.string().min(1).max(2000),
  })
  .meta({ id: 'CardPart' });

export const TaskUpdatePart = z
  .object({
    type: z.literal('task_update'),
    taskId: z.string(),
    title: z.string().max(200),
    status: z.enum(['pending', 'in_progress', 'waiting', 'done', 'blocked', 'cancelled']),
    dueAt: Timestamp.nullable(),
  })
  .meta({ id: 'TaskUpdatePart' });

export const ActionReceiptPart = z
  .object({
    type: z.literal('action_receipt'),
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
    reference: z.string().max(120).nullable(),
    occurredAt: Timestamp,
  })
  .meta({ id: 'ActionReceiptPart' });

export const NoticePart = z
  .object({
    type: z.literal('notice'),
    notice: z.enum([
      'handoff_requested',
      'waiting_for_person',
      'human_joined',
      'human_left',
      'ai_paused',
      'ai_resumed',
      'specialist_joined',
      'resolved',
      'reopened',
      'team_offline',
      'follow_up_scheduled',
      /** The sender deleted this message; its text and files are gone (W23). */
      'message_deleted',
    ]),
    text: z.string().max(300),
  })
  .meta({ id: 'NoticePart' });

/** Produced by `parsePart` for types this client does not understand. */
export const UnknownPart = z
  .object({
    type: z.literal('unknown'),
    originalType: z.string(),
    fallbackText: z.string().nullable(),
  })
  .meta({ id: 'UnknownPart' });

export const KnownPart = z.discriminatedUnion('type', [
  TextPart,
  AttachmentPart,
  SourcePart,
  MemoryPart,
  CardPart,
  TaskUpdatePart,
  ActionReceiptPart,
  NoticePart,
  LocationPart,
  ContactPart,
  ReactionPart,
  SuggestionsPart,
]);
export const MessagePart = z.union([KnownPart, UnknownPart]).meta({ id: 'MessagePart' });
export type MessagePart = z.infer<typeof MessagePart>;
export type KnownPart = z.infer<typeof KnownPart>;

const KNOWN_PART_TYPES = new Set([
  'text',
  'attachment',
  'source',
  'memory',
  'card',
  'task_update',
  'action_receipt',
  'notice',
  'location',
  'contact',
  'reaction',
  'suggestions',
]);

/**
 * Parses one part leniently: known and valid → typed part; anything else → an `unknown` part that
 * keeps a text fallback when the payload offers one. Clients render the fallback instead of failing
 * the whole conversation (forward compatibility, blueprint E04).
 */
export function parsePart(input: unknown): MessagePart {
  const parsed = KnownPart.safeParse(input);
  if (parsed.success) return parsed.data;
  const record =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const originalType = typeof record.type === 'string' ? record.type : 'invalid';
  const fallback =
    typeof record.fallbackText === 'string'
      ? record.fallbackText
      : typeof record.text === 'string' && !KNOWN_PART_TYPES.has(originalType)
        ? record.text
        : null;
  return { type: 'unknown', originalType, fallbackText: fallback?.slice(0, 2000) ?? null };
}

export function parseParts(input: unknown): MessagePart[] {
  return Array.isArray(input) ? input.map(parsePart) : [];
}

function partToPlainText(part: MessagePart): string {
  switch (part.type) {
    case 'text':
    case 'notice':
      return part.text;
    case 'card':
      return part.fallbackText;
    case 'attachment':
      return `[${part.name}]`;
    case 'source':
      return part.url ? `${part.title} (${part.url})` : part.title;
    case 'memory':
      return '';
    case 'task_update':
      return part.title;
    case 'action_receipt':
      return part.summary;
    case 'location': {
      const at = `${part.latitude.toFixed(5)}, ${part.longitude.toFixed(5)}`;
      return part.label ? `${part.label} (${at})` : at;
    }
    case 'contact':
      return [part.name, part.phone, part.email].filter(Boolean).join(', ');
    case 'reaction':
      return part.emoji;
    case 'suggestions':
      // Offers to the customer, not something said in the conversation.
      return '';
    default:
      return part.fallbackText ?? '';
  }
}

/** Plain-text rendering used for previews, notifications and channels without rich rendering. */
export function partsToPlainText(parts: readonly MessagePart[]): string {
  return parts
    .map(partToPlainText)
    .filter((line) => line.length > 0)
    .join('\n');
}
