import { FieldInventory } from '../fields.js';
import type {
  AttachmentEntry,
  AuthorKind,
  ContactRecord,
  ConversationRecord,
  MessageRecord,
} from '../model.js';
import type {
  FileSourceAdapter,
  Issue,
  ParsedAttachment,
  ParsedConversation,
  ParsedSource,
  SourceDescriptor,
} from '../types.js';
import {
  htmlToText,
  idOf,
  isClutter,
  isJsonFile,
  isObject,
  type Json,
  jsonValues,
  numberOf,
  text,
  unixTime,
  within,
} from './common.js';

/**
 * Intercom conversations as its REST API returns them (M05). Intercom has no export file with
 * message text (its CSV and data exports hold only metadata), so this reads JSON files holding a
 * conversation, a list of them or a `conversation.list`, or NDJSON with one per line:
 *
 *   { "type": "conversation", "id", "title", "created_at", "state", "admin_assignee_id",
 *     "priority", "tags": { "tags": [ { "name" } ] }, "custom_attributes",
 *     "contacts": { "contacts": [ { "id", "external_id" } ] },
 *     "source": { "type", "id", "subject", "body", "author": { "type", "id", "name", "email" },
 *       "attachments": [ { "name", "url", "content_type", "filesize" } ] },
 *     "conversation_parts": { "conversation_parts": [ { "id", "part_type", "body", "created_at",
 *       "author", "attachments", "redacted" } ], "total_count" } }
 *
 * Times are Unix seconds and bodies are HTML, imported as plain text. The API gives at most the
 * 500 latest parts of a conversation: one with fewer parts than `total_count` is imported with
 * what is there and reported as cut short. A conversation without its parts (as conversation
 * lists return them) is not imported. Contact objects (`"type": "contact"`) in the same files
 * give names. (Intercom API reference: Conversations, "Retrieve a conversation"; Contacts.)
 */

export const intercomDescriptor: SourceDescriptor = {
  system: 'intercom',
  accepts: ['zip', 'json', 'ndjson'],
  fields: [
    { source: 'type', target: 'conversation.kind', status: 'supported' },
    { source: 'id', target: 'conversation.source_id', status: 'supported', required: true },
    {
      source: 'created_at',
      target: 'conversation.started_at',
      status: 'supported',
      required: true,
    },
    { source: 'state', target: 'conversation.status', status: 'supported' },
    { source: 'open', target: 'conversation.status', status: 'supported' },
    { source: 'title', target: 'conversation.subject', status: 'supported' },
    { source: 'source.subject', target: 'conversation.subject', status: 'transformed' },
    { source: 'source.type', target: 'conversation.channel', status: 'supported' },
    { source: 'tags.tags[].name', target: 'conversation.labels', status: 'transformed' },
    { source: 'admin_assignee_id', target: 'conversation.assignee', status: 'transformed' },
    { source: 'team_assignee_id', target: 'conversation.team', status: 'unsupported' },
    { source: 'priority', target: 'conversation.attribute', status: 'transformed' },
    {
      source: 'conversation_rating.rating',
      target: 'conversation.attribute',
      status: 'transformed',
    },
    // Nested values are not copied; flat ones are kept as conversation details.
    { source: 'custom_attributes.*.*', target: 'conversation.attribute', status: 'unsupported' },
    { source: 'custom_attributes', target: 'conversation.attribute', status: 'transformed' },
    {
      source: 'conversation_parts.total_count',
      target: 'conversation.completeness_check',
      status: 'supported',
    },
    { source: 'contacts.contacts[].id', target: 'contact.source_id', status: 'supported' },
    {
      source: 'contacts.contacts[].external_id',
      target: 'contact.identifier',
      status: 'unsupported',
    },
    { source: 'source.id', target: 'message.source_id', status: 'supported' },
    { source: 'source.body', target: 'message.text', status: 'transformed' },
    { source: 'source.author.type', target: 'message.author', status: 'supported' },
    { source: 'source.author.id', target: 'message.author_source_id', status: 'supported' },
    { source: 'source.author.name', target: 'message.author_name', status: 'supported' },
    { source: 'source.author.email', target: 'contact.unverified_email', status: 'transformed' },
    { source: 'source.attachments', target: 'attachment.link', status: 'transformed' },
    {
      source: 'conversation_parts.conversation_parts[].id',
      target: 'message.source_id',
      status: 'supported',
    },
    {
      source: 'conversation_parts.conversation_parts[].created_at',
      target: 'message.original_time',
      status: 'supported',
    },
    {
      source: 'conversation_parts.conversation_parts[].body',
      target: 'message.text',
      status: 'transformed',
    },
    {
      source: 'conversation_parts.conversation_parts[].part_type',
      target: 'message.visibility',
      status: 'supported',
    },
    {
      source: 'conversation_parts.conversation_parts[].author.type',
      target: 'message.author',
      status: 'supported',
    },
    {
      source: 'conversation_parts.conversation_parts[].author.id',
      target: 'message.author_source_id',
      status: 'supported',
    },
    {
      source: 'conversation_parts.conversation_parts[].author.name',
      target: 'message.author_name',
      status: 'supported',
    },
    {
      source: 'conversation_parts.conversation_parts[].attachments',
      target: 'attachment.link',
      status: 'transformed',
    },
    { source: 'contact.id', target: 'contact.source_id', status: 'supported' },
    { source: 'contact.name', target: 'contact.name', status: 'supported' },
    { source: 'contact.email', target: 'contact.unverified_email', status: 'transformed' },
    { source: 'contact.phone', target: 'contact.unverified_phone', status: 'transformed' },
    { source: 'contact.location.city', target: 'contact.location', status: 'supported' },
    { source: 'contact.external_id', target: 'contact.identifier', status: 'unsupported' },
  ],
  limits: [
    { code: 'intercom_api_format', severity: 'info' },
    { code: 'intercom_parts_cap', severity: 'warning' },
    { code: 'intercom_events', severity: 'info' },
    { code: 'intercom_plain_text', severity: 'info' },
    { code: 'intercom_attachment_links', severity: 'warning' },
    { code: 'intercom_unverified_contacts', severity: 'info' },
  ],
};

