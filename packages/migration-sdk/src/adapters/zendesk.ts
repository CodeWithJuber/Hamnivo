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
  idOf,
  isClutter,
  isJsonFile,
  isObject,
  isoTime,
  type Json,
  jsonValues,
  numberOf,
  text,
  within,
} from './common.js';

/**
 * Zendesk full JSON export (M05). Admin Center → Account → Tools → Reports → Export gives a ZIP of
 * NDJSON files, one ticket per line (`{"ticket": {…}}`, or the bare ticket), with its comments:
 *
 *   { "id", "url", "subject", "status", "priority", "type", "tags", "via": { "channel",
 *     "source": { "from": { "address", "name" } } }, "requester_id", "submitter_id",
 *     "assignee_id", "group_id", "created_at", "satisfaction_rating": { "score" },
 *     "comments": [ { "id", "type", "author_id", "body", "html_body", "plain_body", "public",
 *     "attachments": [ { "id", "file_name", "content_url", "content_type", "size" } ],
 *     "created_at" } ] }
 *
 * Zendesk leaves the comments out of any ticket holding more than 1 MB, and adds a file listing
 * those tickets with an error. Such tickets are reported as cut short and are not imported:
 * importing them half would make a later, complete import skip them as duplicates. The users
 * export (the same export with type "users", `{"user": {…}}` per line) can be added to the ZIP:
 * it gives names and tells customers from teammates. Organizations are listed as not imported.
 * (Zendesk help, "Exporting ticket, user, or organization data from your account" and "Why is my
 * full JSON export not valid JSON?"; Support API, Tickets and Ticket Comments.)
 */

export const zendeskDescriptor: SourceDescriptor = {
  system: 'zendesk',
  accepts: ['zip', 'json', 'ndjson'],
  fields: [
    { source: 'ticket.id', target: 'conversation.source_id', status: 'supported', required: true },
    { source: 'ticket.status', target: 'conversation.status', status: 'supported' },
    { source: 'ticket.created_at', target: 'conversation.started_at', status: 'supported' },
    { source: 'ticket.subject', target: 'conversation.subject', status: 'supported' },
    { source: 'ticket.raw_subject', target: 'conversation.subject', status: 'supported' },
    { source: 'ticket.via.channel', target: 'conversation.channel', status: 'supported' },
    { source: 'ticket.tags', target: 'conversation.labels', status: 'transformed' },
    { source: 'ticket.assignee_id', target: 'conversation.assignee', status: 'transformed' },
    { source: 'ticket.group_id', target: 'conversation.team', status: 'unsupported' },
    { source: 'ticket.priority', target: 'conversation.attribute', status: 'transformed' },
    { source: 'ticket.type', target: 'conversation.attribute', status: 'transformed' },
    {
      source: 'ticket.satisfaction_rating.score',
      target: 'conversation.attribute',
      status: 'transformed',
    },
    { source: 'ticket.requester_id', target: 'contact.source_id', status: 'supported' },
    { source: 'ticket.submitter_id', target: 'message.author', status: 'supported' },
    { source: 'ticket.via.source.from.name', target: 'contact.name', status: 'supported' },
    {
      source: 'ticket.via.source.from.address',
      target: 'contact.unverified_email',
      status: 'transformed',
    },
    // The first comment holds the same text.
    { source: 'ticket.description', target: 'message.text', status: 'supported' },
    { source: 'ticket.comments[].id', target: 'message.source_id', status: 'supported' },
    {
      source: 'ticket.comments[].created_at',
      target: 'message.original_time',
      status: 'supported',
      required: true,
    },
    { source: 'ticket.comments[].body', target: 'message.text', status: 'supported' },
    { source: 'ticket.comments[].plain_body', target: 'message.text', status: 'supported' },
    { source: 'ticket.comments[].html_body', target: 'message.formatting', status: 'unsupported' },
    { source: 'ticket.comments[].public', target: 'message.visibility', status: 'supported' },
    { source: 'ticket.comments[].author_id', target: 'message.author', status: 'supported' },
    { source: 'ticket.comments[].type', target: 'message.kind', status: 'supported' },
    { source: 'ticket.comments[].attachments', target: 'attachment.link', status: 'transformed' },
    { source: 'user.id', target: 'contact.source_id', status: 'supported' },
    { source: 'user.name', target: 'contact.name', status: 'supported' },
    { source: 'user.email', target: 'contact.unverified_email', status: 'transformed' },
    { source: 'user.phone', target: 'contact.unverified_phone', status: 'transformed' },
    { source: 'user.role', target: 'message.author', status: 'supported' },
    { source: 'user.external_id', target: 'contact.identifier', status: 'unsupported' },
  ],
  limits: [
    { code: 'zendesk_large_tickets', severity: 'warning' },
    { code: 'zendesk_users_export', severity: 'warning' },
    { code: 'zendesk_attachment_links', severity: 'warning' },
    { code: 'zendesk_history', severity: 'info' },
    { code: 'zendesk_unverified_contacts', severity: 'info' },
  ],
};

