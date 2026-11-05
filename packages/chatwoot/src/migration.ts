import type { AuthorityMessage } from '@hamnivo/domain';
import { ChatwootError } from './client.js';
import { toMessage } from './mapping.js';

/**
 * Writes imported history into Chatwoot (M03–M08) through the Application API, as the account's
 * integration user. Imports go to a dedicated API inbox with no webhook, no agent bot, no
 * auto-assignment, no greeting and no satisfaction survey, and contacts never get an email or phone
 * number, so Chatwoot has nothing to reply to and nobody to email. Verified against v4.18.0-ce:
 * - `external_created_at` only lands in `content_attributes`; Chatwoot keeps its own `created_at`
 *   and orders by it, so messages are written in their original order.
 * - A top-level `external_created_at` is dropped when `content_attributes` is sent too, so the
 *   original time always travels inside `content_attributes` as well.
 * - `source_id` is stored and echoed, which makes every write findable after a timeout.
 */

type Json = Record<string, unknown>;
const obj = (value: unknown): Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export interface ChatwootImportOptions {
  baseUrl: string;
  accountId: number;
  /** The account's integration user (an administrator) or, for reading a source, its token. */
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Who the token belongs to in the account: what reading a source can see depends on it. */
export interface ChatwootTokenAccess {
  /** `administrator`, `agent`, or null when the token has no access to the account. */
  role: string | null;
}

export interface ImportInboxSettings {
  webhookUrl: string | null;
  agentBot: boolean;
  autoAssignment: boolean;
  greeting: boolean;
  csat: boolean;
  workingHours: boolean;
  lockToSingleConversation: boolean;
}

export interface AutomationRuleInfo {
  id: number;
  name: string;
  event: string;
  active: boolean;
  /** Inbox IDs the rule is limited to by an `inbox_id equal_to` condition; null = every inbox. */
  inboxIds: number[] | null;
  /** Inbox IDs the rule excludes with `inbox_id not_equal_to`. */
  excludedInboxIds: number[];
}

export interface IntegrationHookInfo {
  app: string;
  /** The inbox the hook is limited to, or null for the whole account. */
  inboxId: number | null;
  enabled: boolean;
}

export interface ImportFile {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface ImportMessageInput {
  conversationId: number;
  /** `source_id` (hv1:imp:<job>:<source id>). */
  key: string;
  direction: 'incoming' | 'outgoing';
  private: boolean;
  text: string | null;
  /** Original time in the source. */
  createdAt: Date;
  contentAttributes?: Json;
  files?: ImportFile[];
}

export interface ChatwootConversationInfo {
  id: number;
  inboxId: number;
  contactId: number | null;
  status: string;
  attributes: Json;
  createdAt: Date;
  /** Chatwoot's last activity (the latest message, or the creation time); null when absent. */
  lastActivityAt: Date | null;
}

export interface ChatwootContactInfo {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  identifier: string | null;
  attributes: Json;
}

function conversationInfo(raw: unknown): ChatwootConversationInfo {
  const c = obj(raw);
  const sender = obj(obj(c.meta).sender);
  return {
    id: Number(c.id),
    inboxId: Number(c.inbox_id),
    contactId: sender.id === undefined ? null : Number(sender.id),
    status: String(c.status ?? ''),
    attributes: obj(c.custom_attributes),
    createdAt: new Date(Number(c.created_at ?? 0) * 1000),
    lastActivityAt:
      c.last_activity_at === undefined || c.last_activity_at === null
        ? null
        : new Date(Number(c.last_activity_at) * 1000),
  };
}

function contactInfo(raw: unknown): ChatwootContactInfo {
  const c = obj(raw);
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  return {
    id: Number(c.id),
    name: text(c.name),
    email: text(c.email),
    phone: text(c.phone_number),
    identifier: text(c.identifier),
    attributes: obj(c.custom_attributes),
  };
}

export class ChatwootImporter {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ChatwootImportOptions) {
    this.base = `${options.baseUrl.replace(/\/$/, '')}/api/v1/accounts/${options.accountId}`;
    this.fetcher = options.fetch ?? fetch;
  }

  private async request(
    operation: string,
    method: string,
    path: string,
    body?: Json | FormData,
    query?: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      api_access_token: this.options.token,
      accept: 'application/json',
    };
    let payload: string | FormData | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new ChatwootError(operation, 0, error instanceof Error ? error.message : String(error));
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) throw new ChatwootError(operation, response.status, json);
    return json;
  }

  /** Creates the brand's import inbox: an API channel without webhook, bot or automations. */
  async createImportInbox(name: string): Promise<{ inboxId: number }> {
    const inbox = obj(
      await this.request('createImportInbox', 'POST', '/inboxes', {
        name,
        enable_auto_assignment: false,
        greeting_enabled: false,
        csat_survey_enabled: false,
        working_hours_enabled: false,
        lock_to_single_conversation: false,
        enable_email_collect: false,
        channel: { type: 'api' },
      }),
    );
    return { inboxId: Number(inbox.id) };
  }

  async inspectInbox(inboxId: number): Promise<ImportInboxSettings> {
    const inbox = obj(await this.request('getInbox', 'GET', `/inboxes/${inboxId}`));
    const bot = obj(await this.request('getInboxAgentBot', 'GET', `/inboxes/${inboxId}/agent_bot`));
    const webhook =
      typeof inbox.webhook_url === 'string' && inbox.webhook_url ? inbox.webhook_url : null;
    return {
      webhookUrl: webhook,
      agentBot: Object.keys(obj(bot.agent_bot)).length > 0,
      autoAssignment: inbox.enable_auto_assignment === true,
      greeting: inbox.greeting_enabled === true,
      csat: inbox.csat_survey_enabled === true,
      workingHours: inbox.working_hours_enabled === true,
      lockToSingleConversation: inbox.lock_to_single_conversation === true,
    };
  }

  async listAutomationRules(): Promise<AutomationRuleInfo[]> {
    const rules = list(
      obj(await this.request('listAutomationRules', 'GET', '/automation_rules')).payload,
    );
    return rules.map((raw) => {
      const rule = obj(raw);
      const inboxConditions = list(rule.conditions)
        .map(obj)
        .filter((c) => c.attribute_key === 'inbox_id');
      const ids = (c: Json) => list(c.values).map((v) => Number(obj(v).id ?? v));
      const limited = inboxConditions.filter((c) => c.filter_operator === 'equal_to');
      return {
        id: Number(rule.id),
        name: String(rule.name ?? ''),
        event: String(rule.event_name ?? ''),
        active: rule.active === true,
        inboxIds: limited.length > 0 ? limited.flatMap(ids) : null,
        excludedInboxIds: inboxConditions
          .filter((c) => c.filter_operator === 'not_equal_to')
          .flatMap(ids),
      };
    });
  }

  async listIntegrationHooks(): Promise<IntegrationHookInfo[]> {
    const apps = list(
      obj(await this.request('listIntegrationApps', 'GET', '/integrations/apps')).payload,
    );
    return apps.flatMap((raw) => {
      const app = obj(raw);
      return list(app.hooks).map((h) => {
        const hook = obj(h);
        const inbox = obj(hook.inbox);
        return {
          app: String(app.id ?? hook.app_id ?? 'unknown'),
          inboxId: inbox.id === undefined ? null : Number(inbox.id),
          enabled: hook.status !== 'disabled' && hook.status !== false,
        };
      });
    });
  }

  /** A contact without email or phone (Chatwoot cannot merge or message it). */
  async createContact(input: {
    inboxId: number;
    identifier: string;
    name: string | null;
    attributes: Json;
  }): Promise<{ contactId: number; contactInboxSourceId: string | null }> {
    const result = obj(
      obj(
        await this.request('createContact', 'POST', '/contacts', {
          inbox_id: input.inboxId,
          identifier: input.identifier,
          name: input.name ?? 'Imported visitor',
          custom_attributes: input.attributes,
        }),
      ).payload,
    );
    const contactInbox = obj(result.contact_inbox);
    return {
      contactId: Number(obj(result.contact).id),
      contactInboxSourceId:
        typeof contactInbox.source_id === 'string' ? contactInbox.source_id : null,
    };
  }

  async findContactByIdentifier(identifier: string): Promise<number | null> {
    const found = list(
      obj(
        await this.request('searchContacts', 'GET', '/contacts/search', undefined, {
          q: identifier,
        }),
      ).payload,
    )
      .map(obj)
      .find((c) => c.identifier === identifier);
    return found ? Number(found.id) : null;
  }

  async getContact(contactId: number): Promise<ChatwootContactInfo | null> {
    try {
      const result = obj(await this.request('getContact', 'GET', `/contacts/${contactId}`));
      return contactInfo(result.payload ?? result);
    } catch (error) {
      if (error instanceof ChatwootError && error.status === 404) return null;
      throw error;
    }
  }

  /** An open conversation; its key attribute finds it again after a timeout. */
  async createConversation(input: {
    inboxId: number;
    contactId: number;
    contactInboxSourceId?: string | null;
    key: string;
    attributes: Json;
  }): Promise<{ conversationId: number }> {
    const conversation = obj(
      await this.request('createConversation', 'POST', '/conversations', {
        inbox_id: input.inboxId,
        contact_id: input.contactId,
        ...(input.contactInboxSourceId ? { source_id: input.contactInboxSourceId } : {}),
        status: 'open',
        custom_attributes: { ...input.attributes, hv_import_key: input.key },
      }),
    );
    return { conversationId: Number(conversation.id) };
  }

  async listContactConversations(contactId: number): Promise<ChatwootConversationInfo[]> {
    const result = obj(
      await this.request('listContactConversations', 'GET', `/contacts/${contactId}/conversations`),
    );
    return list(result.payload).map(conversationInfo);
  }

  async findConversation(contactId: number, key: string): Promise<number | null> {
    const found = (await this.listContactConversations(contactId)).find(
      (c) => c.attributes.hv_import_key === key,
    );
    return found ? found.id : null;
  }

  async getConversation(conversationId: number): Promise<ChatwootConversationInfo | null> {
    try {
      return conversationInfo(
        await this.request('getConversation', 'GET', `/conversations/${conversationId}`),
      );
    } catch (error) {
      if (error instanceof ChatwootError && error.status === 404) return null;
      throw error;
    }
  }

  /** Writes one message with its original time and key; files go as multipart attachments. */
  async postMessage(input: ImportMessageInput): Promise<AuthorityMessage> {
    const external = Math.floor(input.createdAt.getTime() / 1000);
    const attributes = { ...input.contentAttributes, external_created_at: external };
    const path = `/conversations/${input.conversationId}/messages`;
    let created: unknown;
    if (input.files && input.files.length > 0) {
      const form = new FormData();
      if (input.text) form.set('content', input.text);
      form.set('message_type', input.direction);
      form.set('private', input.private ? 'true' : 'false');
      form.set('source_id', input.key);
      form.set('external_created_at', String(external));
      form.set('content_attributes', JSON.stringify(attributes));
      for (const file of input.files) {
        form.append(
          'attachments[]',
          new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mediaType }),
          file.name,
        );
      }
      created = await this.request('createMessage', 'POST', path, form);
    } else {
      created = await this.request('createMessage', 'POST', path, {
        content: input.text ?? '',
        message_type: input.direction,
        private: input.private,
        source_id: input.key,
        external_created_at: external,
        content_attributes: attributes,
      });
    }
    return toMessage(created, String(input.conversationId));
  }

  /** Every message of a conversation, oldest first (100 per page, forwards). */
  async listMessages(conversationId: number, limitPages = 200): Promise<AuthorityMessage[]> {
    const messages: AuthorityMessage[] = [];
    let after = 0;
    for (let page = 0; page < limitPages; page += 1) {
      const result = obj(
        await this.request(
          'listMessages',
          'GET',
          `/conversations/${conversationId}/messages`,
          undefined,
          { after },
        ),
      );
      const batch = list(result.payload).map((m) => toMessage(m, String(conversationId)));
      messages.push(...batch);
      const last = batch.at(-1);
      if (!last || batch.length < 100) break;
      after = Number(last.ref);
    }
    return messages;
  }

  /** The message written with this key, if Chatwoot has it (newest pages first). */
  async findMessage(conversationId: number, key: string): Promise<AuthorityMessage | null> {
    let before: string | undefined;
    for (let page = 0; page < 500; page += 1) {
      const result = obj(
        await this.request(
          'listMessages',
          'GET',
          `/conversations/${conversationId}/messages`,
          undefined,
          before ? { before } : {},
        ),
      );
      const batch = list(result.payload).map((m) => toMessage(m, String(conversationId)));
      const found = batch.find((m) => m.key === key);
      if (found) return found;
      const oldest = batch[0];
      if (!oldest || oldest.ref === before) return null;
      before = oldest.ref;
    }
    return null;
  }

  async resolve(conversationId: number): Promise<void> {
    await this.request(
      'resolveConversation',
      'POST',
      `/conversations/${conversationId}/toggle_status`,
      {
        status: 'resolved',
      },
    );
  }

  /** Deletes a conversation (Chatwoot removes it in the background). */
  async deleteConversation(conversationId: number): Promise<'deleted' | 'missing'> {
    try {
      await this.request('deleteConversation', 'DELETE', `/conversations/${conversationId}`);
      return 'deleted';
    } catch (error) {
      if (error instanceof ChatwootError && error.status === 404) return 'missing';
      throw error;
    }
  }

  async deleteContact(contactId: number): Promise<'deleted' | 'missing'> {
    try {
      await this.request('deleteContact', 'DELETE', `/contacts/${contactId}`);
      return 'deleted';
    } catch (error) {
      if (error instanceof ChatwootError && error.status === 404) return 'missing';
      throw error;
    }
  }

  /**
   * One page (25) of the account's conversations, in every status unless `status` says which,
   * optionally of one inbox. `oldestFirst` pages by creation time, so conversations started while
   * a source is being read land on later pages instead of shifting the ones already read;
   * `leastRecentFirst` puts the conversations with the oldest last activity first.
   */
  async listConversations(options: {
    page: number;
    inboxId?: number;
    status?: 'all' | 'resolved';
    oldestFirst?: boolean;
    leastRecentFirst?: boolean;
  }): Promise<{
    conversations: ChatwootConversationInfo[];
    total: number;
  }> {
    const result = obj(
      obj(
        await this.request('listConversations', 'GET', '/conversations', undefined, {
          status: options.status ?? 'all',
          page: options.page,
          ...(options.inboxId ? { inbox_id: options.inboxId } : {}),
          ...(options.oldestFirst ? { sort_by: 'created_at_asc' } : {}),
          ...(options.leastRecentFirst ? { sort_by: 'last_activity_at_asc' } : {}),
        }),
      ).data,
    );
    const meta = obj(result.meta);
    return {
      conversations: list(result.payload).map(conversationInfo),
      total: Number(meta.all_count ?? 0),
    };
  }

  /**
   * The token's role in the account (`GET /api/v1/profile`). Only the role is read: the profile
   * also carries the user's own access token, which is dropped here.
   */
  async access(): Promise<ChatwootTokenAccess> {
    const url = new URL('/api/v1/profile', this.options.baseUrl);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { api_access_token: this.options.token, accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new ChatwootError('profile', 0, error instanceof Error ? error.message : String(error));
    }
    const text = await response.text();
    if (!response.ok) throw new ChatwootError('profile', response.status, null);
    let profile: unknown = null;
    try {
      profile = JSON.parse(text);
    } catch {
      profile = null;
    }
    const account = list(obj(profile).accounts)
      .map(obj)
      .find((a) => Number(a.id) === this.options.accountId);
    return { role: typeof account?.role === 'string' ? account.role : null };
  }

  /**
   * Downloads an attachment. Only the path of the link is used, always against this Chatwoot's
   * base URL (its public host name may differ), so no other host is ever contacted; redirects
   * are followed the same way, at most three.
   */
  async download(url: string, maxBytes: number): Promise<Uint8Array | null> {
    const base = new URL(this.options.baseUrl);
    let location = url;
    for (let hop = 0; hop < 4; hop += 1) {
      const link = new URL(location, base);
      const target = new URL(`${link.pathname}${link.search}`, base);
      const response = await this.fetcher(target, {
        redirect: 'manual',
        headers: { api_access_token: this.options.token },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get('location');
        await response.arrayBuffer().catch(() => undefined);
        if (!next) return null;
        location = next;
        continue;
      }
      if (!response.ok) return null;
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > maxBytes) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.byteLength > maxBytes ? null : bytes;
    }
    return null;
  }
}
