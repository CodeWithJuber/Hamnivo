/**
 * Verifying Hamnivo webhooks (Standard Webhooks, symmetric `v1` signatures). Every request carries
 * `webhook-id` (the event id, the same on every retry and replay), `webhook-timestamp` (seconds
 * since the epoch, when this attempt was sent) and `webhook-signature` (one or more
 * `v1,<base64 HMAC-SHA256>`, space-separated: two while a secret is being rotated). The HMAC is
 * over `{id}.{timestamp}.{body}`, with the bytes of the secret after its `whsec_` prefix.
 *
 * Web Crypto only, like the rest of this package, so it also runs in edge runtimes.
 */

/** The body of a Hamnivo webhook (see the `webhooks` section of the OpenAPI document). */
export interface HamnivoWebhookEvent<Data = Record<string, unknown>> {
  /** `evt_…`: deduplicate on this; retries and replays repeat it. */
  id: string;
  /** e.g. `conversation.created`, `message.created`, `order.updated`. */
  type: string;
  /** When it happened (RFC 3339). */
  timestamp: string;
  schemaVersion: string;
  tenantId: string;
  data: Data;
}

export type WebhookErrorCode =
  | 'missing_header'
  | 'invalid_timestamp'
  | 'timestamp_out_of_range'
  | 'invalid_signature'
  | 'duplicate'
  | 'invalid_payload';

/**
 * A request that is not a valid Hamnivo webhook. Answer it with 400 (or 401), except
 * `duplicate`: that event was already accepted, so answer 2xx and do nothing.
 */
