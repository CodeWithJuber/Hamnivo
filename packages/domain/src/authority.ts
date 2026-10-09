/**
 * The conversation authority port (ADR 0001). Chatwoot CE implements it today; nothing outside the
 * adapter sees Chatwoot types. References are opaque strings owned by the authority.
 */

export interface AuthorityCapabilities {
  /** Messages can carry a client key that the authority echoes back (idempotent writes). */
  messageKeys: boolean;
  /** Ownership changes support compare-and-set (Chatwoot: no, so Hamnivo fences with an epoch). */
  ownerCas: boolean;
  /** More than one customer contact per conversation. */
  multiContact: boolean;
  /** Customers can edit sent messages. */
  customerEdits: boolean;
  /**
   * A customer's message can be deleted on their behalf (the authority keeps a "deleted" marker
   * and drops the text and files). Chatwoot: yes, through the integration user.
   */
  customerDeletes: boolean;
  /** Native message reactions (Chatwoot CE: no, so a reaction travels as a short quoted reply). */
  reactions: boolean;
  /** The authority reports when staff last saw a conversation (Chatwoot: agent_last_seen_at). */
  staffReadReceipts: boolean;
}

export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'snoozed';

/** Who performs a write; the authority applies its own attribution and permissions for it. */
export type ActorCredential =
  | { kind: 'bot'; botRef: string }
  | { kind: 'integration' }
  | { kind: 'staff'; userRef: string };

export type AuthorityOwner =
  | { kind: 'bot'; botRef: string }
  | { kind: 'user'; userRef: string }
  | { kind: 'none' };

export interface AuthorityConversationState {
  ref: string;
  inboxRef: string;
  contactRef: string | null;
  status: ConversationStatus;
  owner: AuthorityOwner;
  teamRef: string | null;
  labels: string[];
  attributes: Record<string, unknown>;
  /** Authority change clock (Chatwoot's float `updated_at`); apply state only when newer. */
  version: number;
  /** When a snoozed conversation opens again; null when it waits for the customer. */
  snoozedUntil?: Date | null;
  /** When staff last looked at the conversation, where the authority reports it. */
  staffLastSeenAt?: Date | null;
  /** The conversation's priority (H19); undefined where the authority does not report it. */
  priority?: ConversationPriority | null;
}

/** Chatwoot's priorities, most urgent first (H19). */
export const CONVERSATION_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type ConversationPriority = (typeof CONVERSATION_PRIORITIES)[number];

/** Changes to a contact after it exists (the integration user writes them). */
export interface ContactUpdate {
  name?: string | null;
  /**
   * Custom attributes, merged into the ones the contact has. Never an address the customer only
   * typed: the authority merges contacts by email, so those go into an attribute instead.
   */
  attributes?: Record<string, unknown>;
}

export type AuthorityMessageDirection = 'incoming' | 'outgoing' | 'activity' | 'template';

export type AuthoritySender =
  | { kind: 'contact'; ref: string; name: string | null }
  | { kind: 'user'; ref: string; name: string | null }
  | { kind: 'bot'; ref: string; name: string | null }
  | { kind: 'system' };

export interface AuthorityAttachment {
  ref: string;
  /** image, file, audio, video, location, contact… */
  fileType: string;
  url: string | null;
  size: number | null;
  name: string | null;
  /** The content type the authority stored, when it says. */
  mimeType?: string | null;
  /** Shared places (fileType `location`). */
  coordinates?: { latitude: number; longitude: number } | null;
  /** The authority's text for places and contacts (a place name, a phone number). */
  fallbackTitle?: string | null;
  /** Extra values the authority keeps, such as a shared contact's names. */
  meta?: Record<string, unknown>;
}

