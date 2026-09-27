import type {
  CustomerConversation,
  HandoffResponse,
  Message,
  MessagePage,
  WidgetSession,
} from '@hamnivo/contracts';
import { HamnivoApiError, problemOf } from './errors.js';
import { defaultStorage, type KeyValueStorage } from './storage.js';

type Conversation = CustomerConversation;
type Page = MessagePage;
type Handoff = HandoffResponse;

export interface HamnivoClientOptions {
  /** Gateway origin, e.g. `https://api.example.com`. */
  apiBase: string;
  widgetId: string;
  /** Origin of the page embedding the widget (checked against the brand's allowed websites). */
  hostOrigin?: string;
  locale?: string;
  storage?: KeyValueStorage;
  fetch?: typeof fetch;
  /** Milliseconds before expiry at which the access token is renewed. */
  refreshLeadMs?: number;
}

export interface SendResult {
  message: Message;
  status: 'accepted' | 'duplicate';
}

/**
 * Headless client for the widget API. It keeps the session (resuming it from the stored refresh
 * token), renews the access token before it expires and once more on a 401, and exposes typed
 * conversation calls. Retries of sends reuse the client message id, so they are exactly-once.
 */
export class HamnivoClient {
  readonly storage: KeyValueStorage;
  private readonly fetchImpl: typeof fetch;
  private session: WidgetSession | null = null;
  private renewing: Promise<WidgetSession> | null = null;
  private readonly listeners = new Set<(session: WidgetSession | null) => void>();