export class HamnivoWebhookError extends Error {
  override name = 'HamnivoWebhookError';
  constructor(
    readonly code: WebhookErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Remembers webhook ids already accepted, so a request replayed within the tolerance window is
 * refused. Use a shared store (Redis `SET NX EX`, a database table with a unique key) when the
 * receiver runs on more than one process.
 */
export interface WebhookReplayStore {
  /** Records `id` for `ttlSeconds`; false when it is already recorded. Must be atomic. */
  claim(id: string, ttlSeconds: number): boolean | Promise<boolean>;
  /** Forgets `id`, so a retry is processed (call it when handling the event failed). */
  release(id: string): void | Promise<void>;
}

/** An in-memory replay store for a single process (entries expire; at most `maxEntries`). */
export class MemoryReplayStore implements WebhookReplayStore {
  private readonly seen = new Map<string, number>();

  constructor(private readonly options: { maxEntries?: number; now?: () => number } = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  claim(id: string, ttlSeconds: number): boolean {
    const now = this.now();
    for (const [key, expires] of this.seen) {
      if (expires > now) break;
      this.seen.delete(key);
    }
    const expires = this.seen.get(id);
    if (expires !== undefined && expires > now) return false;
    this.seen.delete(id);
    this.seen.set(id, now + ttlSeconds * 1000);
    const max = this.options.maxEntries ?? 100_000;
    while (this.seen.size > max) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  release(id: string): void {
    this.seen.delete(id);
  }
}

export type WebhookHeaders =
  | Headers
  | Record<string, string | readonly string[] | undefined>
  | Map<string, string>;

export interface VerifyWebhookOptions {
  /** The endpoint's `whsec_…` signing secret, or both secrets while rotating. */
  secret: string | readonly string[];
  /** How far `webhook-timestamp` may be from now, in seconds (default 300). */
  toleranceSeconds?: number;
  /** Refuses an id seen before (see WebhookReplayStore). */
  replayStore?: WebhookReplayStore;
  /** The current time (tests). */
  now?: () => Date;
}

const encoder = new TextEncoder();
const PREFIX = 'whsec_';

function header(headers: WebhookHeaders, name: string): string | null {
  let value: string | readonly string[] | null | undefined;
  if (typeof (headers as Headers).get === 'function') {
    value = (headers as Headers | Map<string, string>).get(name);
  } else {
    const record = headers as Record<string, string | readonly string[] | undefined>;
    const key = Object.keys(record).find((k) => k.toLowerCase() === name);
    value = key === undefined ? undefined : record[key];
  }
  if (Array.isArray(value)) value = value[0];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function base64Bytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function hmacKey(secret: string): Promise<HmacKey> {
  const encoded = secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret;
  const bytes = base64Bytes(encoded);
  if (!bytes || bytes.length === 0) {
    throw new TypeError('The webhook secret is not a whsec_… value (base64 after the prefix).');
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

function signedContent(id: string, timestamp: string, body: string | Uint8Array): Uint8Array {
  const head = encoder.encode(`${id}.${timestamp}.`);
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;
  const content = new Uint8Array(head.length + bytes.length);
  content.set(head);
  content.set(bytes, head.length);
  return content;
}

/** `v1,<signature>` of a body, as Hamnivo sends it (for tests of your receiver). */
export async function signWebhook(
  secret: string,
  id: string,
  timestamp: number,
  body: string | Uint8Array,
): Promise<string> {
  const key = await hmacKey(secret);
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, signedContent(id, String(timestamp), body)),
  );
  let binary = '';
  for (const byte of signature) binary += String.fromCharCode(byte);
  return `v1,${btoa(binary)}`;
}

/**
 * Checks a webhook request and returns its event. Pass the body exactly as received (the raw
 * bytes or text, before any JSON parsing), and the request headers.
 *
 * Throws HamnivoWebhookError when a header is missing, the timestamp is outside the tolerance
 * (a replay of an old request), no signature matches, or (with a replay store) the id was
 * already accepted.
 */
export async function verifyWebhook<Data = Record<string, unknown>>(
  body: string | Uint8Array,
  headers: WebhookHeaders,
  options: VerifyWebhookOptions,
): Promise<HamnivoWebhookEvent<Data>> {
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signatures = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signatures) {
    throw new HamnivoWebhookError(
      'missing_header',
      'The webhook-id, webhook-timestamp and webhook-signature headers are required.',
    );
  }
  if (!/^\d{1,12}$/.test(timestamp)) {
    throw new HamnivoWebhookError('invalid_timestamp', 'webhook-timestamp is not a number.');
  }
  const tolerance = options.toleranceSeconds ?? 300;
  const now = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  if (Math.abs(now - Number(timestamp)) > tolerance) {
    throw new HamnivoWebhookError(
      'timestamp_out_of_range',
      'webhook-timestamp is too far from the current time.',
    );
  }

  const content = signedContent(id, timestamp, body);
  const secrets = typeof options.secret === 'string' ? [options.secret] : options.secret;
  if (secrets.length === 0) throw new TypeError('Pass the endpoint signing secret.');
  const keys = await Promise.all(secrets.map(hmacKey));
  let valid = false;
  for (const candidate of signatures.split(' ')) {
    const [version, value] = candidate.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const bytes = base64Bytes(value);
    if (bytes?.length !== 32) continue;
    for (const key of keys) {
      // crypto.subtle.verify compares in constant time.
      if (await crypto.subtle.verify('HMAC', key, bytes, content)) valid = true;
    }
  }
  if (!valid) {
    throw new HamnivoWebhookError('invalid_signature', 'No webhook signature matches the secret.');
  }

  let event: HamnivoWebhookEvent<Data>;
  try {
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    event = JSON.parse(text) as HamnivoWebhookEvent<Data>;
  } catch {
    throw new HamnivoWebhookError('invalid_payload', 'The webhook body is not JSON.');
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new HamnivoWebhookError('invalid_payload', 'The webhook body is not a JSON object.');
  }
  if (options.replayStore && !(await options.replayStore.claim(id, tolerance * 2))) {
    throw new HamnivoWebhookError('duplicate', 'This webhook was already accepted.');
  }
  return event;
}
