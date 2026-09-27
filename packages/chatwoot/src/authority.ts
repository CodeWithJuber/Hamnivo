import { createHmac } from 'node:crypto';
import type {
  ActorCredential,
  AppendMessageInput,
  AuthorityCapabilities,
  AuthorityContact,
  AuthorityConversationState,
  AuthorityFieldDefinition,
  AuthorityFieldType,
  AuthorityLabel,
  AuthorityMessage,
  AuthorityOwner,
  AuthoritySavedReply,
  ConversationAuthority,
  ConversationStatus,
  EnsureContactInput,
  EnsuredContact,
  StaffInboxAuthority,
} from '@hamnivo/domain';
import { type ChatwootClient, call, createChatwootClient } from './client.js';
import { timeOf, toConversation, toMessage } from './mapping.js';

export interface ChatwootInbox {
  /** Client API inbox identifier. */
  identifier: string;
  /** Inbox HMAC token used to sign contact identifiers (hmac_mandatory inboxes). */
  hmacToken: string;
}

export interface ChatwootAuthorityOptions {
  baseUrl: string;
  accountId: number;
  /** Token of the account's Hamnivo integration user (never shown to people). */
  integrationToken: string;
  /** Agent bot access token by bot id. */
  botToken: (botRef: string) => string | Promise<string>;
  /** Access token of a staff member's own Chatwoot user, so their actions keep their attribution. */
  staffToken?: (userRef: string) => Promise<string>;
  inbox: (inboxRef: string) => ChatwootInbox | Promise<ChatwootInbox>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

/** Chatwoot's `attribute_display_type`, in the order of its enum. */
const FIELD_TYPES: AuthorityFieldType[] = [
  'text',
  'number',
  'currency',
  'percent',
  'link',
  'date',
  'list',
  'checkbox',
];
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/**
 * ConversationAuthority on Chatwoot CE v4.18.0. Customer and AI messages are written with the
 * Application API so they carry `source_id` (idempotency key); the customer view comes from the
 * Client API, which excludes private notes.
 */
export class ChatwootAuthority implements ConversationAuthority, StaffInboxAuthority {
  readonly capabilities: AuthorityCapabilities = {
    messageKeys: true,
    ownerCas: false,
    multiContact: false,
    customerEdits: false,
  };

  private readonly clients = new Map<string, ChatwootClient>();
  private readonly publicClient: ChatwootClient;

  constructor(private readonly options: ChatwootAuthorityOptions) {
    this.publicClient = this.client('');
  }

  private client(token: string): ChatwootClient {
    let client = this.clients.get(token);
    if (!client) {
      client = createChatwootClient({
        baseUrl: this.options.baseUrl,
        token,
        ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      });
      this.clients.set(token, client);
    }
    return client;
  }

  private async as(actor: ActorCredential): Promise<ChatwootClient> {
    switch (actor.kind) {
      case 'integration':
        return this.client(this.options.integrationToken);
      case 'bot':
        return this.client(await this.options.botToken(actor.botRef));
      case 'staff':
        if (!this.options.staffToken) throw new Error('Staff tokens are not configured');
        return this.client(await this.options.staffToken(actor.userRef));
    }
  }

  private get integration(): ChatwootClient {
    return this.client(this.options.integrationToken);
  }

  private conversationPath(ref: string) {
    return { account_id: this.options.accountId, conversation_id: Number(ref) };
  }

