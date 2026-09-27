import { createHash } from 'node:crypto';

/**
 * Keys that make every write to the conversation authority idempotent. Chatwoot stores a message's
 * `source_id` and echoes it back, so a write whose outcome is unknown is looked up by its key
 * instead of being sent again. Keys are scoped to the job: `hv1:imp:<job>:<source id>`.
 */

const SAFE = /^[A-Za-z0-9._:-]{1,64}$/;

const digest = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('base64url').slice(0, 32);

/** A source ID as it appears in keys: unchanged when short and plain, otherwise hashed. */
export function keyPart(sourceId: string): string {
  return SAFE.test(sourceId) ? sourceId : `h.${digest(sourceId)}`;
}

/** Chatwoot message `source_id` for an imported message. */
export function importMessageKey(jobId: string, messageSourceId: string): string {
  return `hv1:imp:${jobId}:${keyPart(messageSourceId)}`;
}

/** Conversation custom attribute that finds an imported conversation again after a timeout. */
export function importConversationKey(jobId: string, conversationSourceId: string): string {
  return `hv1:imp:${jobId}:c:${keyPart(conversationSourceId)}`;
}

/**
 * Chatwoot contact identifier for an imported person. Always hashed, so an email or phone number
 * used as a source ID never reaches Chatwoot, and scoped to the job, so a rollback removes
 * exactly the contacts that job created.
 */
export function importContactIdentifier(jobId: string, contactSourceId: string): string {
  return `hv:imp:${jobId}:${digest(contactSourceId)}`;
}

export const isImportKey = (key: string | null | undefined): key is string =>
  typeof key === 'string' && key.startsWith('hv1:imp:');
