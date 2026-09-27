import { FieldInventory } from '../fields.js';
import type { AttachmentEntry, ContactRecord, MessageRecord } from '../model.js';
import type {
  FileSourceAdapter,
  Issue,
  ParsedAttachment,
  ParsedConversation,
  ParsedSource,
  SourceDescriptor,
} from '../types.js';
import { PackageError, utf8 } from '../zip.js';

/**
 * tawk.to JSON export (M03). The dashboard sends a ZIP with one or more JSON files, each holding a
 * chat like:
 *
 *   { "id", "type": "chat", "pageId", "visitor": { "name", "id", "email" },
 *     "location": { "countryCode", "city" }, "messageCount", "chatDuration", "rating",
 *     "createdOn", "messages": [ { "sender": { "t": "v"|"a"|"s", "n", "id" }, "type": "msg",
 *     "time", "msg", "attchs": [ { "type": "file", "content": { "file": { "url", "name",
 *     "mimeType", "size" } } } ] } ] }
 *
 * (tawk.to help centre, "How do I convert JSON files?", and the chat transcript webhook payload.)
 * Any other field is listed as not imported, never dropped silently. The export has no private
 * notes and no verified identity; visitor emails are what people typed in the pre-chat form.
 */

export const TAWK_EXPORT_CAP = 50;

export const tawkDescriptor: SourceDescriptor = {
  system: 'tawk.to',
  accepts: ['zip', 'json'],
  fields: [
    { source: 'id', target: 'conversation.source_id', status: 'supported', required: true },
    { source: 'type', target: 'conversation.kind', status: 'supported' },
    { source: 'createdOn', target: 'conversation.started_at', status: 'supported' },
    {
      source: 'messages[].time',
      target: 'message.original_time',
      status: 'supported',
      required: true,
    },
    { source: 'messages[].msg', target: 'message.text', status: 'supported' },
    { source: 'messages[].type', target: 'message.kind', status: 'supported' },
    {
      source: 'messages[].sender.t',
      target: 'message.author',
      status: 'supported',
      required: true,
    },
    { source: 'messages[].sender.n', target: 'message.author_name', status: 'supported' },
    { source: 'messages[].sender.id', target: 'message.author_source_id', status: 'supported' },
    { source: 'messages[].attchs', target: 'attachment.link', status: 'transformed' },
    { source: 'visitor.id', target: 'contact.source_id', status: 'supported' },
    { source: 'visitor.name', target: 'contact.name', status: 'supported' },
    { source: 'visitor.email', target: 'contact.unverified_email', status: 'transformed' },
    { source: 'visitor.phone', target: 'contact.unverified_phone', status: 'transformed' },
    { source: 'visitor.city', target: 'contact.location', status: 'supported' },
    { source: 'visitor.country', target: 'contact.location', status: 'supported' },
    { source: 'location', target: 'contact.location', status: 'supported' },
    { source: 'messageCount', target: 'conversation.completeness_check', status: 'supported' },
    { source: 'rating', target: 'conversation.attribute', status: 'transformed' },
    { source: 'chatDuration', target: 'conversation.attribute', status: 'transformed' },
    { source: 'pageId', target: 'conversation.attribute', status: 'transformed' },
    { source: 'property.id', target: 'conversation.attribute', status: 'transformed' },
    { source: 'property.name', target: 'conversation.attribute', status: 'transformed' },
  ],
  limits: [
    { code: 'tawk_export_cap', severity: 'warning' },
    { code: 'tawk_rest_approval', severity: 'info' },
    { code: 'tawk_attachment_links', severity: 'warning' },
    { code: 'tawk_tickets', severity: 'info' },
    { code: 'tawk_no_notes', severity: 'info' },
    { code: 'tawk_unverified_email', severity: 'info' },
  ],
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 255): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.slice(0, max) : undefined;
const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

function jsonError(error: unknown): 'truncated_file' | 'invalid_json' {
  const message = error instanceof Error ? error.message : '';
  return /end of (json )?(data|input)|unterminated|unexpected end/i.test(message)
    ? 'truncated_file'
    : 'invalid_json';
}

const SENDERS = { v: 'customer', a: 'agent', s: 'system' } as const;

