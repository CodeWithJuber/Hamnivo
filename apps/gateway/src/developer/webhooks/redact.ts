/**
 * The payload preview in the delivery log (webhooks.read, also for API keys): the event as sent,
 * with what people wrote and who they are replaced. The receiver got the full event; the log only
 * needs its shape, ids and states to explain a delivery.
 */

const REDACTED = '[redacted]';

/** Keys whose string values are customer or staff content, names or addresses. */
const PERSONAL_KEYS = new Set([
  'text',
  'fallbackText',
  'excerpt',
  'summary',
  'title',
  'caption',
  'alt',
  'name',
  'displayName',
  'roleLabel',
  'avatarUrl',
  'url',
  'email',
  'phone',
  'note',
  'comment',
  'deliverySummary',
]);

const MAX_DEPTH = 12;

function redactValue(value: unknown, key: string | null, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        redactValue(v, k, depth + 1),
      ]),
    );
  }
  if (typeof value === 'string' && key !== null && PERSONAL_KEYS.has(key)) return REDACTED;
  return value;
}

/** The redacted preview of a stored event body, or null when the body is gone or unreadable. */
export function payloadPreview(body: string | null): Record<string, unknown> | null {
  if (body === null) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return redactValue(parsed, null, 0) as Record<string, unknown>;
  } catch {
    return null;
  }
}
