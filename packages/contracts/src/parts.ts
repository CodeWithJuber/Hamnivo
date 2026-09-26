import { z } from 'zod';
import { Card } from './cards.js';
import { Timestamp } from './common.js';

/** Message parts (blueprint §9). Unknown future parts degrade to a safe fallback, never crash. */

export const TextPart = z
  .object({
    type: z.literal('text'),
    text: z.string().min(1).max(10_000),
    /** Markdown is sanitized on render; raw HTML is never executed. */
    format: z.enum(['plain', 'markdown']).default('plain'),
  })
  .meta({ id: 'TextPart' });

export const AttachmentPart = z
  .object({
    type: z.literal('attachment'),
    uploadId: z.string(),
    name: z.string().max(255),
    mimeType: z.string().max(127),
    sizeBytes: z.int().nonnegative(),
    /** Files are unavailable until scanning succeeds; scan failure denies access (W09). */
    status: z.enum(['quarantined', 'scanning', 'available', 'rejected']),
    rejectionReason: z
      .enum(['type_not_allowed', 'too_large', 'malware_detected', 'scan_unavailable', 'unreadable'])
      .optional(),
    /** Short-lived, authorization-checked download URL; present only when status is available. */
    url: z.url().optional(),
  })
  .meta({ id: 'AttachmentPart' });

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
  CardPart,
  TaskUpdatePart,
  ActionReceiptPart,
  NoticePart,
]);
export const MessagePart = z.union([KnownPart, UnknownPart]).meta({ id: 'MessagePart' });
export type MessagePart = z.infer<typeof MessagePart>;
export type KnownPart = z.infer<typeof KnownPart>;

const KNOWN_PART_TYPES = new Set([
  'text',
  'attachment',
  'source',
  'card',
  'task_update',
  'action_receipt',
  'notice',
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
    case 'task_update':
      return part.title;
    case 'action_receipt':
      return part.summary;
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