export function parseTawkExport(files: Map<string, Uint8Array>): ParsedSource {
  const issues: Issue[] = [];
  const inventory = new FieldInventory();
  const contacts = new Map<string, ContactRecord>();
  const conversations: ParsedConversation[] = [];
  const attachments = new Map<string, ParsedAttachment>();
  const seenChats = new Set<string>();
  let truncated = false;
  let declaredMessages = 0;
  let everyChatDeclares = true;
  let jsonFiles = 0;

  const names = [...files.keys()].sort();
  for (const file of names) {
    if (!/\.json$/i.test(file)) {
      // Operating-system clutter inside archives (for example macOS resource forks).
      if (!/(^|\/)(__MACOSX\/|\.DS_Store$)/.test(file)) {
        issues.push({ severity: 'warning', code: 'unknown_file', location: file });
      }
      continue;
    }
    jsonFiles += 1;
    let value: unknown;
    try {
      value = JSON.parse(utf8(files.get(file) as Uint8Array));
    } catch (error) {
      const code = error instanceof PackageError ? 'invalid_json' : jsonError(error);
      if (code === 'truncated_file') truncated = true;
      issues.push({ severity: 'error', code, location: file });
      continue;
    }
    const chats = Array.isArray(value) ? value : [value];
    chats.forEach((chat, index) => {
      const pointer = Array.isArray(value) ? `/${index}` : '';
      const location = `${file}${pointer ? `#${pointer}` : ''}`;
      if (!isObject(chat)) {
        issues.push({ severity: 'error', code: 'invalid_record', kind: 'conversation', location });
        return;
      }
      const chatId = text(chat.id, 200) ?? text(chat._id, 200) ?? text(chat.chatId, 200);
      if (chat.type !== undefined && chat.type !== 'chat') {
        issues.push({
          severity: 'warning',
          code: 'unsupported_type',
          kind: 'conversation',
          ...(chatId ? { sourceId: chatId } : {}),
          location,
          detail: `type ${String(chat.type).slice(0, 32)}`,
        });
        return;
      }
      if (!chatId || !Array.isArray(chat.messages)) {
        issues.push({ severity: 'error', code: 'invalid_record', kind: 'conversation', location });
        return;
      }
      if (seenChats.has(chatId)) {
        issues.push({
          severity: 'warning',
          code: 'duplicate_in_file',
          kind: 'conversation',
          sourceId: chatId,
          location,
        });
        return;
      }
      seenChats.add(chatId);
      inventory.add(chat);
      const parsed = readChat(chat, chatId, file, pointer, issues, contacts, attachments);
      if (!parsed) return;
      conversations.push(parsed);
      const declared = numberOf(chat.messageCount);
      if (declared === undefined) everyChatDeclares = false;
      else {
        declaredMessages += declared;
        const found = (chat.messages as unknown[]).length;
        if (declared > found) {
          truncated = true;
          issues.push({
            severity: 'warning',
            code: 'truncated',
            kind: 'conversation',
            sourceId: chatId,
            location,
            detail: `${found} of ${declared} messages in the export`,
          });
        }
      }
    });
  }

  if (conversations.length === 0) {
    issues.push({ severity: 'error', code: 'no_conversations' });
  } else if (conversations.length === TAWK_EXPORT_CAP) {
    issues.push({ severity: 'warning', code: 'export_cap_reached', detail: `${TAWK_EXPORT_CAP}` });
  }

  return {
    system: 'tawk.to',
    schemaVersion: null,
    contacts: [...contacts.values()],
    conversations,
    attachments,
    issues,
    fields: inventory.observations(tawkDescriptor.fields),
    declared:
      conversations.length > 0 && everyChatDeclares
        ? { conversations: seenChats.size, messages: declaredMessages }
        : null,
    truncated,
    files: jsonFiles,
  };
}

