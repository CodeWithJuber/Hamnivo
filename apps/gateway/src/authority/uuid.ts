import { createHash } from 'node:crypto';

/** RFC 9562 version 5 UUID: SHA-1 over the namespace UUID and the name. Deterministic. */
export function uuidV5(namespace: string, name: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name)
    .digest();
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stable Hamnivo id for a message that lives in the authority, the same whichever path (API
 * response, webhook, reconciler) sees it first. The authority's own id is not exposed.
 */
export const authorityMessageUuid = (connectionId: string, messageRef: string) =>
  uuidV5(connectionId, `message:${messageRef}`);