const AUTHORS: Record<string, AuthorKind> = {
  user: 'customer',
  lead: 'customer',
  contact: 'customer',
  admin: 'agent',
  team: 'agent',
  bot: 'bot',
};

/** Parts that carry a reply along with an action (a teammate replies and closes, and so on). */
const REPLY_PARTS = new Set([
  'comment',
  'assignment',
  'open',
  'close',
  'snoozed',
  'unsnoozed',
  'away_mode_assignment',
]);

const MAX_TEXT = 150_000;
const MAX_ATTRIBUTES = 20;

interface Found {
  value: Json;
  location: string;
  file: string;
  pointer: string;
}

type Entry =
  | { kind: 'conversation' | 'contact'; value: Json; pointer: string }
  | { kind: 'unknown' };

function classify(value: unknown): Entry[] {
  if (!isObject(value)) return [{ kind: 'unknown' }];
  if (value.type === 'conversation' || isObject(value.conversation_parts)) {
    return [{ kind: 'conversation', value, pointer: '' }];
  }
  if (value.type === 'contact') return [{ kind: 'contact', value, pointer: '' }];
  // Lists: { "type": "conversation.list", "conversations": [...] }, { "type": "list", "data": [...] }.
  for (const key of ['conversations', 'data'] as const) {
    if (!Array.isArray(value[key])) continue;
    return (value[key] as unknown[]).flatMap((item, index) =>
      classify(item).map((entry) =>
        'pointer' in entry ? { ...entry, pointer: `/${key}/${index}${entry.pointer}` } : entry,
      ),
    );
  }
  return [{ kind: 'unknown' }];
}

const compareIds = (a: string, b: string) =>
  /^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b);