  async ensureContact(input: EnsureContactInput): Promise<EnsuredContact> {
    const inbox = await this.options.inbox(input.inboxRef);
    const identifierHash = createHmac('sha256', inbox.hmacToken)
      .update(input.identifier)
      .digest('hex');
    const contact = await call<Json>(
      'createContact',
      this.publicClient.POST('/public/api/v1/inboxes/{inbox_identifier}/contacts', {
        params: { path: { inbox_identifier: inbox.identifier } },
        body: {
          // A caller-chosen source id makes retries return the same contact inbox.
          source_id: input.sourceId,
          identifier: input.identifier,
          identifier_hash: identifierHash,
          ...(input.name ? { name: input.name } : {}),
          // Only verified addresses: Chatwoot merges contacts that share an email.
          ...(input.verifiedEmail ? { email: input.verifiedEmail } : {}),
          ...(input.attributes ? { custom_attributes: input.attributes } : {}),
        } as never,
      }) as never,
    );
    return { contactRef: String(contact.id), sourceId: String(contact.source_id) };
  }

  async openConversation(input: {
    inboxRef: string;
    contactSourceId: string;
    attributes?: Record<string, unknown>;
  }) {
    const inbox = await this.options.inbox(input.inboxRef);
    const conversation = await call<Json>(
      'createConversation',
      this.publicClient.POST(
        '/public/api/v1/inboxes/{inbox_identifier}/contacts/{contact_identifier}/conversations',
        {
          params: {
            path: { inbox_identifier: inbox.identifier, contact_identifier: input.contactSourceId },
          },
          body: (input.attributes ? { custom_attributes: input.attributes } : {}) as never,
        },
      ) as never,
    );
    return { conversationRef: String(conversation.id) };
  }

  async getState(conversationRef: string): Promise<AuthorityConversationState> {
    const conversation = await call<Json>(
      'getConversation',
      this.integration.GET('/api/v1/accounts/{account_id}/conversations/{conversation_id}', {
        params: { path: this.conversationPath(conversationRef) },
      }) as never,
    );
    return toConversation(conversation);
  }

  async listMessages(
    conversationRef: string,
    options:
      | { view: 'staff'; after?: string; before?: string }
      | { view: 'customer'; contactSourceId: string; inboxRef: string },
  ): Promise<AuthorityMessage[]> {
    if (options.view === 'customer') {
      const inbox = await this.options.inbox(options.inboxRef);
      const messages = await call<unknown[]>(
        'listCustomerMessages',
        this.publicClient.GET(
          '/public/api/v1/inboxes/{inbox_identifier}/contacts/{contact_identifier}/conversations/{conversation_id}/messages',
          {
            params: {
              path: {
                inbox_identifier: inbox.identifier,
                contact_identifier: options.contactSourceId,
                conversation_id: Number(conversationRef),
              },
            },
          },
        ) as never,
      );
      return (Array.isArray(messages) ? messages : [])
        .map((m) => toMessage(m, conversationRef))
        .filter((m) => !m.private && m.direction !== 'activity');
    }
    const page = await call<Json>(
      'listMessages',
      this.integration.GET(
        '/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages',
        {
          params: {
            path: this.conversationPath(conversationRef),
            query: {
              ...(options.after ? { after: options.after } : {}),
              ...(options.before ? { before: options.before } : {}),
            } as never,
          },
        },
      ) as never,
    );
    const payload = Array.isArray(page.payload) ? page.payload : [];
    return payload.map((m) => toMessage(m, conversationRef));
  }

  async appendMessage(
    input: AppendMessageInput,
  ): Promise<{ message: AuthorityMessage; created: boolean }> {
    const actor: ActorCredential =
      input.author.kind === 'bot'
        ? { kind: 'bot', botRef: input.author.botRef }
        : input.author.kind === 'staff'
          ? { kind: 'staff', userRef: input.author.userRef }
          : { kind: 'integration' };
    const client = await this.as(actor);
    const body = {
      content: input.text,
      message_type: input.author.kind === 'customer' ? 'incoming' : 'outgoing',
      private: input.visibility === 'private',
      source_id: input.key,
      ...(input.contentAttributes ? { content_attributes: input.contentAttributes } : {}),
      ...(input.author.kind === 'bot'
        ? { sender_type: 'AgentBot', sender_id: Number(input.author.botRef) }
        : {}),
      ...(input.externalCreatedAt
        ? { external_created_at: Math.floor(input.externalCreatedAt.getTime() / 1000) }
        : {}),
    };
    const created = await call<Json>(
      'createMessage',
      client.POST('/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages', {
        params: { path: this.conversationPath(input.conversationRef) },
        body: body as never,
      }) as never,
    );
    return { message: toMessage(created, input.conversationRef), created: true };
  }

