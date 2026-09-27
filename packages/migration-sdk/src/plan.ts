import type { ItemStatus } from './checkpoint.js';
import { type ItemKind, type ParsedSource, REASONS, type Reason } from './types.js';

/** One object of an export as a job tracks it: no content, only IDs and status. */
export interface PlannedItem {
  kind: ItemKind;
  sourceId: string;
  /** The conversation a message or attachment belongs to. */
  conversationSourceId: string | null;
  /** Order: conversations in import order, messages in time order within their conversation. */
  seq: number;
  status: Extract<ItemStatus, 'pending' | 'skipped' | 'quarantined'>;
  reason: Reason | null;
  /** Internal notes, which must stay private. */
  private: boolean;
}

/** Sequence for objects that were never placed in a conversation (fits a 32-bit column). */
const LAST_SEQ = 2_000_000_000;

/** Issues that keep an object out of the import (it is quarantined with this reason). */
const QUARANTINE = new Set<string>([
  'invalid_record',
  'missing_time',
  'unsupported_type',
  'unsupported_sender',
  'missing_conversation',
  'missing_contact',
  'empty_message',
  'parent_failed',
  'too_large',
  'truncated',
]);

const asReason = (code: string): Reason =>
  (REASONS as readonly string[]).includes(code) ? (code as Reason) : 'invalid_record';

/**
 * Every object found in the export becomes exactly one item, so the reconciliation can account
 * for each: pending (to import), skipped (already imported by an earlier job) or quarantined
 * (cannot be imported, with the reason).
 */
export function planItems(
  parsed: ParsedSource,
  existing: { conversations: ReadonlySet<string> } = { conversations: new Set() },
): PlannedItem[] {
  const items: PlannedItem[] = [];
  const seen = new Set<string>();
  const add = (item: PlannedItem) => {
    const key = `${item.kind}\u0000${item.sourceId}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  const neededContacts = new Set<string>();
  const skippedContacts = new Set<string>();

  parsed.conversations.forEach((conversation, index) => {
    const id = conversation.record.id;
    const duplicate = existing.conversations.has(id);
    // A conversation none of whose messages can be imported would arrive empty.
    const empty = conversation.messages.length === 0;
    if (duplicate) skippedContacts.add(conversation.record.contactId);
    else if (!empty) neededContacts.add(conversation.record.contactId);
    const status = duplicate ? 'skipped' : 'pending';
    const reason: Reason | null = duplicate ? 'duplicate_existing' : null;
    add({
      kind: 'conversation',
      sourceId: id,
      conversationSourceId: id,
      seq: index,
      status: empty && !duplicate ? 'quarantined' : status,
      reason: empty && !duplicate ? 'empty_message' : reason,
      private: false,
    });
    conversation.messages.forEach((message, position) => {
      add({
        kind: 'message',
        sourceId: message.id,
        conversationSourceId: id,
        seq: position,
        status,
        reason,
        private: message.visibility === 'internal',
      });
      for (const attachmentId of message.attachmentIds) {
        const attachment = parsed.attachments.get(attachmentId);
        const problem = attachment?.problem ?? (attachment ? null : 'missing_attachment');
        add({
          kind: 'attachment',
          sourceId: attachmentId,
          conversationSourceId: id,
          seq: position,
          status: duplicate ? 'skipped' : problem ? 'quarantined' : 'pending',
          reason: duplicate ? 'duplicate_existing' : problem,
          private: message.visibility === 'internal',
        });
      }
    });
  });

  // Objects the reader could not use, each with its reason.
  for (const issue of parsed.issues) {
    if (!issue.kind || !issue.sourceId || !QUARANTINE.has(issue.code)) continue;
    add({
      kind: issue.kind,
      sourceId: issue.sourceId,
      conversationSourceId:
        issue.kind === 'conversation' ? issue.sourceId : (issue.conversationId ?? null),
      seq: LAST_SEQ,
      status: 'quarantined',
      reason: asReason(issue.code),
      private: false,
    });
  }

  parsed.contacts.forEach((contact, index) => {
    const needed = neededContacts.has(contact.id);
    add({
      kind: 'contact',
      sourceId: contact.id,
      conversationSourceId: null,
      seq: index,
      status: needed ? 'pending' : 'skipped',
      reason: needed
        ? null
        : skippedContacts.has(contact.id)
          ? 'duplicate_existing'
          : 'not_referenced',
      private: false,
    });
  });
  return items;
}

export interface DryRunCounts {
  total: number;
  ready: number;
  duplicates: number;
  needsReview: number;
}

export interface DryRun {
  conversations: DryRunCounts;
  messages: DryRunCounts & { internal: number };
  contacts: DryRunCounts;
  attachments: DryRunCounts;
  /** The same source ID more than once in the export (the later copies are ignored). */
  duplicatesInFile: number;
  /** Records the reader could not even identify (for example unreadable lines). */
  unidentified: number;
  identity: { verified: number; unverified: number };
  truncated: boolean;
  /** Conversations to show as samples (IDs only). */
  samples: string[];
}

/** What an import would do, computed without writing anything (the dry run, HNV-18-03). */
export function dryRun(
  parsed: ParsedSource,
  existing: { conversations: ReadonlySet<string> } = { conversations: new Set() },
  sampleSize = 3,
): DryRun {
  const items = planItems(parsed, existing);
  const count = (kind: ItemKind): DryRunCounts => {
    const own = items.filter((i) => i.kind === kind);
    return {
      total: own.length,
      ready: own.filter((i) => i.status === 'pending').length,
      duplicates: own.filter((i) => i.reason === 'duplicate_existing').length,
      needsReview: own.filter((i) => i.status === 'quarantined').length,
    };
  };
  const ready = new Set(
    items.filter((i) => i.kind === 'contact' && i.status === 'pending').map((i) => i.sourceId),
  );
  const contacts = parsed.contacts.filter((c) => ready.has(c.id));
  return {
    conversations: count('conversation'),
    messages: {
      ...count('message'),
      internal: items.filter((i) => i.kind === 'message' && i.private && i.status === 'pending')
        .length,
    },
    contacts: count('contact'),
    attachments: count('attachment'),
    duplicatesInFile: parsed.issues.filter((i) => i.code === 'duplicate_in_file').length,
    unidentified: parsed.issues.filter(
      (i) => !i.sourceId && ['invalid_json', 'invalid_record', 'truncated_file'].includes(i.code),
    ).length,
    identity: {
      verified: contacts.filter((c) => c.verified).length,
      unverified: contacts.filter((c) => !c.verified).length,
    },
    truncated: parsed.truncated,
    samples: items
      .filter((i) => i.kind === 'conversation' && i.status === 'pending')
      .slice(0, sampleSize)
      .map((i) => i.sourceId),
  };
}
