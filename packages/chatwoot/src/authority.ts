import { createHmac } from 'node:crypto';
import type {
  ActorCredential,
  AppendMessageInput,
  AuthorityAttachment,
  AuthorityCapabilities,
  AuthorityContact,
  AuthorityConversationState,
  AuthorityFieldDefinition,
  AuthorityFieldType,
  AuthorityLabel,
  AuthorityMessage,
  AuthorityOwner,
  AuthoritySavedReply,
  ContactUpdate,
  ConversationAuthority,
  ConversationPriority,
  ConversationStatus,
  EnsureContactInput,
  EnsuredContact,
  StaffInboxAuthority,
  WhatsappTemplate,
} from '@hamnivo/domain';
import { parseWhatsappTemplate } from '@hamnivo/domain';
import { type ChatwootClient, ChatwootError, call, createChatwootClient } from './client.js';
import { BLOB_PATH, timeOf, toConversation, toMessage } from './mapping.js';

/** The largest attachment the adapter downloads (Chatwoot's own limit is 40 MB). */
const DOWNLOAD_MAX_BYTES = 40 * 1024 * 1024;

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

/**
 * Chatwoot sorts a page of messages by created_at but pages by id (`before` and `after` compare
 * ids). Two messages written at nearly the same moment (activity messages come from background
 * jobs) can have their ids the other way round, so pages are put in id order: the first message is
 * then the lowest id, and `before` it never returns a message twice.
 */
const byRef = (a: AuthorityMessage, b: AuthorityMessage) => Number(a.ref) - Number(b.ref);

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