  async findByKey(
    conversationRef: string,
    key: string,
    since?: Date,
  ): Promise<AuthorityMessage | null> {
    // Chatwoot pages 20 messages backwards (oldest first within a page). Walk back from the newest
    // page until the messages predate `since` (minus five minutes of clock skew).
    const floor = since ? since.getTime() - 5 * 60_000 : Number.NEGATIVE_INFINITY;
    let before: string | undefined;
    for (let pages = 0; pages < 50; pages += 1) {
      const messages = await this.listMessages(
        conversationRef,
        before ? { view: 'staff', before } : { view: 'staff' },
      );
      const found = messages.find((m) => m.key === key);
      if (found) return found;
      const oldest = messages[0];
      if (!oldest || oldest.ref === before || oldest.createdAt.getTime() < floor) return null;
      before = oldest.ref;
    }
    return null;
  }

  async setOwner(
    conversationRef: string,
    owner: AuthorityOwner,
    actor: ActorCredential,
  ): Promise<void> {
    const client = await this.as(actor);
    const body =
      owner.kind === 'bot'
        ? { assignee_id: Number(owner.botRef), assignee_type: 'AgentBot' }
        : owner.kind === 'user'
          ? { assignee_id: Number(owner.userRef) }
          : { assignee_id: null };
    await call(
      'assignConversation',
      client.POST('/api/v1/accounts/{account_id}/conversations/{conversation_id}/assignments', {
        params: { path: this.conversationPath(conversationRef) },
        body: body as never,
      }) as never,
    );
  }

  async setStatus(
    conversationRef: string,
    status: ConversationStatus,
    actor: ActorCredential,
  ): Promise<void> {
    const client = await this.as(actor);
    await call(
      'toggleStatus',
      client.POST('/api/v1/accounts/{account_id}/conversations/{conversation_id}/toggle_status', {
        params: { path: this.conversationPath(conversationRef) },
        body: { status } as never,
      }) as never,
    );
  }

  async annotate(
    conversationRef: string,
    change: { attributes?: Record<string, unknown>; labels?: string[] },
    actor: ActorCredential,
  ): Promise<void> {
    const client = await this.as(actor);
    if (change.attributes) {
      await call(
        'setCustomAttributes',
        client.POST(
          '/api/v1/accounts/{account_id}/conversations/{conversation_id}/custom_attributes',
          {
            params: { path: this.conversationPath(conversationRef) },
            body: { custom_attributes: change.attributes } as never,
          },
        ) as never,
      );
    }
    if (change.labels) {
      await call(
        'setLabels',
        client.POST('/api/v1/accounts/{account_id}/conversations/{conversation_id}/labels', {
          params: { path: this.conversationPath(conversationRef) },
          body: { labels: change.labels } as never,
        }) as never,
      );
    }
  }

  private get accountPath() {
    return { account_id: this.options.accountId };
  }

  async listStaffMessages(
    conversationRef: string,
    page: { before?: string },
    actor: ActorCredential,
  ): Promise<AuthorityMessage[]> {
    const client = await this.as(actor);
    const result = await call<Json>(
      'listMessages',
      client.GET('/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages', {
        params: {
          path: this.conversationPath(conversationRef),
          query: (page.before ? { before: page.before } : {}) as never,
        },
      }) as never,
    );
    const payload = Array.isArray(result.payload) ? result.payload : [];
    return payload.map((m) => toMessage(m, conversationRef));
  }

