import { createHash } from 'node:crypto';
import { FieldInventory } from '../fields.js';
import {
  ATTACHMENTS_FILE,
  AttachmentsManifest,
  type ContactRecord,
  type ConversationRecord,
  MANIFEST_FILE,
  Manifest,
  ManifestLine,
  type MessageRecord,
  PackageRecord,
  RECORDS_FILE,
} from '../model.js';
import type {
  FieldMapping,
  FileSourceAdapter,
  Issue,
  ItemKind,
  ParsedAttachment,
  ParsedConversation,
  ParsedSource,
  SourceDescriptor,
} from '../types.js';
import { PackageError, utf8 } from '../zip.js';

const CANONICAL: FieldMapping[] = [
  'type',
  'id',
  'source',
  'name',
  'verified',
  'unverified',
  'location',
  'attributes',
  'contactId',
  'status',
  'startedAt',
  'endedAt',
  'subject',
  'channel',
  'labels',
  'assignee',
  'declaredMessageCount',
  'conversationId',
  'createdAt',
  'author',
  'visibility',
  'text',
  'attachmentIds',
  'sourceType',
].map((source) => ({ source, target: `package.${source}`, status: 'supported' as const }));

export const packageDescriptor: SourceDescriptor = {
  system: 'hamnivo',
  accepts: ['zip', 'ndjson'],
  fields: CANONICAL,
  limits: [{ code: 'package_links_only', severity: 'info' }],
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function recordKind(value: unknown): ItemKind | undefined {
  const type = (value as { type?: unknown } | null)?.type;
  return type === 'contact' || type === 'conversation' || type === 'message' ? type : undefined;
}

function recordId(value: unknown): string | undefined {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id.length > 0 && id.length <= 512 ? id : undefined;
}

/**
 * Reads a Hamnivo migration package (M02): a ZIP with `manifest.json`, `records.ndjson`,
 * `attachments.json` and `attachments/…`, or a bare NDJSON file whose first line is the manifest.
 * Every line is validated; problems are reported per record, and a package holding fewer records
 * than its manifest declares is reported as cut short.
 */
export function parsePackage(files: Map<string, Uint8Array>): ParsedSource {
  const issues: Issue[] = [];
  let manifest: Manifest | null = null;
  let recordsName = RECORDS_FILE;
  let attachmentsName: string | null = ATTACHMENTS_FILE;
  let recordsText: string | null = null;

  const manifestBytes = files.get(MANIFEST_FILE);
  if (manifestBytes) {
    let raw: unknown;
    try {
      raw = JSON.parse(utf8(manifestBytes));
    } catch {
      throw new PackageError('corrupt', 'The package manifest is not valid JSON.');
    }
    const parsed = Manifest.safeParse(raw);
    if (!parsed.success) throw new PackageError('corrupt', 'The package manifest is not valid.');
    manifest = parsed.data;
    recordsName = manifest.files.records;
    attachmentsName = manifest.files.attachments;
    const records = files.get(recordsName);
    if (!records) {
      issues.push({ severity: 'error', code: 'truncated_file', location: recordsName });
    } else {
      const expected = manifest.checksums[recordsName];
      if (expected && expected !== sha256(records)) {
        issues.push({ severity: 'error', code: 'checksum_mismatch', location: recordsName });
      }
      recordsText = utf8(records);
    }
  } else {
    const ndjson = [...files.keys()].filter((name) => /\.(nd)?jsonl?$/i.test(name));
    const name = ndjson.length === 1 ? ndjson[0] : undefined;
    if (!name) {
      throw new PackageError('not_supported', 'No manifest.json or NDJSON file was found.');
    }
    recordsName = name;
    attachmentsName = null;
    recordsText = utf8(files.get(name) as Uint8Array);
  }

  const inventory = new FieldInventory();
  const contacts = new Map<string, ContactRecord>();
  const conversations = new Map<string, ConversationRecord>();
  const messages = new Map<string, { record: MessageRecord; line: number }>();
  const found = { contacts: 0, conversations: 0, messages: 0 };
  let truncated = false;

  if (recordsText !== null) {
    const complete = recordsText.endsWith('\n');
    const lines = recordsText.split('\n');
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const location = `${recordsName}:${index + 1}`;
      const last = index === lines.length - 1;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        if (last && !complete) {
          truncated = true;
          issues.push({ severity: 'error', code: 'truncated_file', location });
        } else {
          issues.push({ severity: 'error', code: 'invalid_json', location });
        }
        return;
      }
      if (index === 0 && !manifest && (value as { type?: unknown }).type === 'manifest') {
        const parsed = ManifestLine.safeParse(value);
        if (!parsed.success) {
          throw new PackageError('corrupt', 'The package manifest line is not valid.');
        }
        manifest = parsed.data;
        return;
      }
      const kind = recordKind(value);
      if (kind === 'contact') found.contacts += 1;
      if (kind === 'conversation') found.conversations += 1;
      if (kind === 'message') found.messages += 1;
      const parsed = PackageRecord.safeParse(value);
      if (!parsed.success) {
        const sourceId = recordId(value);
        const conversationId = (value as { conversationId?: unknown }).conversationId;
        issues.push({
          severity: 'warning',
          code: 'invalid_record',
          ...(kind ? { kind } : {}),
          ...(sourceId ? { sourceId } : {}),
          ...(kind === 'message' && typeof conversationId === 'string' ? { conversationId } : {}),
          location,
          detail: parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.') || 'record'}: ${i.code}`)
            .join('; '),
        });
        return;
      }
      inventory.add(value);
      const record = parsed.data;
      const duplicate = (sourceId: string, recordKind: ItemKind) =>
        issues.push({
          severity: 'warning',
          code: 'duplicate_in_file',
          kind: recordKind,
          sourceId,
          location,
        });
      if (record.type === 'contact') {
        if (contacts.has(record.id)) duplicate(record.id, 'contact');
        else contacts.set(record.id, record);
      } else if (record.type === 'conversation') {
        if (conversations.has(record.id)) duplicate(record.id, 'conversation');
        else conversations.set(record.id, record);
      } else if (messages.has(record.id)) duplicate(record.id, 'message');
      else messages.set(record.id, { record, line: index });
    });
  }

  const attachments = readAttachments(files, attachmentsName, manifest, issues);

  // Every record must point at records that exist.
  const byConversation = new Map<string, Array<{ record: MessageRecord; line: number }>>();
  for (const message of messages.values()) {
    const { record } = message;
    if (!conversations.has(record.conversationId)) {
      issues.push({
        severity: 'warning',
        code: 'missing_conversation',
        kind: 'message',
        sourceId: record.id,
        conversationId: record.conversationId,
      });
      continue;
    }
    for (const attachmentId of record.attachmentIds) {
      const known = attachments.get(attachmentId);
      if (!known) {
        // Referenced but not listed: kept visible as a quarantined file, never dropped silently.
        attachments.set(attachmentId, {
          entry: {
            id: attachmentId,
            messageId: record.id,
            name: 'file',
            mediaType: 'application/octet-stream',
            size: 0,
            sha256: null,
            path: null,
          },
          bytes: null,
          problem: 'missing_attachment',
        });
        issues.push({
          severity: 'warning',
          code: 'missing_attachment',
          kind: 'attachment',
          sourceId: attachmentId,
          conversationId: record.conversationId,
          detail: 'not in the attachments manifest',
        });
      } else if (known.entry.messageId !== record.id && !known.problem) {
        known.problem = 'invalid_record';
      }
    }
    const list = byConversation.get(record.conversationId) ?? [];
    list.push(message);
    byConversation.set(record.conversationId, list);
  }

  const parsedConversations: ParsedConversation[] = [];
  for (const conversation of conversations.values()) {
    const own = (byConversation.get(conversation.id) ?? []).sort(
      (a, b) => a.record.createdAt.localeCompare(b.record.createdAt) || a.line - b.line,
    );
    if (!contacts.has(conversation.contactId)) {
      issues.push({
        severity: 'warning',
        code: 'missing_contact',
        kind: 'conversation',
        sourceId: conversation.id,
      });
      for (const { record } of own) {
        issues.push({
          severity: 'warning',
          code: 'parent_failed',
          kind: 'message',
          sourceId: record.id,
          conversationId: conversation.id,
        });
      }
      continue;
    }
    parsedConversations.push({ record: conversation, messages: own.map((m) => m.record) });
  }

  const declared = (manifest as Manifest | null)?.counts ?? null;
  if (declared) {
    const short =
      found.contacts < declared.contacts ||
      found.conversations < declared.conversations ||
      found.messages < declared.messages;
    if (short) {
      truncated = true;
      issues.push({
        severity: 'error',
        code: 'count_mismatch',
        detail: `found ${found.conversations}/${declared.conversations} conversations, ${found.messages}/${declared.messages} messages, ${found.contacts}/${declared.contacts} contacts`,
      });
    }
  }
  if (manifest && !(manifest as Manifest).complete) {
    issues.push({ severity: 'warning', code: 'incomplete_package' });
  }
  if (parsedConversations.length === 0) {
    issues.push({ severity: 'error', code: 'no_conversations' });
  }

  return {
    system: 'hamnivo',
    schemaVersion: manifest ? `v${(manifest as Manifest).version}` : null,
    contacts: [...contacts.values()],
    conversations: parsedConversations,
    attachments,
    issues,
    fields: inventory.observations(CANONICAL),
    declared,
    truncated,
    files: files.size,
    origin: manifest
      ? {
          system: (manifest as Manifest).source.system,
          account: (manifest as Manifest).source.account ?? null,
        }
      : null,
  };
}