function readChat(
  chat: Json,
  chatId: string,
  file: string,
  pointer: string,
  issues: Issue[],
  contacts: Map<string, ContactRecord>,
  attachments: Map<string, ParsedAttachment>,
): ParsedConversation | null {
  const visitor = isObject(chat.visitor) ? chat.visitor : {};
  const location = isObject(chat.location) ? chat.location : {};
  const visitorId = text(visitor.id, 200);
  const contactId = visitorId ? `visitor:${visitorId}` : `chat:${chatId}`;
  const visitorName = text(visitor.name) ?? null;
  if (!contacts.has(contactId)) {
    const email = text(visitor.email, 320);
    const phone = text(visitor.phone, 64);
    const city = text(location.city, 128) ?? text(visitor.city, 128);
    const countryCode = text(location.countryCode, 8) ?? text(visitor.country, 8);
    contacts.set(contactId, {
      type: 'contact',
      id: contactId,
      source: {
        system: 'tawk.to',
        id: visitorId ?? chatId,
        raw: { file, pointer: `${pointer}/visitor` },
      },
      name: visitorName,
      verified: null,
      unverified: { ...(email ? { email } : {}), ...(phone ? { phone } : {}) },
      ...(city || countryCode
        ? { location: { ...(city ? { city } : {}), ...(countryCode ? { countryCode } : {}) } }
        : {}),
      attributes: {},
    });
  }

  const messages: Array<{ record: MessageRecord; index: number }> = [];
  let lastAgent: { name: string | null; sourceId: string | null } | null = null;
  for (const [index, raw] of (chat.messages as unknown[]).entries()) {
    const id = `${chatId}:${index}`;
    const where = `${file}#${pointer}/messages/${index}`;
    const quarantine = (code: Issue['code'], detail?: string) => {
      issues.push({
        severity: 'warning',
        code,
        kind: 'message',
        sourceId: id,
        conversationId: chatId,
        location: where,
        ...(detail ? { detail } : {}),
      });
    };
    if (!isObject(raw)) {
      quarantine('invalid_record');
      continue;
    }
    const sender = isObject(raw.sender) ? raw.sender : {};
    const kind = SENDERS[String(sender.t) as keyof typeof SENDERS];
    if (!kind) {
      quarantine('unsupported_sender', `sender ${String(sender.t).slice(0, 8)}`);
      continue;
    }
    const createdAt = isoTime(raw.time);
    if (!createdAt) {
      quarantine('missing_time');
      continue;
    }
    if (raw.type !== undefined && raw.type !== 'msg') {
      quarantine('unsupported_type', `type ${String(raw.type).slice(0, 32)}`);
      continue;
    }
    const attachmentIds: string[] = [];
    if (Array.isArray(raw.attchs)) {
      raw.attchs.forEach((attachment, j) => {
        const content =
          isObject(attachment) && isObject(attachment.content) ? attachment.content : {};
        const info = isObject(content.file) ? content.file : {};
        const entry: AttachmentEntry = {
          id: `${id}:${j}`,
          messageId: id,
          name: text(info.name) ?? 'file',
          mediaType: text(info.mimeType, 255) ?? 'application/octet-stream',
          size: Math.max(0, Math.trunc(numberOf(info.size) ?? 0)),
          sha256: null,
          path: null,
          url: text(info.url, 2048) ?? null,
        };
        attachmentIds.push(entry.id);
        // tawk.to exports only link to files; the files themselves are not in the export.
        attachments.set(entry.id, { entry, bytes: null, problem: 'binary_not_in_export' });
      });
    }
    const body = typeof raw.msg === 'string' ? raw.msg : null;
    if (!body?.trim() && attachmentIds.length === 0) {
      quarantine('empty_message');
      continue;
    }
    const authorName = kind === 'customer' ? visitorName : (text(sender.n) ?? null);
    const authorId = kind === 'agent' ? (text(sender.id, 200) ?? null) : null;
    if (kind === 'agent') lastAgent = { name: authorName, sourceId: authorId };
    messages.push({
      index,
      record: {
        type: 'message',
        id,
        source: { system: 'tawk.to', id, raw: { file, pointer: `${pointer}/messages/${index}` } },
        conversationId: chatId,
        createdAt,
        author: { kind, name: authorName, sourceId: authorId },
        visibility: 'public',
        text: body?.trim() ? body : null,
        attachmentIds,
        sourceType: 'msg',
      },
    });
  }

  const firstTime = messages
    .map((m) => m.record.createdAt)
    .sort()
    .at(0);
  const startedAt = isoTime(chat.createdOn) ?? firstTime ?? null;
  if (!startedAt) {
    issues.push({
      severity: 'error',
      code: 'missing_time',
      kind: 'conversation',
      sourceId: chatId,
      location: `${file}#${pointer}`,
    });
    for (const m of messages) {
      issues.push({
        severity: 'warning',
        code: 'parent_failed',
        kind: 'message',
        sourceId: m.record.id,
        conversationId: chatId,
      });
    }
    return null;
  }
  const property = isObject(chat.property) ? chat.property : {};
  const rating = numberOf(chat.rating);
  const duration = numberOf(chat.chatDuration);
  const attributes: Record<string, string | number | boolean | null> = {};
  if (rating !== undefined) attributes.tawk_rating = rating;
  if (duration !== undefined) attributes.tawk_chat_duration = duration;
  const pageId = text(chat.pageId, 128) ?? text(property.id, 128);
  if (pageId) attributes.tawk_page_id = pageId;
  const propertyName = text(property.name, 255);
  if (propertyName) attributes.tawk_property = propertyName;
  const declared = numberOf(chat.messageCount);

  return {
    record: {
      type: 'conversation',
      id: chatId,
      source: { system: 'tawk.to', id: chatId, raw: { file, pointer: pointer || '' } },
      contactId,
      status: 'resolved',
      startedAt,
      endedAt: null,
      subject: null,
      channel: 'tawk.to chat',
      labels: [],
      assignee: lastAgent,
      declaredMessageCount: declared === undefined ? null : Math.trunc(declared),
      attributes,
    },
    messages: messages
      .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt) || a.index - b.index)
      .map((m) => m.record),
  };
}

export const tawkAdapter: FileSourceAdapter = {
  descriptor: tawkDescriptor,
  parse: parseTawkExport,
};