export function parseIntercomExport(files: Map<string, Uint8Array>): ParsedSource {
  const issues: Issue[] = [];
  const inventory = new FieldInventory();
  const found = new Map<string, Found>();
  const people = new Map<string, Json>();
  let truncated = false;
  let read = 0;

  for (const file of [...files.keys()].sort()) {
    if (!isJsonFile(file)) {
      if (!isClutter(file))
        issues.push({ severity: 'warning', code: 'unknown_file', location: file });
      continue;
    }
    read += 1;
    const result = jsonValues(file, files.get(file) as Uint8Array, issues);
    if (result.truncated) truncated = true;
    for (const item of result.values) {
      for (const entry of classify(item.value)) {
        if (entry.kind === 'unknown') {
          issues.push({ severity: 'warning', code: 'invalid_record', location: item.location });
          continue;
        }
        const location = within(item.location, entry.pointer);
        const id = idOf(entry.value.id);
        if (entry.kind === 'contact') {
          inventory.add({ contact: entry.value });
          if (id && !people.has(id)) people.set(id, entry.value);
          continue;
        }
        if (!id) {
          issues.push({
            severity: 'error',
            code: 'invalid_record',
            kind: 'conversation',
            location,
          });
          continue;
        }
        if (found.has(id)) {
          issues.push({
            severity: 'warning',
            code: 'duplicate_in_file',
            kind: 'conversation',
            sourceId: id,
            location,
          });
          continue;
        }
        inventory.add(entry.value);
        found.set(id, {
          value: entry.value,
          location,
          file,
          pointer: `${item.pointer}${entry.pointer}`,
        });
      }
    }
  }

  // Teammates' names, from every part they wrote, for assignees.
  const admins = new Map<string, string>();
  for (const { value } of found.values()) {
    for (const author of authorsOf(value)) {
      const id = idOf(author.id);
      const name = text(author.name);
      if (author.type === 'admin' && id && name && !admins.has(id)) admins.set(id, name);
    }
  }

  const contacts = new Map<string, ContactRecord>();
  const conversations: ParsedConversation[] = [];
  const attachments = new Map<string, ParsedAttachment>();
  const ordered = [...found.entries()].sort(
    ([a, x], [b, y]) =>
      (unixTime(x.value.created_at) ?? '').localeCompare(unixTime(y.value.created_at) ?? '') ||
      compareIds(a, b),
  );
  for (const [id, item] of ordered) {
    const list = isObject(item.value.conversation_parts) ? item.value.conversation_parts : null;
    const parts = list && Array.isArray(list.conversation_parts) ? list.conversation_parts : null;
    if (!parts) {
      truncated = true;
      issues.push({
        severity: 'warning',
        code: 'truncated',
        kind: 'conversation',
        sourceId: id,
        location: item.location,
        detail: 'conversation parts not in the export',
      });
      continue;
    }
    const total = numberOf(list?.total_count);
    if (total !== undefined && total > parts.length) {
      truncated = true;
      issues.push({
        severity: 'warning',
        code: 'truncated',
        kind: 'conversation',
        sourceId: id,
        location: item.location,
        detail: `${parts.length} of ${total} parts in the export`,
      });
    }
    const parsed = readConversation(id, item, parts, {
      people,
      admins,
      contacts,
      attachments,
      issues,
    });
    if (parsed) conversations.push(parsed);
  }

  if (conversations.length === 0) issues.push({ severity: 'error', code: 'no_conversations' });

  return {
    system: 'intercom',
    schemaVersion: null,
    contacts: [...contacts.values()],
    conversations,
    attachments,
    issues,
    fields: inventory.observations(intercomDescriptor.fields),
    declared: null,
    truncated,
    files: read,
    // Intercom conversation IDs are unique across workspaces.
    origin: { system: 'intercom', account: null },
  };
}

function authorsOf(conversation: Json): Json[] {
  const source = isObject(conversation.source) ? conversation.source : {};
  const list = isObject(conversation.conversation_parts) ? conversation.conversation_parts : {};
  const parts = Array.isArray(list.conversation_parts) ? list.conversation_parts : [];
  return [source, ...parts]
    .map((part) => (isObject(part) && isObject(part.author) ? part.author : null))
    .filter((author): author is Json => author !== null);
}

interface ConversationContext {
  people: Map<string, Json>;
  admins: Map<string, string>;
  contacts: Map<string, ContactRecord>;
  attachments: Map<string, ParsedAttachment>;
  issues: Issue[];
}