function readAttachments(
  files: Map<string, Uint8Array>,
  name: string | null,
  manifest: Manifest | null,
  issues: Issue[],
): Map<string, ParsedAttachment> {
  const result = new Map<string, ParsedAttachment>();
  const bytes = name ? files.get(name) : undefined;
  if (!name || !bytes) {
    if (name && manifest && manifest.counts.attachments > 0) {
      issues.push({ severity: 'error', code: 'truncated_file', location: name });
    }
    return result;
  }
  const expected = manifest?.checksums[name];
  if (expected && expected !== sha256(bytes)) {
    issues.push({ severity: 'error', code: 'checksum_mismatch', location: name });
  }
  let parsed: ReturnType<typeof AttachmentsManifest.safeParse>;
  try {
    parsed = AttachmentsManifest.safeParse(JSON.parse(utf8(bytes)));
  } catch {
    issues.push({ severity: 'error', code: 'invalid_json', location: name });
    return result;
  }
  if (!parsed.success) {
    issues.push({ severity: 'error', code: 'invalid_record', location: name });
    return result;
  }
  for (const entry of parsed.data.items) {
    if (result.has(entry.id)) {
      issues.push({
        severity: 'warning',
        code: 'duplicate_in_file',
        kind: 'attachment',
        sourceId: entry.id,
        location: name,
      });
      continue;
    }
    if (!entry.path) {
      result.set(entry.id, { entry, bytes: null, problem: 'binary_not_in_export' });
      continue;
    }
    const file = files.get(entry.path);
    if (!file) {
      result.set(entry.id, { entry, bytes: null, problem: 'missing_attachment' });
      continue;
    }
    const mismatch =
      file.byteLength !== entry.size || (entry.sha256 !== null && sha256(file) !== entry.sha256);
    result.set(entry.id, {
      entry,
      bytes: mismatch ? null : file,
      problem: mismatch ? 'checksum_mismatch' : null,
    });
  }
  return result;
}

export const packageAdapter: FileSourceAdapter = {
  descriptor: packageDescriptor,
  parse: parsePackage,
};