const STATUSES: Record<string, ConversationRecord['status']> = {
  new: 'open',
  open: 'open',
  pending: 'pending',
  hold: 'pending',
  solved: 'resolved',
  closed: 'resolved',
};

const ROLES: Record<string, AuthorKind> = {
  'end-user': 'customer',
  agent: 'agent',
  admin: 'agent',
};

/** Zendesk's own comments (for example from triggers) have author -1. */
const ZENDESK_AUTHOR = '-1';

/** Longest message text the package format takes. */
const MAX_TEXT = 150_000;

interface Found {
  value: Json;
  location: string;
  file: string;
  pointer: string;
}

type Entry =
  | { kind: 'ticket' | 'user'; value: Json; pointer: string }
  | { kind: 'organization' }
  | { kind: 'omitted'; ids: string[] }
  | { kind: 'unknown' };

/** Lines of the file Zendesk adds for tickets over 1 MB: the ticket (or its ID) and an error. */
function omittedTickets(value: Json): string[] | null {
  if (!('error' in value) && !('errors' in value)) return null;
  const ids = new Set<string>();
  const collect = (item: unknown) => {
    if (!isObject(item)) return;
    for (const candidate of [
      item.ticket_id,
      isObject(item.ticket) ? item.ticket.id : undefined,
      item.id,
    ]) {
      const id = idOf(candidate);
      if (id) {
        ids.add(id);
        return;
      }
    }
  };
  collect(value);
  if (Array.isArray(value.errors)) value.errors.forEach(collect);
  if (isObject(value.error)) collect(value.error);
  return [...ids];
}

function classify(value: unknown): Entry[] {
  if (!isObject(value)) return [{ kind: 'unknown' }];
  const omitted = omittedTickets(value);
  if (omitted) return [{ kind: 'omitted', ids: omitted }];
  if (isObject(value.ticket)) return [{ kind: 'ticket', value: value.ticket, pointer: '/ticket' }];
  if (isObject(value.user)) return [{ kind: 'user', value: value.user, pointer: '/user' }];
  if (isObject(value.organization)) return [{ kind: 'organization' }];
  // A Support API response saved as a file: { "tickets": [...], "users": [...] }.
  if (Array.isArray(value.tickets) || Array.isArray(value.users)) {
    const list = (key: 'tickets' | 'users', kind: 'ticket' | 'user'): Entry[] =>
      (Array.isArray(value[key]) ? (value[key] as unknown[]) : []).map((item, index) =>
        isObject(item)
          ? { kind, value: item, pointer: `/${key}/${index}` }
          : { kind: 'unknown' as const },
      );
    return [...list('tickets', 'ticket'), ...list('users', 'user')];
  }
  if ('requester_id' in value || Array.isArray(value.comments)) {
    return [{ kind: 'ticket', value, pointer: '' }];
  }
  if (typeof value.role === 'string' && 'id' in value)
    return [{ kind: 'user', value, pointer: '' }];
  if ('domain_names' in value) return [{ kind: 'organization' }];
  return [{ kind: 'unknown' }];
}

const compareIds = (a: string, b: string) =>
  /^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b);