/** A Chatwoot label as a tag; `fallback` fills what a thin answer leaves out. */
function toLabel(
  label: Json,
  fallback: { ref?: string; title?: string; description?: string | null; color?: string } = {},
): AuthorityLabel {
  return {
    ref: String(label.id ?? fallback.ref ?? ''),
    title: String(label.title ?? fallback.title ?? ''),
    description: text(label.description) ?? text(fallback.description),
    color: text(label.color) ?? text(fallback.color),
  };
}

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
    customerDeletes: true,
    reactions: false,
    staffReadReceipts: true,
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

  async updateContact(contactRef: string, update: ContactUpdate): Promise<void> {
    const changes: Json = {};
    if (update.name !== undefined) changes.name = update.name ?? '';
    if (update.attributes && Object.keys(update.attributes).length > 0) {
      // Merged here, so the contact's other attributes stay whatever Chatwoot does with the rest.
      const current = await this.getContact(contactRef, { kind: 'integration' });
      changes.custom_attributes = { ...current.attributes, ...update.attributes };
    }
    if (Object.keys(changes).length === 0) return;
    await call(
      'updateContact',
      this.integration.PUT('/api/v1/accounts/{account_id}/contacts/{id}', {
        params: { path: { account_id: this.options.accountId, id: Number(contactRef) } },
        body: changes as never,
      }) as never,
    );
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

  async getState(
    conversationRef: string,
    actor?: ActorCredential,
  ): Promise<AuthorityConversationState> {
    const client = actor ? await this.as(actor) : this.integration;
    const conversation = await call<Json>(
      'getConversation',
      client.GET('/api/v1/accounts/{account_id}/conversations/{conversation_id}', {
        params: { path: this.conversationPath(conversationRef) },
      }) as never,
    );
    return toConversation(conversation);
  }

  /**
   * One page (25) of an inbox's conversations in every status, latest activity first, read by
   * the integration user (Chatwoot lists only open ones unless asked for all).
   */
  async listInboxConversations(
    inboxRef: string,
    options: { page?: number } = {},
  ): Promise<AuthorityConversationState[]> {
    const result = await call<Json>(
      'listConversations',
      this.integration.GET('/api/v1/accounts/{account_id}/conversations', {
        params: {
          path: this.accountPath,
          query: {
            inbox_id: Number(inboxRef),
            status: 'all',
            assignee_type: 'all',
            page: options.page ?? 1,
          },
        },
      }) as never,
    );
    const data = (result.data ?? {}) as Json;
    const payload = Array.isArray(data.payload) ? data.payload : [];
    return payload.map((c) => toConversation(c));
  }

  /**
   * The WhatsApp templates Chatwoot keeps for an inbox (synced from Meta), and when it last tried
   * to sync them (D14). Read live: Hamnivo keeps no copy.
   */
  async listWhatsappTemplates(
    inboxRef: string,
  ): Promise<{ templates: WhatsappTemplate[]; lastSyncedAt: Date | null }> {
    const result = await call<Json>(
      'listWhatsappMessageTemplates',
      this.integration.GET('/api/v1/accounts/{account_id}/inboxes/{id}/message_templates', {
        params: { path: { ...this.accountPath, id: Number(inboxRef) } },
      }) as never,
    );
    const payload = Array.isArray(result.payload) ? result.payload : [];
    const synced = (result.meta as Json | undefined)?.last_sync_attempt_at;
    return {
      templates: payload
        .map((t) => parseWhatsappTemplate(t))
        .filter((t): t is WhatsappTemplate => t !== null),
      lastSyncedAt: typeof synced === 'string' ? new Date(synced) : null,
    };
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
    return payload.map((m) => toMessage(m, conversationRef)).sort(byRef);
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
    const body: Record<string, unknown> = {
      content: input.text,
      message_type: input.author.kind === 'customer' ? 'incoming' : 'outgoing',
      private: input.visibility === 'private',
      source_id: input.key,
      // Kept by Chatwoot when a channel replaces source_id with the provider's id.
      content_attributes: { ...(input.contentAttributes ?? {}), hv_key: input.key },
      ...(input.author.kind === 'bot'
        ? { sender_type: 'AgentBot', sender_id: Number(input.author.botRef) }
        : {}),
      ...(input.externalCreatedAt
        ? { external_created_at: Math.floor(input.externalCreatedAt.getTime() / 1000) }
        : {}),
      ...(input.template
        ? {
            template_params: {
              name: input.template.name,
              language: input.template.language,
              category: input.template.category,
              processed_params: input.template.processedParams,
              // `content` is the rendered text, as the customer reads it.
              content_mode: 'rendered',
            },
          }
        : {}),
    };
    const created = await call<Json>(
      'createMessage',
      client.POST('/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages', {
        params: { path: this.conversationPath(input.conversationRef) },
        body: (input.attachments?.length ? multipart(body, input.attachments) : body) as never,
      }) as never,
    );
    return { message: toMessage(created, input.conversationRef), created: true };
  }

  async deleteMessage(
    conversationRef: string,
    messageRef: string,
    actor: ActorCredential,
  ): Promise<void> {
    const client = await this.as(actor);
    await call(
      'deleteMessage',
      client.DELETE(
        '/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages/{message_id}',
        {
          params: {
            path: { ...this.conversationPath(conversationRef), message_id: Number(messageRef) },
          },
        },
      ) as never,
    );
  }

  async markSeenByContact(
    conversationRef: string,
    contact: { contactSourceId: string; inboxRef: string },
  ): Promise<void> {
    const inbox = await this.options.inbox(contact.inboxRef);
    await call(
      'updateContactLastSeen',
      this.publicClient.POST(
        '/public/api/v1/inboxes/{inbox_identifier}/contacts/{contact_identifier}/conversations/{conversation_id}/update_last_seen',
        {
          params: {
            path: {
              inbox_identifier: inbox.identifier,
              contact_identifier: contact.contactSourceId,
              conversation_id: Number(conversationRef),
            },
          },
          // Chatwoot answers `head :ok`.
          parseAs: 'text',
        },
      ) as never,
    );
  }

  /**
   * Reads an attachment through ActiveStorage's proxy route on this Chatwoot's own address. Only
   * the signed blob id and file name are taken from the stored URL; its host is never contacted,
   * and redirects are refused, so a download cannot be steered anywhere else.
   */
  async downloadAttachment(
    attachment: AuthorityAttachment,
  ): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    let path: string;
    try {
      path = new URL(attachment.url ?? '').pathname;
    } catch {
      throw new ChatwootError('downloadAttachment', 404, 'The attachment has no file.');
    }
    const match = BLOB_PATH.exec(path);
    if (!match) throw new ChatwootError('downloadAttachment', 404, 'Not a Chatwoot file.');
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/rails/active_storage/blobs/proxy/${match[1]}/${match[2]}`;
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new ChatwootError(
        'downloadAttachment',
        0,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ChatwootError('downloadAttachment', response.status, null);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > DOWNLOAD_MAX_BYTES) {
      await response.body?.cancel();
      throw new ChatwootError('downloadAttachment', 413, 'The file is too large.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > DOWNLOAD_MAX_BYTES) {
      throw new ChatwootError('downloadAttachment', 413, 'The file is too large.');
    }
    return { bytes, contentType: response.headers.get('content-type') };
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
    return payload.map((m) => toMessage(m, conversationRef)).sort(byRef);
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
    return payload.filter((l) => typeof l.title === 'string').map((l) => toLabel(l));
  }

  /** Defines an account tag. Chatwoot allows this to administrators only (the integration user). */
  async createLabel(label: {
    title: string;
    description?: string;
    color?: string;
  }): Promise<AuthorityLabel> {
    const created = await call<Json>(
      'createLabel',
      this.integration.POST('/api/v1/accounts/{account_id}/labels', {
        params: { path: this.accountPath },
        body: { show_on_sidebar: true, ...label } as never,
      }) as never,
    );
    // Chatwoot keeps tags in lower case, and answers with the tag as stored.
    return toLabel(created, { ...label, title: label.title.toLowerCase() });
  }

  /**
   * Renames a tag or changes its description or colour (administrators only: the integration
   * user). Chatwoot carries a rename over to the conversations that have the tag.
   */
  async updateLabel(
    labelRef: string,
    changes: { title?: string; description?: string | null; color?: string },
  ): Promise<AuthorityLabel> {
    const updated = await call<Json>(
      'updateLabel',
      this.integration.PATCH('/api/v1/accounts/{account_id}/labels/{id}', {
        params: { path: { account_id: this.options.accountId, id: Number(labelRef) } },
        body: {
          ...(changes.title !== undefined ? { title: changes.title } : {}),
          // Chatwoot clears a description with an empty one.
          ...(changes.description !== undefined ? { description: changes.description ?? '' } : {}),
          ...(changes.color !== undefined ? { color: changes.color } : {}),
        } as never,
      }) as never,
    );
    return toLabel(updated, {
      ref: labelRef,
      ...(changes.title !== undefined ? { title: changes.title.toLowerCase() } : {}),
    });
  }

  /**
   * Deletes a tag (administrators only: the integration user). Chatwoot then takes it off the
   * conversations that carry it in a background job, writing the stored list directly: the
   * conversation's version does not move and no webhook says so.
   */
  async deleteLabel(labelRef: string): Promise<void> {
    await call(
      'deleteLabel',
      this.integration.DELETE('/api/v1/accounts/{account_id}/labels/{id}', {
        params: { path: { account_id: this.options.accountId, id: Number(labelRef) } },
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

  async updateSavedReply(
    replyRef: string,
    changes: { shortCode?: string; content?: string },
    actor: ActorCredential,
  ): Promise<AuthoritySavedReply> {
    const client = await this.as(actor);
    const updated = await call<Json>(
      'updateCannedResponse',
      client.PATCH('/api/v1/accounts/{account_id}/canned_responses/{id}', {
        params: { path: { account_id: this.options.accountId, id: Number(replyRef) } },
        body: {
          ...(changes.shortCode !== undefined ? { short_code: changes.shortCode } : {}),
          ...(changes.content !== undefined ? { content: changes.content } : {}),
        } as never,
      }) as never,
    );
    return {
      ref: String(updated.id ?? replyRef),
      shortCode: String(updated.short_code ?? changes.shortCode ?? ''),
      content: String(updated.content ?? changes.content ?? ''),
    };
  }

  async deleteSavedReply(replyRef: string, actor: ActorCredential): Promise<void> {
    const client = await this.as(actor);
    await call(
      'deleteCannedResponse',
      client.DELETE('/api/v1/accounts/{account_id}/canned_responses/{id}', {
        params: { path: { account_id: this.options.accountId, id: Number(replyRef) } },
      }) as never,
    );
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

  async setPriority(
    conversationRef: string,
    priority: ConversationPriority | null,
    actor: ActorCredential,
  ): Promise<void> {
    const client = await this.as(actor);
    await call(
      'togglePriority',
      client.POST('/api/v1/accounts/{account_id}/conversations/{conversation_id}/toggle_priority', {
        params: { path: this.conversationPath(conversationRef) },
        body: { priority } as never,
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

/**
 * A message with files as multipart form data. Chatwoot parses `content_attributes` sent as a JSON
 * string (verified on v4.18.0), so nested values keep their types.
 */
function multipart(
  fields: Record<string, unknown>,
  files: NonNullable<AppendMessageInput['attachments']>,
): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    // A message may be only files: no empty text is sent with them.
    if (value === undefined || (name === 'content' && value === '')) continue;
    form.append(
      name,
      typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value),
    );
  }
  for (const file of files) {
    form.append(
      'attachments[]',
      new Blob([Buffer.from(file.bytes)], { type: file.mimeType }),
      file.name,
    );
  }
  return form;
}