  constructor(readonly options: HamnivoClientOptions) {
    this.storage = options.storage ?? defaultStorage();
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Where this device keeps the refresh token (other tabs see it change through storage events). */
  get refreshKey(): string {
    return `hamnivo:${this.options.widgetId}:refresh`;
  }

  /** Conversations whose outbox holds unsent messages on this device (so reset can find them). */
  private get outboxIndexKey() {
    return `hamnivo:${this.options.widgetId}:outboxes`;
  }

  /** Where the unsent messages of one conversation are kept. */
  outboxKey(conversationId: string): string {
    return `hamnivo:${this.options.widgetId}:outbox:${conversationId}`;
  }

  private outboxes(): string[] {
    try {
      const ids = JSON.parse(this.storage.getItem(this.outboxIndexKey) ?? '[]');
      return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  /** Records whether a conversation has unsent messages stored on this device. */
  trackOutbox(conversationId: string, stored: boolean): void {
    const ids = new Set(this.outboxes());
    if (stored === ids.has(conversationId)) return;
    if (stored) ids.add(conversationId);
    else ids.delete(conversationId);
    if (ids.size) this.storage.setItem(this.outboxIndexKey, JSON.stringify([...ids]));
    else this.storage.removeItem(this.outboxIndexKey);
  }

  get current(): WidgetSession | null {
    return this.session;
  }

  /** Called with every new session (connect, refresh, identity change) and on sign-out. */
  onSession(listener: (session: WidgetSession | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private adopt(session: WidgetSession | null) {
    this.session = session;
    if (session) this.storage.setItem(this.refreshKey, session.refreshToken);
    else this.storage.removeItem(this.refreshKey);
    for (const listener of this.listeners) listener(session);
  }

  private async raw(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.options.apiBase.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw HamnivoApiError.network(error);
    }
  }

  /** Opens (or resumes) the visitor's session. */
  async connect(): Promise<WidgetSession> {
    const resumeToken = this.storage.getItem(this.refreshKey) ?? undefined;
    const response = await this.raw('POST', '/v1/widget/sessions', {
      widgetId: this.options.widgetId,
      ...(this.options.locale ? { locale: this.options.locale } : {}),
      ...(this.options.hostOrigin ? { hostOrigin: this.options.hostOrigin } : {}),
      ...(resumeToken ? { resumeToken } : {}),
    });
    if (!response.ok) throw await problemOf(response);
    const session = (await response.json()) as WidgetSession;
    this.adopt(session);
    return session;
  }

  /** Renews the access token (one request at a time); falls back to a new session if needed. */
  async renew(): Promise<WidgetSession> {
    if (this.renewing) return this.renewing;
    this.renewing = (async () => {
      const refreshToken = this.session?.refreshToken ?? this.storage.getItem(this.refreshKey);
      if (refreshToken) {
        const response = await this.raw('POST', '/v1/widget/sessions/refresh', { refreshToken });
        if (response.ok) {
          const session = (await response.json()) as WidgetSession;
          this.adopt(session);
          return session;
        }
        const problem = await problemOf(response);
        if (problem.status !== 401) throw problem;
        this.adopt(null);
      }
      return this.connect();
    })();
    try {
      return await this.renewing;
    } finally {
      this.renewing = null;
    }
  }

  /** A valid access token, renewed shortly before it expires. */
  async token(): Promise<string> {
    const session = this.session ?? (await this.connect());
    const lead = this.options.refreshLeadMs ?? 60_000;
    if (Date.parse(session.accessTokenExpiresAt) - Date.now() > lead) return session.accessToken;
    return (await this.renew()).accessToken;
  }

  /** Authorized JSON request with one renewal on an expired session. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response = await this.raw(method, path, body, await this.token());
    if (response.status === 401) {
      response = await this.raw(method, path, body, (await this.renew()).accessToken);
    }
    if (!response.ok) throw await problemOf(response);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  listConversations(): Promise<{ items: Conversation[] }> {
    return this.request('GET', '/v1/widget/conversations');
  }

  startConversation(
    input: { firstMessage?: string; clientMessageId?: string } = {},
  ): Promise<Conversation> {
    return this.request('POST', '/v1/widget/conversations', input);
  }

  getConversation(id: string): Promise<Conversation> {
    return this.request('GET', `/v1/widget/conversations/${encodeURIComponent(id)}`);
  }

  history(id: string, options: { before?: string; limit?: number } = {}): Promise<Page> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 30) });
    if (options.before) query.set('before', options.before);
    return this.request(
      'GET',
      `/v1/widget/conversations/${encodeURIComponent(id)}/messages?${query}`,
    );
  }

  send(id: string, clientMessageId: string, text: string): Promise<SendResult> {
    return this.request('POST', `/v1/widget/conversations/${encodeURIComponent(id)}/messages`, {
      clientMessageId,
      parts: [{ type: 'text', text }],
    });
  }

  requestHandoff(id: string, clientRequestId: string, note?: string): Promise<Handoff> {
    return this.request('POST', `/v1/widget/conversations/${encodeURIComponent(id)}/handoff`, {
      clientRequestId,
      ...(note ? { note } : {}),
    });
  }

  /**
   * A renewal still in flight would bring back the session it started with after an identity
   * change, so identity changes wait for it first.
   */
  private async settled(): Promise<void> {
    await this.renewing?.catch(() => undefined);
  }

  /** Signs the visitor in with an assertion minted by the website's backend (new principal). */
  async identify(assertion: string): Promise<WidgetSession> {
    await this.settled();
    const session = await this.request<WidgetSession>('POST', '/v1/widget/identity', { assertion });
    this.adopt(session);
    return session;
  }

  /**
   * Ends the session on this device (for example when the website signs the customer out): the
   * server revokes it, and this device forgets it and any unsent messages. The device forgets them
   * even when the server cannot be reached; the error is still thrown so the caller can tell.
   */
  async reset(): Promise<void> {
    await this.settled();
    try {
      if (this.session) await this.request('POST', '/v1/widget/sessions/reset');
    } finally {
      // Unsent messages belong to the person leaving too; they are never sent as the next one.
      for (const id of this.outboxes()) this.storage.removeItem(this.outboxKey(id));
      this.storage.removeItem(this.outboxIndexKey);
      this.adopt(null);
    }
  }

  /** Forgets the session on this device only, for example after another tab signed out. */
  forget(): void {
    this.adopt(null);
  }

  /** Low-level streaming fetch with the current token (used by EventStream). */
  async openStream(
    path: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    const url = `${this.options.apiBase.replace(/\/$/, '')}${path}`;
    const attempt = async (token: string) =>
      this.fetchImpl(url, { headers: { ...headers, authorization: `Bearer ${token}` }, signal });
    let response = await attempt(await this.token());
    if (response.status === 401) response = await attempt((await this.renew()).accessToken);
    return response;
  }
}