export function parseZendeskExport(files: Map<string, Uint8Array>): ParsedSource {
  const issues: Issue[] = [];
  const inventory = new FieldInventory();
  const tickets = new Map<string, Found>();
  const users = new Map<string, Found>();
  const omitted = new Set<string>();
  let truncated = false;
  let read = 0;
  let account: string | null = null;

  for (const file of [...files.keys()].sort()) {
    if (!isJsonFile(file)) {
      if (!isClutter(file))
        issues.push({ severity: 'warning', code: 'unknown_file', location: file });
      continue;
    }
    read += 1;
    const result = jsonValues(file, files.get(file) as Uint8Array, issues);
    if (result.truncated) truncated = true;
    for (const found of result.values) {
      for (const entry of classify(found.value)) {
        if (entry.kind === 'omitted') {
          for (const id of entry.ids) omitted.add(id);
          if (entry.ids.length === 0) {
            // The export reports an error that names no ticket: it is incomplete somewhere.
            truncated = true;
            issues.push({
              severity: 'warning',
              code: 'truncated',
              location: found.location,
              detail: 'the export reports an error',
            });
          }
          continue;
        }
        if (entry.kind === 'organization') {
          issues.push({
            severity: 'warning',
            code: 'unsupported_type',
            location: found.location,
            detail: 'organization',
          });
          continue;
        }
        if (entry.kind === 'unknown') {
          issues.push({ severity: 'warning', code: 'invalid_record', location: found.location });
          continue;
        }
        const location = within(found.location, entry.pointer);
        const pointer = `${found.pointer}${entry.pointer}`;
        const id = idOf(entry.value.id);
        if (entry.kind === 'user') {
          inventory.add({ user: entry.value });
          if (id && !users.has(id)) users.set(id, { value: entry.value, location, file, pointer });
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
        if (tickets.has(id)) {
          issues.push({
            severity: 'warning',
            code: 'duplicate_in_file',
            kind: 'conversation',
            sourceId: id,
            location,
          });
          continue;
        }
        inventory.add({ ticket: entry.value });
        tickets.set(id, { value: entry.value, location, file, pointer });
        const subdomain = /^https:\/\/([a-z0-9][a-z0-9-]{0,62})\.zendesk\.com\//i.exec(
          String(entry.value.url ?? ''),
        )?.[1];
        if (subdomain && !account) account = subdomain.toLowerCase();
      }
    }
  }

  // Without the users export, people who were assigned tickets or wrote internal notes (which
  // only teammates can) are known to be teammates.
  const staff = new Set<string>();
  for (const { value } of tickets.values()) {
    const assignee = idOf(value.assignee_id);
    if (assignee) staff.add(assignee);
    const submitter = idOf(value.submitter_id);
    if (submitter && submitter !== idOf(value.requester_id)) staff.add(submitter);
    if (!Array.isArray(value.comments)) continue;
    for (const comment of value.comments) {
      const author = isObject(comment) ? idOf(comment.author_id) : undefined;
      if (author && isObject(comment) && comment.public === false) staff.add(author);
    }
  }

  const contacts = new Map<string, ContactRecord>();
  const conversations: ParsedConversation[] = [];
  const attachments = new Map<string, ParsedAttachment>();
  const ordered = [...tickets.entries()].sort(
    ([a, x], [b, y]) =>
      (isoTime(x.value.created_at) ?? '').localeCompare(isoTime(y.value.created_at) ?? '') ||
      compareIds(a, b),
  );
  for (const [id, found] of ordered) {
    const ticket = found.value;
    if (ticket.status === 'deleted') {
      issues.push({
        severity: 'warning',
        code: 'unsupported_type',
        kind: 'conversation',
        sourceId: id,
        location: found.location,
        detail: 'deleted ticket',
      });
      continue;
    }
    if (omitted.has(id) || !Array.isArray(ticket.comments) || ticket.comments.length === 0) {
      truncated = true;
      issues.push({
        severity: 'warning',
        code: 'truncated',
        kind: 'conversation',
        sourceId: id,
        location: found.location,
        detail: omitted.has(id)
          ? 'comments left out of the export (ticket over 1 MB)'
          : 'no comments in the export',
      });
      continue;
    }
    const parsed = readTicket(id, found, { users, staff, contacts, attachments, issues });
    if (parsed) conversations.push(parsed);
  }

  if (conversations.length === 0) issues.push({ severity: 'error', code: 'no_conversations' });

  return {
    system: 'zendesk',
    schemaVersion: null,
    contacts: [...contacts.values()],
    conversations,
    attachments,
    issues,
    fields: inventory.observations(zendeskDescriptor.fields),
    declared: null,
    truncated,
    files: read,
    // Ticket and user IDs are unique within one Zendesk account, named by its subdomain.
    origin: { system: 'zendesk', account },
  };
}