  async searchMessages(
    query: string,
    page: number,
    actor: ActorCredential,
  ): Promise<AuthorityMessage[]> {
    const client = await this.as(actor);
    const result = await call<Json>(
      'searchMessages',
      client.GET('/api/v1/accounts/{account_id}/search/messages', {
        params: { path: this.accountPath, query: { q: query, page } },
      }) as never,
    );
    const payload = (result.payload ?? {}) as Json;
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    return messages.map((m) => toMessage(m));
  }

  async listLabels(actor: ActorCredential): Promise<AuthorityLabel[]> {
    const client = await this.as(actor);
    const result = await call<Json>(
      'listLabels',
      client.GET('/api/v1/accounts/{account_id}/labels', {
        params: { path: this.accountPath },
      }) as never,
    );
    const payload = Array.isArray(result.payload) ? (result.payload as Json[]) : [];
    return payload
      .filter((l) => typeof l.title === 'string')
      .map((l) => ({
        title: String(l.title),
        description: text(l.description),
        color: text(l.color),
      }));
  }

  /** Defines an account tag. Chatwoot allows this to administrators only (the integration user). */
  async createLabel(label: { title: string; description?: string; color?: string }) {
    await call(
      'createLabel',
      this.integration.POST('/api/v1/accounts/{account_id}/labels', {
        params: { path: this.accountPath },
        body: { show_on_sidebar: true, ...label } as never,
      }) as never,
    );
  }

  async listFieldDefinitions(actor: ActorCredential): Promise<AuthorityFieldDefinition[]> {
    const client = await this.as(actor);
    const result = await call<unknown>(
      'listCustomAttributeDefinitions',
      client.GET('/api/v1/accounts/{account_id}/custom_attribute_definitions', {
        // 0 = conversation attributes (1 would be contact attributes).
        params: { path: this.accountPath, query: { attribute_model: 0 } as never },
      }) as never,
    );
    return ((Array.isArray(result) ? result : []) as Json[])
      .filter((d) => d.attribute_model === 'conversation_attribute')
      .filter((d) => typeof d.attribute_key === 'string')
      .map((d) => {
        const type = String(d.attribute_display_type) as AuthorityFieldType;
        return {
          key: String(d.attribute_key),
          name: text(d.attribute_display_name) ?? String(d.attribute_key),
          type: FIELD_TYPES.includes(type) ? type : 'text',
          description: text(d.attribute_description),
          options: Array.isArray(d.attribute_values) ? d.attribute_values.map(String) : [],
        };
      });
  }

  /** Defines a conversation field (administrators only: the integration user). */
  async createFieldDefinition(input: {
    key: string;
    name: string;
    type: AuthorityFieldType;
    options?: string[];
  }) {
    await call(
      'createCustomAttributeDefinition',
      this.integration.POST('/api/v1/accounts/{account_id}/custom_attribute_definitions', {
        params: { path: this.accountPath },
        body: {
          attribute_key: input.key,
          attribute_display_name: input.name,
          attribute_display_type: FIELD_TYPES.indexOf(input.type),
          attribute_model: 0,
          ...(input.options ? { attribute_values: input.options } : {}),
        } as never,
      }) as never,
    );
  }

  async listSavedReplies(
    search: string | undefined,
    actor: ActorCredential,
  ): Promise<AuthoritySavedReply[]> {
    const client = await this.as(actor);
    const result = await call<unknown>(
      'listCannedResponses',
      client.GET('/api/v1/accounts/{account_id}/canned_responses', {
        params: { path: this.accountPath, query: (search ? { search } : {}) as never },
      }) as never,
    );
    return ((Array.isArray(result) ? result : []) as Json[]).map((r) => ({
      ref: String(r.id),
      shortCode: String(r.short_code ?? ''),
      content: String(r.content ?? ''),
    }));
  }

