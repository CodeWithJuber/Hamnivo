import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthorityEvent } from '@hamnivo/domain';
import { toConversation, toMessage } from './mapping.js';

export interface SignatureInput {
  secret: string;
  /** `X-Chatwoot-Timestamp` (Unix seconds). */
  timestamp: string | undefined;
  /** `X-Chatwoot-Signature` (`sha256=<hex>`). */
  signature: string | undefined;
  /** The exact request body bytes. */
  rawBody: string | Buffer;
  now?: number;
  toleranceSeconds?: number;
}

export type SignatureResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'stale' | 'mismatch' };

/**
 * Verifies a Chatwoot webhook: `sha256=HMAC-SHA256(secret, "{timestamp}.{body}")` within ±5 minutes.
 * Account, API-inbox and agent-bot webhooks each have their own secret.
 */
export function verifyChatwootSignature(input: SignatureInput): SignatureResult {
  if (!input.timestamp || !input.signature?.startsWith('sha256='))
    return { ok: false, reason: 'missing' };
  const ts = Number(input.timestamp);
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > (input.toleranceSeconds ?? 300)) {
    return { ok: false, reason: 'stale' };
  }
  const body = typeof input.rawBody === 'string' ? Buffer.from(input.rawBody) : input.rawBody;
  const expected = createHmac('sha256', input.secret)
    .update(`${input.timestamp}.`)
    .update(body)
    .digest();
  const given = Buffer.from(input.signature.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? { ok: true }
    : { ok: false, reason: 'mismatch' };
}

type Json = Record<string, unknown>;

/** Normalizes a verified webhook payload into an AuthorityEvent (unknown events are kept, not dropped). */
export function parseChatwootEvent(payload: unknown): AuthorityEvent {
  const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Json;
  const account = (p.account ?? {}) as Json;
  const accountRef = account.id === undefined ? null : String(account.id);
  const event = String(p.event ?? '');
  const acc = accountRef ?? '';
  switch (event) {
    case 'message_created':
    case 'message_updated': {
      const conversation = (p.conversation ?? {}) as Json;
      return {
        type: event === 'message_created' ? 'message.created' : 'message.updated',
        accountRef: acc,
        message: toMessage(p, String(conversation.display_id ?? conversation.id ?? '')),
        ...(conversation.inbox_id !== undefined
          ? {
              conversation: toConversation({
                ...conversation,
                id: conversation.display_id ?? conversation.id,
              }),
            }
          : {}),
      };
    }
    case 'conversation_created':
    case 'conversation_updated':
    case 'conversation_status_changed':
      return {
        type:
          event === 'conversation_created'
            ? 'conversation.created'
            : event === 'conversation_updated'
              ? 'conversation.updated'
              : 'conversation.status_changed',
        accountRef: acc,
        conversation: toConversation(p),
      };
    case 'conversation_typing_on':
    case 'conversation_typing_off': {
      const conversation = (p.conversation ?? {}) as Json;
      const user = (p.user ?? {}) as Json;
      return {
        type: 'conversation.typing',
        accountRef: acc,
        conversationRef: String(conversation.display_id ?? conversation.id ?? ''),
        on: event === 'conversation_typing_on',
        userRef: user.id === undefined ? null : String(user.id),
      };
    }
    case 'contact_created':
    case 'contact_updated':
      return {
        type: event === 'contact_created' ? 'contact.created' : 'contact.updated',
        accountRef: acc,
        contactRef: String(p.id ?? ''),
        identifier: typeof p.identifier === 'string' ? p.identifier : null,
      };
    default:
      return { type: 'unknown', accountRef, name: event || 'missing' };
  }
}

/** JSON with sorted keys, so equal payloads hash equally whatever the key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Json)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const digest = (value: unknown) =>
  createHash('sha256').update(stable(value)).digest('base64url').slice(0, 22);

/**
 * Deduplication key for the integration inbox. Chatwoot sends the same change to the account,
 * inbox and bot webhooks (and the reconciler may find it again), so the key identifies the change,
 * not the delivery: a message by id and content, a conversation by its state. The bot webhook
 * serializes `updated_at` with a different float precision, so versions compare in milliseconds.
 */
export function dedupeKey(event: AuthorityEvent, deliveryId?: string | null): string {
  switch (event.type) {
    case 'message.created':
    case 'message.updated': {
      const m = event.message;
      return `msg:${m.ref}:${digest([m.text, m.private, m.contentAttributes, m.attachments.map((a) => a.ref)])}`;
    }
    case 'conversation.created':
    case 'conversation.updated':
    case 'conversation.status_changed': {
      const c = event.conversation;
      const state = digest([c.status, c.owner, c.teamRef, c.labels, c.attributes]);
      return `conv:${c.ref}:${Math.round(c.version * 1000)}:${state}`;
    }
    default:
      return `delivery:${deliveryId ?? 'none'}:${event.type}`;
  }
}

const SECRET_KEYS = new Set(['pubsub_token', 'access_token', 'hmac_token', 'secret']);

/**
 * Removes credentials from a webhook payload before it is stored: contact-inbox source ids (they
 * grant customer-API access to the conversation) and pubsub or access tokens. Hamnivo's own message
 * keys (`source_id` on messages) are kept.
 */
export function redactChatwootPayload<T>(payload: T): T {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const out: Json = {};
    for (const [key, inner] of Object.entries(value as Json)) {
      if (SECRET_KEYS.has(key)) continue;
      if (key === 'contact_inbox' && inner && typeof inner === 'object') {
        const { source_id: _sourceId, ...rest } = inner as Json;
        out[key] = walk(rest);
        continue;
      }
      out[key] = walk(inner);
    }
    return out;
  };
  return walk(payload) as T;
}