interface TicketContext {
  users: Map<string, Found>;
  staff: Set<string>;
  contacts: Map<string, ContactRecord>;
  attachments: Map<string, ParsedAttachment>;
  issues: Issue[];
}

function readTicket(id: string, found: Found, ctx: TicketContext): ParsedConversation | null {
  const ticket = found.value;
  const { users, staff, contacts, attachments, issues } = ctx;
  const requesterId = idOf(ticket.requester_id);
  const contactId = requesterId ? `user:${requesterId}` : `ticket:${id}`;
  const requester = requesterId ? users.get(requesterId) : undefined;
  if (!contacts.has(contactId)) {
    // An emailed ticket names its sender, when the requester sent it themselves.
    const via = isObject(ticket.via) ? ticket.via : {};
    const submitterId = idOf(ticket.submitter_id);
    const from =
      via.channel === 'email' &&
      (!submitterId || submitterId === requesterId) &&
      isObject(via.source) &&
      isObject(via.source.from)
        ? via.source.from
        : {};
    const email = text(requester?.value.email, 320) ?? text(from.address, 320);
    const phone = text(requester?.value.phone, 64);
    contacts.set(contactId, {
      type: 'contact',
      id: contactId,
      source: {
        system: 'zendesk',
        id: requesterId ?? id,
        raw: requester
          ? { file: requester.file, pointer: requester.pointer }
          : { file: found.file, pointer: `${found.pointer}/requester_id` },
      },
      name: text(requester?.value.name) ?? text(from.name) ?? null,
      verified: null,
      unverified: { ...(email ? { email } : {}), ...(phone ? { phone } : {}) },
      attributes: {},
    });
  }
  const contactName = contacts.get(contactId)?.name ?? null;

  const authorOf = (
    authorId: string | undefined,
    internal: boolean,
  ): { kind: AuthorKind; name: string | null } | { unknown: string } => {
    if (authorId === ZENDESK_AUTHOR) return { kind: 'system', name: null };
    const user = authorId ? users.get(authorId) : undefined;
    if (user) {
      const kind = ROLES[String(user.value.role)];
      return kind
        ? { kind, name: text(user.value.name) ?? null }
        : { unknown: `role ${String(user.value.role).slice(0, 32)}` };
    }
    if (authorId && authorId === requesterId) return { kind: 'customer', name: contactName };
    // Only teammates can write internal notes.
    if (internal || (authorId && staff.has(authorId))) return { kind: 'agent', name: null };
    return { unknown: 'author not in the users export' };
  };

  const messages: Array<{ record: MessageRecord; index: number }> = [];
  (ticket.comments as unknown[]).forEach((raw, index) => {
    const commentId = isObject(raw) ? idOf(raw.id) : undefined;
    const messageId = `${id}:${commentId ?? `#${index}`}`;
    const pointer = `${found.pointer}/comments/${index}`;
    const where = within(found.location, `/comments/${index}`);
    const quarantine = (code: Issue['code'], detail?: string) => {
      issues.push({
        severity: 'warning',
        code,
        kind: 'message',
        sourceId: messageId,
        conversationId: id,
        location: where,
        ...(detail ? { detail } : {}),
      });
    };
    if (!isObject(raw)) {
      quarantine('invalid_record');
      return;
    }
    const createdAt = isoTime(raw.created_at);
    if (!createdAt) {
      quarantine('missing_time');
      return;
    }
    const internal = raw.public === false;
    const authorId = idOf(raw.author_id);
    const author = authorOf(authorId, internal);
    if ('unknown' in author) {
      quarantine('unsupported_sender', author.unknown);
      return;
    }
    const body =
      typeof raw.body === 'string' && raw.body.trim()
        ? raw.body
        : typeof raw.plain_body === 'string' && raw.plain_body.trim()
          ? raw.plain_body
          : null;
    if (body && body.length > MAX_TEXT) {
      quarantine('too_large', `${body.length} characters`);
      return;
    }
    const attachmentIds: string[] = [];
    if (Array.isArray(raw.attachments)) {
      raw.attachments.forEach((file, j) => {
        const info = isObject(file) ? file : {};
        const entry: AttachmentEntry = {
          id: `${messageId}:${idOf(info.id) ?? `#${j}`}`,
          messageId,
          name: text(info.file_name) ?? 'file',
          mediaType: text(info.content_type) ?? 'application/octet-stream',
          size: Math.max(0, Math.trunc(numberOf(info.size) ?? 0)),
          sha256: null,
          path: null,
          url: text(info.content_url, 2048) ?? text(info.mapped_content_url, 2048) ?? null,
        };
        if (attachmentIds.includes(entry.id)) return;
        attachmentIds.push(entry.id);
        // The export links to files; the files themselves are not in it.
        attachments.set(entry.id, { entry, bytes: null, problem: 'binary_not_in_export' });
      });
    }
    if (!body && attachmentIds.length === 0) {
      quarantine('empty_message');
      return;
    }
    messages.push({
      index,
      record: {
        type: 'message',
        id: messageId,
        source: {
          system: 'zendesk',
          id: commentId ?? messageId,
          raw: { file: found.file, pointer },
        },
        conversationId: id,
        createdAt,
        author: { kind: author.kind, name: author.name, sourceId: authorId ?? null },
        visibility: internal ? 'internal' : 'public',
        text: body,
        attachmentIds,
        sourceType: text(raw.type, 64) ?? 'Comment',
      },
    });
  });

  const firstTime = messages
    .map((m) => m.record.createdAt)
    .sort()
    .at(0);
  const startedAt = isoTime(ticket.created_at) ?? firstTime ?? null;
  if (!startedAt) {
    issues.push({
      severity: 'error',
      code: 'missing_time',
      kind: 'conversation',
      sourceId: id,
      location: found.location,
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

  const via = isObject(ticket.via) ? ticket.via : {};
  const channel = text(via.channel, 48);
  const assigneeId = idOf(ticket.assignee_id);
  const labels = Array.isArray(ticket.tags)
    ? [
        ...new Set(
          ticket.tags
            .filter((tag): tag is string => typeof tag === 'string')
            .map((tag) => tag.trim().slice(0, 64))
            .filter(Boolean),
        ),
      ].slice(0, 50)
    : [];
  const attributes: Record<string, string | number | boolean | null> = {};
  const priority = text(ticket.priority, 32);
  if (priority) attributes.zendesk_priority = priority;
  const type = text(ticket.type, 32);
  if (type) attributes.zendesk_type = type;
  const score = isObject(ticket.satisfaction_rating)
    ? text(ticket.satisfaction_rating.score, 32)
    : undefined;
  if (score && score !== 'unoffered') attributes.zendesk_satisfaction = score;

  return {
    record: {
      type: 'conversation',
      id,
      source: { system: 'zendesk', id, raw: { file: found.file, pointer: found.pointer } },
      contactId,
      status: STATUSES[String(ticket.status)] ?? 'open',
      startedAt,
      endedAt: null,
      subject: text(ticket.subject, 500) ?? text(ticket.raw_subject, 500) ?? null,
      channel: channel ? `zendesk ${channel}` : 'zendesk',
      labels,
      assignee: assigneeId
        ? { name: text(users.get(assigneeId)?.value.name) ?? null, sourceId: assigneeId }
        : null,
      declaredMessageCount: null,
      attributes,
    },
    messages: messages
      .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt) || a.index - b.index)
      .map((m) => m.record),
  };
}

export const zendeskAdapter: FileSourceAdapter = {
  descriptor: zendeskDescriptor,
  parse: parseZendeskExport,
};
