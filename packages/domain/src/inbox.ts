import type { ActorCredential, AuthorityMessage, ConversationPriority } from './authority.js';

/**
 * Staff inbox operations on the conversation authority (H03–H07, H10). Every call names the actor,
 * so the authority applies its own attribution and permissions: staff read and act with their own
 * user, and only account set-up (teams) uses the integration user. No Chatwoot type crosses it.
 */

/** A tag the account defined (Chatwoot label). */
export interface AuthorityLabel {
  /** The authority's own id for it, needed to rename or remove it. */
  ref: string;
  title: string;
  description: string | null;
  color: string | null;
}

export type AuthorityFieldType =
  | 'text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'link'
  | 'date'
  | 'list'
  | 'checkbox';

/** A custom conversation field the account defined. */
export interface AuthorityFieldDefinition {
  key: string;
  name: string;
  type: AuthorityFieldType;
  description: string | null;
  options: string[];
}

/** A saved reply (Chatwoot canned response). */
export interface AuthoritySavedReply {
  ref: string;
  shortCode: string;
  content: string;
}

export interface AuthorityContact {
  ref: string;
  name: string | null;
  /** Whatever the authority holds; Hamnivo only ever writes verified addresses here. */
  email: string | null;
  identifier: string | null;
  attributes: Record<string, unknown>;
  createdAt: Date | null;
  lastActivityAt: Date | null;
}

export interface StaffInboxAuthority {
  /** Messages as staff see them (notes and activity included), a page of up to 20, oldest first. */
  listStaffMessages(
    conversationRef: string,
    page: { before?: string },
    actor: ActorCredential,
  ): Promise<AuthorityMessage[]>;
  /** Messages matching a text query in conversations the actor may read, newest first. */
  searchMessages(query: string, page: number, actor: ActorCredential): Promise<AuthorityMessage[]>;
  listLabels(actor: ActorCredential): Promise<AuthorityLabel[]>;
  /** Defines a tag. The authority allows this to administrators only, so it is the integration user. */
  createLabel(label: {
    title: string;
    description?: string;
    color?: string;
  }): Promise<AuthorityLabel>;
  /**
   * Renames a tag or changes its description or colour (integration user). A rename is carried
   * over by the authority to the conversations that have the tag; a null description clears it.
   */
  updateLabel(
    labelRef: string,
    changes: { title?: string; description?: string | null; color?: string },
  ): Promise<AuthorityLabel>;
  /**
   * Deletes a tag (integration user). The authority also takes it off the conversations that carry
   * it, a little later and without announcing it, so a copy of their tags must be updated by the
   * caller.
   */
  deleteLabel(labelRef: string): Promise<void>;
  listFieldDefinitions(actor: ActorCredential): Promise<AuthorityFieldDefinition[]>;
  listSavedReplies(
    search: string | undefined,
    actor: ActorCredential,
  ): Promise<AuthoritySavedReply[]>;
  createSavedReply(
    input: { shortCode: string; content: string },
    actor: ActorCredential,
  ): Promise<AuthoritySavedReply>;
  updateSavedReply(
    replyRef: string,
    changes: { shortCode?: string; content?: string },
    actor: ActorCredential,
  ): Promise<AuthoritySavedReply>;
  deleteSavedReply(replyRef: string, actor: ActorCredential): Promise<void>;
  getContact(contactRef: string, actor: ActorCredential): Promise<AuthorityContact>;
  /** Snooze until a time; without one, until the customer writes. */
  snooze(conversationRef: string, until: Date | null, actor: ActorCredential): Promise<void>;
  /** Sets the priority, or clears it with null (H19). */
  setPriority(
    conversationRef: string,
    priority: ConversationPriority | null,
    actor: ActorCredential,
  ): Promise<void>;
  /** A team with this name in the account, created when missing (integration user). */
  ensureTeam(name: string): Promise<{ ref: string }>;
  addTeamMembers(teamRef: string, userRefs: string[]): Promise<void>;
  assignTeam(
    conversationRef: string,
    teamRef: string | null,
    actor: ActorCredential,
  ): Promise<void>;
}