function readConversation(
  id: string,
  item: Found,
  parts: unknown[],
  ctx: ConversationContext,
): ParsedConversation | null {
  const conversation = item.value;
  const { people, admins, contacts, attachments, issues } = ctx;
  const source = isObject(conversation.source) ? conversation.source : {};
  const sourceAuthor = isObject(source.author) ? source.author : {};
  const listed =
    isObject(conversation.contacts) && Array.isArray(conversation.contacts.contacts)
      ? conversation.contacts.contacts.filter(isObject)
      : [];
  const customerId =
    idOf(listed[0]?.id) ??
    (AUTHORS[String(sourceAuthor.type)] === 'customer' ? idOf(sourceAuthor.id) : undefined);
  const contactId = customerId ? `contact:${customerId}` : `conversation:${id}`;
  if (!contacts.has(contactId)) {
    const person = customerId ? people.get(customerId) : undefined;
    // Without the contact object, the customer's own messages name them.
    const asAuthor = customerId
      ? authorsOf(conversation).find(
          (author) => idOf(author.id) === customerId && AUTHORS[String(author.type)] === 'customer',
        )
      : undefined;
    const email = text(person?.email, 320) ?? text(asAuthor?.email, 320);
    const phone = text(person?.phone, 64);
    const location = person && isObject(person.location) ? person.location : {};
    const city = text(location.city, 128);
    contacts.set(contactId, {
      type: 'contact',
      id: contactId,
      source: {
        system: 'intercom',
        id: customerId ?? id,
        raw: { file: item.file, pointer: `${item.pointer}/contacts` },
      },
      name: text(person?.name) ?? text(asAuthor?.name) ?? null,
      verified: null,
      unverified: { ...(email ? { email } : {}), ...(phone ? { phone } : {}) },
      ...(city ? { location: { city } } : {}),
      attributes: {},
    });
  }

  const messages: Array<{ record: MessageRecord; index: number }> = [];
  const read = (raw: unknown, index: number, first: boolean) => {
    const partId = isObject(raw) ? idOf(raw.id) : undefined;
    const messageId = first ? `${id}:source` : `${id}:${partId ?? `#${index}`}`;
    const inner = first ? '/source' : `/conversation_parts/conversation_parts/${index}`;
    const quarantine = (code: Issue['code'], detail?: string) => {
      issues.push({
        severity: 'warning',
        code,
        kind: 'message',
        sourceId: messageId,
        conversationId: id,
        location: within(item.location, inner),
        ...(detail ? { detail } : {}),
      });
    };
    if (!isObject(raw)) {
      quarantine('invalid_record');
      return;
    }
    const type = first ? 'source' : (text(raw.part_type, 64) ?? 'comment');
    const note = type === 'note' || type.startsWith('note_');
    const body = typeof raw.body === 'string' ? htmlToText(raw.body) : '';
    const files = Array.isArray(raw.attachments) ? raw.attachments : [];
    if (!body && files.length === 0) {
      // A part with nothing in it is an event (an assignment, a state change and so on), unless
      // it was a message whose text was deleted.
      if (first || note || type === 'comment' || raw.redacted === true) {
        quarantine('empty_message', raw.redacted === true ? 'redacted' : undefined);
      }
      return;
    }
    if (!first && !note && !REPLY_PARTS.has(type)) {
      quarantine('unsupported_type', `part ${type}`);
      return;
    }
    const author = isObject(raw.author) ? raw.author : {};
    const kind = AUTHORS[String(author.type)];
    if (!kind) {
      quarantine('unsupported_sender', `sender ${String(author.type).slice(0, 16)}`);
      return;
    }
    const createdAt = unixTime(first ? conversation.created_at : raw.created_at);
    if (!createdAt) {
      quarantine('missing_time');
      return;
    }
    if (body.length > MAX_TEXT) {
      quarantine('too_large', `${body.length} characters`);
      return;
    }
    const attachmentIds: string[] = [];
    files.forEach((file, j) => {
      const info = isObject(file) ? file : {};
      const entry: AttachmentEntry = {
        id: `${messageId}:${j}`,
        messageId,
        name: text(info.name) ?? 'file',
        mediaType: text(info.content_type) ?? 'application/octet-stream',
        size: Math.max(0, Math.trunc(numberOf(info.filesize) ?? 0)),
        sha256: null,
        path: null,
        url: text(info.url, 2048) ?? null,
      };
      attachmentIds.push(entry.id);
      // Conversations link to files; the files themselves are not in the export.
      attachments.set(entry.id, { entry, bytes: null, problem: 'binary_not_in_export' });
    });
    messages.push({
      index,
      record: {
        type: 'message',
        id: messageId,
        source: {
          system: 'intercom',
          id: partId ?? messageId,
          raw: { file: item.file, pointer: `${item.pointer}${inner}` },
        },
        conversationId: id,
        createdAt,
        author: {
          kind,
          name: text(author.name) ?? null,
          sourceId: idOf(author.id) ?? null,
        },
        visibility: note ? 'internal' : 'public',
        text: body || null,
        attachmentIds,
        sourceType: type,
      },
    });
  };
  read(conversation.source, -1, true);
  parts.forEach((part, index) => {
    read(part, index, false);
  });

  const firstTime = messages
    .map((m) => m.record.createdAt)
    .sort()
    .at(0);
  const startedAt = unixTime(conversation.created_at) ?? firstTime ?? null;
  if (!startedAt) {
    issues.push({
      severity: 'error',
      code: 'missing_time',
      kind: 'conversation',
      sourceId: id,
      location: item.location,
    });
    for (const m of messages) {
      issues.push({
        severity: 'warning',
        code: 'parent_failed',
        kind: 'message',
        sourceId: m.record.id,
        conversationId: id,
      });
    }
    return null;
  }

  const state = String(conversation.state ?? '');
  const status: ConversationRecord['status'] =
    state === 'closed'
      ? 'resolved'
      : state === 'snoozed'
        ? 'snoozed'
        : state === 'open' || conversation.open !== false
          ? 'open'
          : 'resolved';
  const tags =
    isObject(conversation.tags) && Array.isArray(conversation.tags.tags)
      ? conversation.tags.tags
      : [];
  const labels = [
    ...new Set(
      tags
        .map((tag) => (isObject(tag) ? text(tag.name, 64)?.trim() : undefined))
        .filter((name): name is string => Boolean(name)),
    ),
  ].slice(0, 50);
  const assigneeId = idOf(conversation.admin_assignee_id);
  const attributes: Record<string, string | number | boolean | null> = {};
  const priority = text(conversation.priority, 32);
  if (priority) attributes.intercom_priority = priority;
  const rating = isObject(conversation.conversation_rating)
    ? numberOf(conversation.conversation_rating.rating)
    : undefined;
  if (rating !== undefined) attributes.intercom_rating = rating;
  const custom = isObject(conversation.custom_attributes) ? conversation.custom_attributes : {};
  for (const [key, value] of Object.entries(custom)) {
    if (Object.keys(attributes).length >= MAX_ATTRIBUTES) break;
    if (!/^[\w .-]{1,100}$/.test(key)) continue;
    // Only flat values are kept; nested structures are not copied.
    if (typeof value === 'string') attributes[`intercom_${key}`] = value.slice(0, 2000);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      attributes[`intercom_${key}`] = value;
    }
  }
  const channel = text(source.type, 48);
  const subject =
    text(conversation.title, 500) ??
    (typeof source.subject === 'string' ? text(htmlToText(source.subject), 500) : undefined);

  return {
    record: {
      type: 'conversation',
      id,
      source: { system: 'intercom', id, raw: { file: item.file, pointer: item.pointer } },
      contactId,
      status,
      startedAt,
      endedAt: null,
      subject: subject ?? null,
      channel: channel ? `intercom ${channel}` : 'intercom',
      labels,
      assignee:
        assigneeId && assigneeId !== '0'
          ? { name: admins.get(assigneeId) ?? null, sourceId: assigneeId }
          : null,
      declaredMessageCount: null,
      attributes,
    },
    messages: messages
      .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt) || a.index - b.index)
      .map((m) => m.record),
  };
}

export const intercomAdapter: FileSourceAdapter = {
  descriptor: intercomDescriptor,
  parse: parseIntercomExport,
};
