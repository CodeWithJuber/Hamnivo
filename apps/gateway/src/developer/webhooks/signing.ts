import { createHmac, randomBytes } from 'node:crypto';

/**
 * Standard Webhooks signatures (symmetric, `v1`): HMAC-SHA256 over `{id}.{timestamp}.{body}` with
 * the base64-decoded secret after its `whsec_` prefix, sent as `v1,<base64>`. During a secret
 * rotation a request carries one signature per secret, space-separated, and receivers accept
 * any of them. https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
 */

const PREFIX = 'whsec_';

/** A new signing secret: 32 random bytes (the spec allows 24 to 64), base64, `whsec_` prefix. */
export function generateSigningSecret(): string {
  return `${PREFIX}${randomBytes(32).toString('base64')}`;
}

export function secretBytes(secret: string): Buffer {
  const encoded = secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) throw new Error('A signing secret cannot be empty');
  return bytes;
}

/** `v1,<signature>` for one secret. */
export function sign(secret: string, id: string, timestamp: number, body: string): string {
  const digest = createHmac('sha256', secretBytes(secret))
    .update(`${id}.${timestamp}.${body}`, 'utf8')
    .digest('base64');
  return `v1,${digest}`;
}

/** The `webhook-*` headers of one attempt, signed with every given secret. */
export function signatureHeaders(
  secrets: readonly string[],
  id: string,
  timestamp: number,
  body: string,
): Record<string, string> {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': secrets.map((secret) => sign(secret, id, timestamp, body)).join(' '),
  };
}
