import { createHash } from 'node:crypto';
import {
  ATTACHMENTS_FILE,
  type AttachmentEntry,
  type ContactRecord,
  type ConversationRecord,
  MANIFEST_FILE,
  type Manifest,
  type MessageRecord,
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  PackageRecord,
  RECORDS_FILE,
} from '../model.js';
import { writeZip } from '../zip.js';

export interface PackageAttachmentInput {
  id: string;
  messageId: string;
  name: string;
  mediaType: string;
  /** The file itself; null when only a link is known (the package is then incomplete). */
  bytes: Uint8Array | null;
  url?: string | null;
  /** Declared size, used when the bytes are absent. */
  size?: number;
}

export interface PackageInput {
  source: Manifest['source'];
  generator?: Manifest['generator'];
  contacts: ContactRecord[];
  conversations: ConversationRecord[];
  messages: MessageRecord[];
  attachments?: PackageAttachmentInput[];
  notes?: string[];
  /** Defaults to true unless an attachment has no bytes. */
  complete?: boolean;
  createdAt?: Date;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();

/** One JSON object per line, each validated against the package schema first. */
export function toNdjson(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(PackageRecord.parse(record))}\n`).join('');
}

/** Orders records as readers expect: contacts, then each conversation followed by its messages. */
export function orderRecords(
  input: Pick<PackageInput, 'contacts' | 'conversations' | 'messages'>,
): Array<ContactRecord | ConversationRecord | MessageRecord> {
  const byConversation = new Map<string, MessageRecord[]>();
  for (const message of input.messages) {
    const list = byConversation.get(message.conversationId) ?? [];
    list.push(message);
    byConversation.set(message.conversationId, list);
  }
  const ordered: Array<ContactRecord | ConversationRecord | MessageRecord> = [...input.contacts];
  for (const conversation of input.conversations) {
    ordered.push(conversation);
    const own = byConversation.get(conversation.id) ?? [];
    ordered.push(...own.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }
  return ordered;
}

const safeFileName = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

/**
 * Writes a Hamnivo migration package (ZIP): manifest.json with counts and checksums,
 * records.ndjson, attachments.json and the attachment files under attachments/.
 */
export function writePackage(input: PackageInput): Uint8Array {
  const records = toNdjson(orderRecords(input));
  const files = new Map<string, Uint8Array>();
  const recordBytes = encoder.encode(records);
  files.set(RECORDS_FILE, recordBytes);

  const entries: AttachmentEntry[] = [];
  let missing = 0;
  (input.attachments ?? []).forEach((attachment, index) => {
    const path = attachment.bytes
      ? `attachments/${String(index + 1).padStart(5, '0')}-${safeFileName(attachment.id)}`
      : null;
    if (path && attachment.bytes) files.set(path, attachment.bytes);
    else missing += 1;
    entries.push({
      id: attachment.id,
      messageId: attachment.messageId,
      name: attachment.name.slice(0, 255) || 'file',
      mediaType: attachment.mediaType,
      size: attachment.bytes?.byteLength ?? attachment.size ?? 0,
      sha256: attachment.bytes ? sha256(attachment.bytes) : null,
      path,
      url: attachment.url ?? null,
    });
  });
  const attachmentBytes = encoder.encode(`${JSON.stringify({ items: entries }, null, 1)}\n`);
  files.set(ATTACHMENTS_FILE, attachmentBytes);

  const manifest: Manifest = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    generator: input.generator ?? { name: '@hamnivo/migration-sdk', version: '0.1.0' },
    source: input.source,
    counts: {
      contacts: input.contacts.length,
      conversations: input.conversations.length,
      messages: input.messages.length,
      attachments: entries.length,
    },
    files: { records: RECORDS_FILE, attachments: ATTACHMENTS_FILE },
    checksums: { [RECORDS_FILE]: sha256(recordBytes), [ATTACHMENTS_FILE]: sha256(attachmentBytes) },
    complete: input.complete ?? missing === 0,
    notes: input.notes ?? [],
  };
  files.set(MANIFEST_FILE, encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  return writeZip(files);
}
