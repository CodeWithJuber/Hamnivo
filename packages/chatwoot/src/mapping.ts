import type {
  AuthorityConversationState,
  AuthorityMessage,
  AuthorityMessageDirection,
  AuthorityOwner,
  AuthoritySender,
  ConversationStatus,
} from '@hamnivo/domain';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});
const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;

const DIRECTIONS: Record<string, AuthorityMessageDirection> = {
  '0': 'incoming',
  '1': 'outgoing',
  '2': 'activity',
  '3': 'template',
  incoming: 'incoming',
  outgoing: 'outgoing',
  activity: 'activity',
  template: 'template',
};

function sender(raw: unknown, messageType: AuthorityMessageDirection): AuthoritySender {
  const s = obj(raw);
  const ref = str(s.id);
  const name = str(s.name);
  switch (s.type) {
    case 'contact':
      return ref ? { kind: 'contact', ref, name } : { kind: 'system' };
    case 'user':
      return ref ? { kind: 'user', ref, name } : { kind: 'system' };
    case 'agent_bot':
      return ref ? { kind: 'bot', ref, name } : { kind: 'system' };
    default:
      // Incoming messages without a typed sender come from the contact.
      return messageType === 'incoming' && ref
        ? { kind: 'contact', ref, name }
        : { kind: 'system' };
  }
}

/** Chatwoot message JSON (API response or webhook) → AuthorityMessage. */
export function toMessage(raw: unknown, conversationRef?: string): AuthorityMessage {
  const m = obj(raw);
  const direction = DIRECTIONS[String(m.message_type)] ?? 'activity';
  const conversation = obj(m.conversation);
  const created =
    typeof m.created_at === 'number' ? m.created_at * 1000 : Date.parse(String(m.created_at));
  return {
    ref: String(m.id),
    conversationRef:
      conversationRef ??
      str(m.conversation_id) ??
      str(conversation.display_id) ??
      str(conversation.id) ??
      '',
    key: str(m.source_id),
    direction,
    private: m.private === true,
    text: str(m.content),
    contentAttributes: obj(m.content_attributes),
    sender: sender(m.sender, direction),
    attachments: (Array.isArray(m.attachments) ? m.attachments : []).map((a) => {
      const at = obj(a);
      return {
        ref: String(at.id),
        fileType: String(at.file_type ?? 'file'),
        url: str(at.data_url),
        size: typeof at.file_size === 'number' ? at.file_size : null,
        name: str(at.file_name) ?? null,
      };
    }),
    createdAt: new Date(Number.isFinite(created) ? created : Date.now()),
  };
}

const STATUSES = new Set<ConversationStatus>(['open', 'pending', 'resolved', 'snoozed']);

/** Chatwoot conversation JSON (API response or webhook) → AuthorityConversationState. */
export function toConversation(raw: unknown): AuthorityConversationState {
  const c = obj(raw);
  const meta = obj(c.meta);
  const assignee = obj(meta.assignee);
  let owner: AuthorityOwner = { kind: 'none' };
  if (assignee.id !== undefined && assignee.id !== null) {
    owner =
      meta.assignee_type === 'AgentBot'
        ? { kind: 'bot', botRef: String(assignee.id) }
        : { kind: 'user', userRef: String(assignee.id) };
  }
  const status = String(c.status) as ConversationStatus;
  const team = obj(meta.team);
  const sender = obj(meta.sender);
  return {
    ref: String(c.id),
    inboxRef: String(c.inbox_id),
    contactRef: str(sender.id),
    status: STATUSES.has(status) ? status : 'open',
    owner,
    teamRef: str(team.id),
    labels: Array.isArray(c.labels) ? c.labels.map(String) : [],
    attributes: obj(c.custom_attributes),
    version: typeof c.updated_at === 'number' ? c.updated_at : Number(c.timestamp ?? 0),
  };
}
