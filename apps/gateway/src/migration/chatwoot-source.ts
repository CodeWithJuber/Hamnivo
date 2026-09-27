import type { ChatwootImporter } from '@hamnivo/chatwoot';
import type { AuthorityMessage } from '@hamnivo/domain';
import type {
  ContactRecord,
  ConversationRecord,
  MessageRecord,
  PackageAttachmentInput,
} from '@hamnivo/migration-sdk';
import { fileTypeFromBuffer } from 'file-type';

const STATUSES = new Set(['open', 'pending', 'resolved', 'snoozed']);

export interface ChatwootReadLimits {
  maxConversations: number;
  maxAttachmentBytes: number;
}

export interface ChatwootHistory {
  contacts: ContactRecord[];
  conversations: ConversationRecord[];
  messages: MessageRecord[];
  attachments: PackageAttachmentInput[];
  /** Activity messages (status changes and the like) are events, not conversation content. */
  skippedActivity: number;
  /** More conversations exist than the limit allowed. */
  truncated: boolean;
}

function flatAttributes(value: Record<string, unknown>) {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key)) continue;
    out[key] =
      item === null || typeof item === 'number' || typeof item === 'boolean'
        ? item
        : String(item).slice(0, 2000);
  }
  return out;
}

function authorOf(message: AuthorityMessage): MessageRecord['author'] {
  switch (message.sender.kind) {
    case 'contact':
      return { kind: 'customer', name: message.sender.name };
    case 'user':
      return { kind: 'agent', name: message.sender.name, sourceId: message.sender.ref };
    case 'bot':
      return { kind: 'bot', name: message.sender.name, sourceId: message.sender.ref };
    default:
      return { kind: message.direction === 'incoming' ? 'customer' : 'system' };
  }
}

/**
 * Reads conversations of some inboxes of a Chatwoot account into canonical records: the export
 * of a brand's history in the package format (M02), and the Chatwoot source adapter (M04). Pages
 * through conversations (25 at a time) and each conversation's messages (100 at a time); files
 * are downloaded from that Chatwoot only, and a file that cannot be downloaded stays listed.
 */
export async function readChatwootHistory(
  client: ChatwootImporter,
  options: { inboxIds: number[]; system: string; brandPublicId?: string } & ChatwootReadLimits,
): Promise<ChatwootHistory> {
  const history: ChatwootHistory = {
    contacts: [],
    conversations: [],
    messages: [],
    attachments: [],
    skippedActivity: 0,
    truncated: false,
  };
  const contacts = new Map<number, ContactRecord>();
  for (const inboxId of options.inboxIds) {
    for (let page = 1; ; page += 1) {
      const { conversations } = await client.listConversations({ page, inboxId });
      if (conversations.length === 0) break;
      for (const conversation of conversations) {
        if (history.conversations.length >= options.maxConversations) {
          history.truncated = true;
          break;
        }
        const conversationId = String(conversation.id);
        if (conversation.contactId !== null && !contacts.has(conversation.contactId)) {
          const contact = await client.getContact(conversation.contactId);
          const prefix = options.brandPublicId ? `hv:${options.brandPublicId}:` : null;
          const subject =
            prefix && contact?.identifier?.startsWith(prefix)
              ? contact.identifier.slice(prefix.length)
              : null;
          contacts.set(conversation.contactId, {
            type: 'contact',
            id: `contact:${conversation.contactId}`,
            source: { system: options.system, id: String(conversation.contactId) },
            name: contact?.name ?? null,
            verified: subject ? { subject, issuer: options.brandPublicId } : null,
            unverified: {
              ...(contact?.email ? { email: contact.email } : {}),
              ...(contact?.phone ? { phone: contact.phone } : {}),
            },
            attributes: flatAttributes(contact?.attributes ?? {}),
          });
        }
        const messages = await client.listMessages(conversation.id);
        const records: MessageRecord[] = [];
        for (const message of messages) {
          if (message.direction === 'activity' || message.direction === 'template') {
            history.skippedActivity += 1;
            continue;
          }
          const original = Number(message.contentAttributes.external_created_at);
          const createdAt =
            Number.isFinite(original) && original > 0
              ? new Date(original * 1000)
              : message.createdAt;
          const attachmentIds: string[] = [];
          for (const attachment of message.attachments.slice(0, 20)) {
            const id = `attachment:${attachment.ref}`;
            attachmentIds.push(id);
            const bytes = attachment.url
              ? await client.download(attachment.url, options.maxAttachmentBytes).catch(() => null)
              : null;
            const name =
              attachment.name ??
              decodeURIComponent(attachment.url?.split('/').pop()?.split('?')[0] ?? 'file');
            const sniffed = bytes ? await fileTypeFromBuffer(bytes) : undefined;
            history.attachments.push({
              id,
              messageId: `message:${message.ref}`,
              name: name || 'file',
              mediaType: sniffed?.mime ?? 'application/octet-stream',
              bytes,
              url: null,
              size: attachment.size ?? 0,
            });
          }
          records.push({
            type: 'message',
            id: `message:${message.ref}`,
            source: {
              system: options.system,
              id: message.ref,
              raw: { file: `conversations/${conversationId}` },
            },
            conversationId: `conversation:${conversationId}`,
            createdAt: createdAt.toISOString(),
            author: authorOf(message),
            visibility: message.private ? 'internal' : 'public',
            text: message.text,
            attachmentIds,
          });
        }
        history.messages.push(...records);
        const first = records[0]?.createdAt ?? conversation.createdAt.toISOString();
        history.conversations.push({
          type: 'conversation',
          id: `conversation:${conversationId}`,
          source: { system: options.system, id: conversationId },
          contactId: `contact:${conversation.contactId ?? 0}`,
          status: STATUSES.has(conversation.status)
            ? (conversation.status as ConversationRecord['status'])
            : 'open',
          startedAt:
            first < conversation.createdAt.toISOString()
              ? first
              : conversation.createdAt.toISOString(),
          labels: [],
          attributes: flatAttributes(conversation.attributes),
        });
        if (conversation.contactId === null && !contacts.has(0)) {
          contacts.set(0, {
            type: 'contact',
            id: 'contact:0',
            source: { system: options.system, id: '0' },
            name: null,
            verified: null,
            unverified: {},
            attributes: {},
          });
        }
      }
      if (history.truncated || conversations.length < 25) break;
    }
  }
  history.contacts = [...contacts.values()];
  return history;
}