  async createSavedReply(
    input: { shortCode: string; content: string },
    actor: ActorCredential,
  ): Promise<AuthoritySavedReply> {
    const client = await this.as(actor);
    const created = await call<Json>(
      'createCannedResponse',
      client.POST('/api/v1/accounts/{account_id}/canned_responses', {
        params: { path: this.accountPath },
        body: { short_code: input.shortCode, content: input.content } as never,
      }) as never,
    );
    return {
      ref: String(created.id),
      shortCode: String(created.short_code ?? input.shortCode),
      content: String(created.content ?? input.content),
    };
  }

  async getContact(contactRef: string, actor: ActorCredential): Promise<AuthorityContact> {
    const client = await this.as(actor);
    const result = await call<Json>(
      'getContact',
      client.GET('/api/v1/accounts/{account_id}/contacts/{id}', {
        params: { path: { account_id: this.options.accountId, id: Number(contactRef) } },
      }) as never,
    );
    const contact = (result.payload ?? result) as Json;
    return {
      ref: String(contact.id ?? contactRef),
      name: text(contact.name),
      email: text(contact.email),
      identifier: text(contact.identifier),
      attributes: (contact.custom_attributes ?? {}) as Record<string, unknown>,
      createdAt: timeOf(contact.created_at),
      lastActivityAt: timeOf(contact.last_activity_at),
    };
  }

  async snooze(conversationRef: string, until: Date | null, actor: ActorCredential): Promise<void> {
    const client = await this.as(actor);
    await call(
      'toggleStatus',
      client.POST('/api/v1/accounts/{account_id}/conversations/{conversation_id}/toggle_status', {
        params: { path: this.conversationPath(conversationRef) },
        body: {
          status: 'snoozed',
          ...(until ? { snoozed_until: Math.floor(until.getTime() / 1000) } : {}),
        } as never,
      }) as never,
    );
  }

  async ensureTeam(name: string): Promise<{ ref: string }> {
    // Chatwoot stores team names in lower case.
    const wanted = name.trim().toLowerCase();
    const teams = await call<unknown>(
      'listTeams',
      this.integration.GET('/api/v1/accounts/{account_id}/teams', {
        params: { path: this.accountPath },
      }) as never,
    );
    const found = ((Array.isArray(teams) ? teams : []) as Json[]).find(
      (t) => String(t.name).toLowerCase() === wanted,
    );
    if (found) return { ref: String(found.id) };
    const created = await call<Json>(
      'createTeam',
      this.integration.POST('/api/v1/accounts/{account_id}/teams', {
        params: { path: this.accountPath },
        body: { name: name.trim(), allow_auto_assign: false } as never,
      }) as never,
    );
    return { ref: String(created.id) };
  }

  async addTeamMembers(teamRef: string, userRefs: string[]): Promise<void> {
    if (userRefs.length === 0) return;
    await call(
      'addTeamMembers',
      this.integration.POST('/api/v1/accounts/{account_id}/teams/{team_id}/team_members', {
        params: { path: { account_id: this.options.accountId, team_id: Number(teamRef) } },
        body: { user_ids: userRefs.map(Number) } as never,
      }) as never,
    );
  }

  async assignTeam(
    conversationRef: string,
    teamRef: string | null,
    actor: ActorCredential,
  ): Promise<void> {
    const client = await this.as(actor);
    await call(
      'assignTeam',
      client.POST('/api/v1/accounts/{account_id}/conversations/{conversation_id}/assignments', {
        params: { path: this.conversationPath(conversationRef) },
        // Chatwoot removes the team when no team matches the id.
        body: { team_id: teamRef === null ? 0 : Number(teamRef) } as never,
      }) as never,
    );
  }

  async typing(conversationRef: string, on: boolean, actor: ActorCredential): Promise<void> {
    const client = await this.as(actor);
    await call(
      'toggleTyping',
      client.POST(
        '/api/v1/accounts/{account_id}/conversations/{conversation_id}/toggle_typing_status',
        {
          params: { path: this.conversationPath(conversationRef) },
          body: { typing_status: on ? 'on' : 'off' } as never,
        },
      ) as never,
    );
  }
}