/** A file to send with a message (already type-checked and scanned by the caller). */
export interface OutgoingAttachment {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface AuthorityMessage {
  ref: string;
  conversationRef: string;
  /** The idempotency key Hamnivo wrote (`hv1:…`), or null for messages created elsewhere. */
  key: string | null;
  direction: AuthorityMessageDirection;
  private: boolean;
  text: string | null;
  contentAttributes: Record<string, unknown>;
  sender: AuthoritySender;
  attachments: AuthorityAttachment[];
  createdAt: Date;
}

export type MessageAuthor =
  | { kind: 'customer' }
  | { kind: 'bot'; botRef: string }
  | { kind: 'staff'; userRef: string }
  | { kind: 'integration' };

export interface AppendMessageInput {
  conversationRef: string;
  /** Idempotency key, echoed by the authority (Chatwoot `source_id`). */
  key: string;
  author: MessageAuthor;
  visibility: 'public' | 'private';
  text: string;
  contentAttributes?: Record<string, unknown>;
  /** Original time for imported history. */
  externalCreatedAt?: Date;
  /** Files that travel with the message; the authority owns them afterwards. */
  attachments?: OutgoingAttachment[];
}

export interface EnsureContactInput {
  inboxRef: string;
  /** Stable identity (`hv:{brand}:{sub}` or `hv:anon:{principal}`). */
  identifier: string;
  /**
   * Secret contact-inbox id that Hamnivo generates and stores encrypted before the call (it grants
   * customer-API access to the conversations). Retrying with the same value is idempotent.
   */
  sourceId: string;
  name?: string | null;
  /** Only verified addresses; the authority merges contacts by email. */
  verifiedEmail?: string | null;
  attributes?: Record<string, unknown>;
}

export interface EnsuredContact {
  contactRef: string;
  /** The contact-inbox id in effect (equal to the requested one). */
  sourceId: string;
}

export type AuthorityEvent =
  | { type: 'message.created' | 'message.updated'; accountRef: string; message: AuthorityMessage }
  | {
      type: 'conversation.created' | 'conversation.updated' | 'conversation.status_changed';
      accountRef: string;
      conversation: AuthorityConversationState;
    }
  | {
      type: 'conversation.typing';
      accountRef: string;
      conversationRef: string;
      on: boolean;
      userRef: string | null;
    }
  | {
      type: 'contact.created' | 'contact.updated';
      accountRef: string;
      contactRef: string;
      identifier: string | null;
    }
  | { type: 'unknown'; accountRef: string | null; name: string };

export interface ConversationAuthority {
  readonly capabilities: AuthorityCapabilities;
  ensureContact(input: EnsureContactInput): Promise<EnsuredContact>;
  /** Renames a contact or adds attributes to it, such as answers to a pre-chat form (W26). */
  updateContact(contactRef: string, update: ContactUpdate): Promise<void>;
  openConversation(input: {
    inboxRef: string;
    contactSourceId: string;
    attributes?: Record<string, unknown>;
  }): Promise<{ conversationRef: string }>;
  /** Current state, read as the integration user unless an actor is given. */
  getState(conversationRef: string, actor?: ActorCredential): Promise<AuthorityConversationState>;
  /** `customer` view excludes private notes and activity; newest last. */
  listMessages(
    conversationRef: string,
    options:
      | { view: 'staff'; after?: string; before?: string }
      | { view: 'customer'; contactSourceId: string; inboxRef: string },
  ): Promise<AuthorityMessage[]>;
  appendMessage(
    input: AppendMessageInput,
  ): Promise<{ message: AuthorityMessage; created: boolean }>;
  /** Looks for a message written with this key (resolves `unknown` outcomes after timeouts). */
  findByKey(conversationRef: string, key: string, since?: Date): Promise<AuthorityMessage | null>;
  /**
   * Bot → the bot owns it and the conversation is pending; user → that person owns it (a pending
   * conversation owned by a bot opens); none → nobody owns it and the status is left as is.
   */
  setOwner(conversationRef: string, owner: AuthorityOwner, actor: ActorCredential): Promise<void>;
  setStatus(
    conversationRef: string,
    status: ConversationStatus,
    actor: ActorCredential,
  ): Promise<void>;
  annotate(
    conversationRef: string,
    change: { attributes?: Record<string, unknown>; labels?: string[] },
    actor: ActorCredential,
  ): Promise<void>;
  typing(conversationRef: string, on: boolean, actor: ActorCredential): Promise<void>;
  /**
   * Deletes a message: its text and files are removed and it stays as a "deleted" marker. Only
   * when `capabilities.customerDeletes`; callers check who may delete what.
   */
  deleteMessage(conversationRef: string, messageRef: string, actor: ActorCredential): Promise<void>;
  /** Records that the contact saw the conversation, so staff see their replies as read. */
  markSeenByContact(
    conversationRef: string,
    contact: { contactSourceId: string; inboxRef: string },
  ): Promise<void>;
  /**
   * The bytes of an attachment from a message listed by this authority. Only the authority's own
   * address is ever fetched; anything else is refused.
   */
  downloadAttachment(
    attachment: AuthorityAttachment,
  ): Promise<{ bytes: Uint8Array; contentType: string | null }>;
}

/**
 * Message keys Hamnivo writes: `hv1:m:` customer/staff messages, `hv1:p:` AI publications,
 * `hv1:a:` messages from automations (G21).
 */
export const MESSAGE_KEY_PREFIX = {
  message: 'hv1:m:',
  publication: 'hv1:p:',
  note: 'hv1:n:',
  automation: 'hv1:a:',
  import: 'hv1:imp:',
} as const;

export function isHamnivoKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && key.startsWith('hv1:');
}
