import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

/**
 * A fake Chatwoot CE v4.18.0 for tests: the subset of the Platform, Application and Client APIs
 * that Hamnivo uses, with the payload shapes, permissions, assignment rules, paging and signed
 * webhooks observed on the real server. Chaos options duplicate, drop, reorder or delay webhook
 * deliveries (Chatwoot does not retry account and inbox webhooks).
 */

type Json = Record<string, unknown>;
type Status = 'open' | 'pending' | 'resolved' | 'snoozed';
type Role = 'administrator' | 'agent';
type Source = 'account' | 'inbox' | 'bot';

interface User {
  id: number;
  name: string;
  email: string;
  token: string;
  customAttributes: Json;
  roles: Map<number, Role>;
}
interface Account {
  id: number;
  name: string;
  conversationSeq: number;
}
interface Inbox {
  id: number;
  accountId: number;
  name: string;
  identifier: string;
  hmacToken: string;
  secret: string;
  webhookUrl: string | null;
  hmacMandatory: boolean;
  autoAssignment: boolean;
  botId: number | null;
  members: Set<number>;
}
interface Bot {
  id: number;
  accountId: number;
  name: string;
  description: string;
  outgoingUrl: string | null;
  token: string;
  secret: string;
}
interface Webhook {
  id: number;
  accountId: number;
  url: string;
  subscriptions: string[];
  secret: string;
}
interface Contact {
  id: number;
  accountId: number;
  name: string;
  email: string | null;
  identifier: string | null;
  customAttributes: Json;
}
interface ContactInbox {
  id: number;
  contactId: number;
  inboxId: number;
  sourceId: string;
  hmacVerified: boolean;
}
interface Conversation {
  id: number;
  displayId: number;
  accountId: number;
  inboxId: number;
  contactId: number;
  contactInboxId: number;
  uuid: string;
  status: Status;
  assigneeId: number | null;
  aiAssigneeId: number | null;
  teamId: number | null;
  labels: string[];
  customAttributes: Json;
  createdAt: number;
  updatedAt: number;
  waitingSince: number | null;
}
interface Message {
  id: number;
  accountId: number;
  conversationId: number;
  content: string | null;
  messageType: 0 | 1 | 2 | 3;
  private: boolean;
  sourceId: string | null;
  contentAttributes: Json;
  senderType: 'Contact' | 'User' | 'AgentBot' | null;
  senderId: number | null;
  createdAt: number;
  externalCreatedAt: number | null;
}

export interface ChaosOptions {
  /** Probability (0–1) that a webhook is delivered twice. */
  duplicate?: number;
  /** Probability (0–1) that a webhook is lost. */
  drop?: number;
  /** Shuffle the webhooks queued since the last delivery run. */
  reorder?: boolean;
  /** Seed for reproducible chaos. */
  seed?: number;
}

export interface FakeChatwootOptions {
  platformToken?: string;
  /** Delay before every API response, to exercise client timeouts. */
  latencyMs?: number;
  chaos?: ChaosOptions;
  host?: string;
  port?: number;
}

export interface FakeDelivery {
  source: Source;
  url: string;
  event: string;
  deliveryId: string;
  outcome: 'delivered' | 'duplicated' | 'dropped' | 'failed';
}

export interface FakeChatwoot {
  url: string;
  platformToken: string;
  /** Webhook deliveries so far, in delivery order. */
  deliveries: FakeDelivery[];
  /** Resolves when every queued webhook has been delivered, dropped or failed. */
  flush(): Promise<void>;
  /** Changes chaos behaviour for later deliveries. */
  setChaos(chaos: ChaosOptions): void;
  /** Holds webhooks in the queue (a delayed Chatwoot) until `resumeDeliveries`. */
  pauseDeliveries(): void;
  resumeDeliveries(): void;
  /**
   * Processes matching requests normally (state changes, webhooks) but answers with the returned
   * status instead, like a timeout after Chatwoot already committed. `null` clears it.
   */
  setResponseFault(fault: ((method: string, url: string) => number | null) | null): void;
  close(): Promise<void>;
}

const BOT_ALLOWED = new Set([
  'conversations#show',
  'conversations#toggle_status',
  'conversations#toggle_typing_status',
  'conversations#custom_attributes',
  'messages#create',
  'assignments#create',
  'labels#create',
]);
const INBOX_EVENTS = new Set([
  'conversation_created',
  'conversation_updated',
  'conversation_status_changed',
  'message_created',
  'message_updated',
  'conversation_typing_on',
  'conversation_typing_off',
]);
const BOT_EVENTS = new Set([
  'message_created',
  'message_updated',
  'conversation_updated',
  'conversation_status_changed',
]);
const MESSAGE_TYPES = ['incoming', 'outgoing', 'activity', 'template'] as const;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Json,
  ) {
    super(String(body.error ?? status));
  }
}
const unauthorized = (error = 'Invalid Access Token') => new HttpError(401, { error });
const notFound = () => new HttpError(404, { error: 'Resource could not be found' });

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const token = (bytes = 18) => randomBytes(bytes).toString('base64url');

type Principal = { kind: 'user'; user: User } | { kind: 'bot'; bot: Bot };

class FakeState {
  seq = 0;
  lastClock = 0;
  users = new Map<number, User>();
  permissible = new Set<number>();
  accounts = new Map<number, Account>();
  inboxes = new Map<number, Inbox>();
  bots = new Map<number, Bot>();
  webhooks = new Map<number, Webhook>();
  contacts = new Map<number, Contact>();
  contactInboxes = new Map<number, ContactInbox>();
  conversations = new Map<number, Conversation>();
  messages = new Map<number, Message>();
  teams = new Map<number, { id: number; accountId: number; name: string }>();

  nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Strictly increasing float seconds, like Chatwoot's `updated_at.to_f`. */
  clock(): number {
    const t = Math.max(Date.now() / 1000, this.lastClock + 0.000001);
    this.lastClock = t;
    return Number(t.toFixed(6));
  }
}

export async function startFakeChatwoot(options: FakeChatwootOptions = {}): Promise<FakeChatwoot> {
  const platformToken = options.platformToken ?? token();
  const s = new FakeState();
  let chaos: ChaosOptions = options.chaos ?? {};
  let random = mulberry32(chaos.seed ?? 1);
  const deliveries: FakeDelivery[] = [];
  let queue: Array<{ source: Source; url: string; secret: string; event: string; body: string }> =
    [];
  let pumping: Promise<void> | null = null;
  let paused = false;
  let responseFault: ((method: string, url: string) => number | null) | null = null;

  const app = Fastify({ logger: false });
  if (options.latencyMs) {
    const latency = options.latencyMs;
    app.addHook('onRequest', async () => {
      await new Promise((resolve) => setTimeout(resolve, latency));
    });
  }
  app.addHook('onSend', async (request, reply, payload) => {
    const status = responseFault?.(request.method, request.url);
    if (!status) return payload;
    reply.code(status);
    return JSON.stringify({ error: 'Gateway Timeout' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send(error.body);
    return reply.code(500).send({ status: 500, error: 'Internal Server Error' });
  });

  // ---------------------------------------------------------------- serialization

  const accountRef = (accountId: number) => {
    const account = s.accounts.get(accountId);
    return { id: accountId, name: account?.name ?? '' };
  };
  const contactApi = (c: Contact) => ({
    additional_attributes: {},
    custom_attributes: c.customAttributes,
    email: c.email,
    id: c.id,
    identifier: c.identifier,
    name: c.name,
    phone_number: null,
    thumbnail: '',
    blocked: false,
    type: 'contact',
  });
  const contactWebhook = (c: Contact) => {
    const { type: _type, ...rest } = contactApi(c);
    return { account: accountRef(c.accountId), ...rest, avatar: '' };
  };
  const userSender = (u: User) => ({
    id: u.id,
    name: u.name,
    available_name: u.name,
    avatar_url: '',
    type: 'user',
    availability_status: 'offline',
    thumbnail: '',
  });
  const botSender = (b: Bot) => ({ id: b.id, name: b.name, avatar_url: '', type: 'agent_bot' });

  function senderOf(m: Message, webhook: boolean): Json | null {
    if (m.senderType === 'Contact' && m.senderId) {
      const c = s.contacts.get(m.senderId);
      return c ? (webhook ? contactWebhook(c) : contactApi(c)) : null;
    }
    if (m.senderType === 'User' && m.senderId) {
      const u = s.users.get(m.senderId);
      return u ? userSender(u) : null;
    }
    if (m.senderType === 'AgentBot' && m.senderId) {
      const b = s.bots.get(m.senderId);
      return b ? botSender(b) : null;
    }
    return null;
  }

  const conversationOf = (m: Message) => s.conversations.get(m.conversationId) as Conversation;

  function messageApi(m: Message): Json {
    const conversation = conversationOf(m);
    return {
      id: m.id,
      content: m.content,
      inbox_id: conversation.inboxId,
      conversation_id: conversation.displayId,
      message_type: m.messageType,
      content_type: 'text',
      status: 'sent',
      content_attributes: m.contentAttributes,
      created_at: Math.floor(m.createdAt),
      private: m.private,
      source_id: m.sourceId,
      sender: senderOf(m, false),
    };
  }

  function conversationMeta(c: Conversation): Json {
    const contact = s.contacts.get(c.contactId) as Contact;
    const contactInbox = s.contactInboxes.get(c.contactInboxId) as ContactInbox;
    const meta: Json = {
      sender: contactApi(contact),
      channel: 'Channel::Api',
      hmac_verified: contactInbox.hmacVerified,
    };
    if (c.aiAssigneeId) {
      const bot = s.bots.get(c.aiAssigneeId) as Bot;
      meta.assignee = {
        id: bot.id,
        name: bot.name,
        description: bot.description,
        thumbnail: '',
        outgoing_url: bot.outgoingUrl,
        bot_type: 'webhook',
      };
      meta.assignee_type = 'AgentBot';
    } else if (c.assigneeId) {
      meta.assignee = userSender(s.users.get(c.assigneeId) as User);
      meta.assignee_type = 'User';
    }
    if (c.teamId) {
      const team = s.teams.get(c.teamId);
      meta.team = team ? { id: team.id, name: team.name } : null;
    }
    return meta;
  }

  const messagesOf = (c: Conversation) =>
    [...s.messages.values()].filter((m) => m.conversationId === c.id).sort((a, b) => a.id - b.id);

  function conversationApi(c: Conversation): Json {
    const last = messagesOf(c).at(-1);
    return {
      meta: conversationMeta(c),
      id: c.displayId,
      account_id: c.accountId,
      uuid: c.uuid,
      additional_attributes: {},
      agent_last_seen_at: 0,
      assignee_last_seen_at: 0,
      can_reply: true,
      contact_last_seen_at: 0,
      custom_attributes: c.customAttributes,
      inbox_id: c.inboxId,
      labels: c.labels,
      muted: false,
      snoozed_until: null,
      status: c.status,
      created_at: Math.floor(c.createdAt),
      updated_at: c.updatedAt,
      timestamp: Math.floor(last?.createdAt ?? c.createdAt),
      first_reply_created_at: 0,
      unread_count: 0,
      messages: last ? [messageApi(last)] : [],
      priority: null,
      waiting_since: c.waitingSince ? Math.floor(c.waitingSince) : 0,
    };
  }

  function conversationWebhook(c: Conversation): Json {
    const contactInbox = s.contactInboxes.get(c.contactInboxId) as ContactInbox;
    const last = messagesOf(c).at(-1);
    const meta = conversationMeta(c);
    if (!('team' in meta)) meta.team = null;
    return {
      additional_attributes: {},
      can_reply: true,
      channel: 'Channel::Api',
      contact_inbox: {
        id: contactInbox.id,
        contact_id: contactInbox.contactId,
        inbox_id: contactInbox.inboxId,
        source_id: contactInbox.sourceId,
        hmac_verified: contactInbox.hmacVerified,
        pubsub_token: 'fake-pubsub-token',
      },
      id: c.displayId,
      inbox_id: c.inboxId,
      messages: last ? [messageApi(last)] : [],
      labels: c.labels,
      meta,
      status: c.status,
      custom_attributes: c.customAttributes,
      snoozed_until: null,
      unread_count: 0,
      first_reply_created_at: null,
      priority: null,
      waiting_since: c.waitingSince ? Math.floor(c.waitingSince) : 0,
      agent_last_seen_at: 0,
      contact_last_seen_at: 0,
      last_activity_at: Math.floor(last?.createdAt ?? c.createdAt),
      timestamp: Math.floor(last?.createdAt ?? c.createdAt),
      created_at: Math.floor(c.createdAt),
      updated_at: c.updatedAt,
      account: accountRef(c.accountId),
    };
  }

  function messageWebhook(m: Message): Json {
    const conversation = conversationOf(m);
    const inbox = s.inboxes.get(conversation.inboxId) as Inbox;
    return {
      account: accountRef(m.accountId),
      additional_attributes: {},
      content_attributes: m.contentAttributes,
      content_type: 'text',
      content: m.content,
      conversation: conversationWebhook(conversation),
      created_at: new Date(m.createdAt * 1000).toISOString(),
      id: m.id,
      inbox: { id: inbox.id, name: inbox.name },
      message_type: MESSAGE_TYPES[m.messageType],
      private: m.private,
      sender: senderOf(m, true),
      source_id: m.sourceId,
    };
  }

  // ---------------------------------------------------------------- webhooks

  function emit(accountId: number, event: string, payload: Json, conversation?: Conversation) {
    const body = JSON.stringify({ ...payload, event });
    for (const hook of s.webhooks.values()) {
      if (hook.accountId === accountId && hook.subscriptions.includes(event)) {
        queue.push({ source: 'account', url: hook.url, secret: hook.secret, event, body });
      }
    }
    if (!conversation) return schedule();
    const inbox = s.inboxes.get(conversation.inboxId) as Inbox;
    if (inbox.webhookUrl && INBOX_EVENTS.has(event)) {
      queue.push({ source: 'inbox', url: inbox.webhookUrl, secret: inbox.secret, event, body });
    }
    const bot = s.bots.get(conversation.aiAssigneeId ?? inbox.botId ?? 0);
    if (bot?.outgoingUrl && BOT_EVENTS.has(event)) {
      queue.push({ source: 'bot', url: bot.outgoingUrl, secret: bot.secret, event, body });
    }
    schedule();
  }

  function schedule() {
    if (!paused && !pumping && queue.length > 0) {
      pumping = new Promise<void>((resolve) => setImmediate(resolve)).then(pump);
    }
  }

  async function send(item: (typeof queue)[number], deliveryId: string): Promise<boolean> {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', item.secret).update(`${ts}.${item.body}`).digest('hex');
    try {
      const response = await fetch(item.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-chatwoot-delivery': deliveryId,
          'x-chatwoot-timestamp': ts,
          'x-chatwoot-signature': `sha256=${signature}`,
        },
        body: item.body,
        signal: AbortSignal.timeout(5000),
      });
      await response.arrayBuffer();
      return response.ok;
    } catch {
      return false;
    }
  }

  async function pump(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue;
      queue = [];
      if (chaos.reorder) {
        for (let i = batch.length - 1; i > 0; i -= 1) {
          const j = Math.floor(random() * (i + 1));
          [batch[i], batch[j]] = [
            batch[j] as (typeof batch)[number],
            batch[i] as (typeof batch)[number],
          ];
        }
      }
      for (const item of batch) {
        const deliveryId = randomUUID();
        const record = { source: item.source, url: item.url, event: item.event, deliveryId };
        if (random() < (chaos.drop ?? 0)) {
          deliveries.push({ ...record, outcome: 'dropped' });
          continue;
        }
        const ok = await send(item, deliveryId);
        const duplicate = ok && random() < (chaos.duplicate ?? 0);
        if (duplicate) await send(item, deliveryId);
        deliveries.push({
          ...record,
          outcome: ok ? (duplicate ? 'duplicated' : 'delivered') : 'failed',
        });
      }
    }
    pumping = null;
  }

  // ---------------------------------------------------------------- auth helpers

  const header = (request: FastifyRequest) => {
    const value = request.headers.api_access_token;
    return typeof value === 'string' ? value : undefined;
  };

  function requirePlatform(request: FastifyRequest) {
    if (header(request) !== platformToken) throw unauthorized();
  }

  function principalOf(request: FastifyRequest): Principal {
    const given = header(request);
    if (!given) throw unauthorized();
    for (const user of s.users.values()) if (user.token === given) return { kind: 'user', user };
    for (const bot of s.bots.values()) if (bot.token === given) return { kind: 'bot', bot };
    throw unauthorized();
  }

  function accountAccess(request: FastifyRequest, action: string, adminOnly = false) {
    const accountId = Number((request.params as Json).account_id);
    if (!s.accounts.has(accountId)) throw notFound();
    const principal = principalOf(request);
    if (principal.kind === 'bot') {
      if (principal.bot.accountId !== accountId)
        throw unauthorized('You are not authorized to access this account');
      if (!BOT_ALLOWED.has(action))
        throw unauthorized('Access to this endpoint is not authorized for bots');
      return { accountId, principal };
    }
    const role = principal.user.roles.get(accountId);
    if (!role) throw unauthorized('You are not authorized to access this account');
    if (adminOnly && role !== 'administrator')
      throw unauthorized('You are not authorized to do this action');
    return { accountId, principal };
  }

  function conversationAccess(request: FastifyRequest, action: string) {
    const { accountId, principal } = accountAccess(request, action);
    const displayId = Number((request.params as Json).conversation_id);
    const conversation = [...s.conversations.values()].find(
      (c) => c.accountId === accountId && c.displayId === displayId,
    );
    if (!conversation) throw notFound();
    if (principal.kind === 'user' && principal.user.roles.get(accountId) === 'agent') {
      const inbox = s.inboxes.get(conversation.inboxId) as Inbox;
      if (!inbox.members.has(principal.user.id) && conversation.assigneeId !== principal.user.id) {
        throw unauthorized('You are not authorized to do this action');
      }
    }
    return { accountId, principal, conversation };
  }

  const body = (request: FastifyRequest) => (request.body ?? {}) as Json;

  // ---------------------------------------------------------------- state changes

  function touch(c: Conversation, changes: string[], statusChanged = false) {
    c.updatedAt = s.clock();
    if (statusChanged) emit(c.accountId, 'conversation_status_changed', conversationWebhook(c), c);
    if (changes.length > 0 || statusChanged) {
      emit(
        c.accountId,
        'conversation_updated',
        { ...conversationWebhook(c), changed_attributes: changes.map((name) => ({ [name]: {} })) },
        c,
      );
    }
  }

  function setStatus(c: Conversation, status: Status) {
    const changed = c.status !== status;
    c.status = status;
    if (status === 'open' && !c.waitingSince) c.waitingSince = s.clock();
    return changed;
  }

  // ---------------------------------------------------------------- Platform API

  app.get('/api', async () => ({
    version: '4.18.0',
    timestamp: new Date().toISOString(),
    queue_services: 'ok',
    data_services: 'ok',
  }));

  app.post('/platform/api/v1/accounts', async (request) => {
    requirePlatform(request);
    const account: Account = {
      id: s.nextId(),
      name: String(body(request).name ?? 'Account'),
      conversationSeq: 0,
    };
    s.accounts.set(account.id, account);
    return {
      id: account.id,
      name: account.name,
      locale: 'en',
      status: 'active',
      custom_attributes: {},
    };
  });

  const userJson = (u: User) => ({
    access_token: u.token,
    available_name: u.name,
    confirmed: true,
    email: u.email,
    id: u.id,
    name: u.name,
    ...(Object.keys(u.customAttributes).length > 0
      ? { custom_attributes: u.customAttributes }
      : {}),
    accounts: [...u.roles.entries()].map(([id, role]) => ({
      id,
      name: s.accounts.get(id)?.name,
      role,
    })),
  });

  app.post('/platform/api/v1/users', async (request) => {
    requirePlatform(request);
    const input = body(request);
    const email = String(input.email ?? '').toLowerCase();
    if (!email.includes('@')) throw new HttpError(422, { message: 'Email is invalid' });
    // Like Chatwoot: an existing user with this email is returned (and adopted) unchanged.
    let user = [...s.users.values()].find((u) => u.email === email);
    if (!user) {
      user = {
        id: s.nextId(),
        name: String(input.name ?? email),
        email,
        token: token(),
        customAttributes: (input.custom_attributes as Json) ?? {},
        roles: new Map(),
      };
      s.users.set(user.id, user);
    }
    s.permissible.add(user.id);
    return userJson(user);
  });

  app.post('/platform/api/v1/users/:id/token', async (request) => {
    requirePlatform(request);
    const user = s.users.get(Number((request.params as Json).id));
    if (!user) throw notFound();
    if (!s.permissible.has(user.id)) throw unauthorized('Non permissible resource');
    return {
      access_token: user.token,
      expiry: null,
      user: { id: user.id, name: user.name, email: user.email },
    };
  });

  app.get('/platform/api/v1/users/:id/login', async (request) => {
    requirePlatform(request);
    const user = s.users.get(Number((request.params as Json).id));
    if (!user || !s.permissible.has(user.id)) throw notFound();
    return {
      url: `http://fake.chatwoot/app/login?email=${encodeURIComponent(user.email)}&sso_auth_token=${token(12)}`,
    };
  });

  app.post('/platform/api/v1/accounts/:account_id/account_users', async (request) => {
    requirePlatform(request);
    const accountId = Number((request.params as Json).account_id);
    const input = body(request);
    const user = s.users.get(Number(input.user_id));
    if (!s.accounts.has(accountId) || !user) throw notFound();
    const role: Role = input.role === 'administrator' ? 'administrator' : 'agent';
    user.roles.set(accountId, role);
    return { account_id: accountId, user_id: user.id, role };
  });

  // ---------------------------------------------------------------- Application API: setup

  app.post('/api/v1/accounts/:account_id/inboxes', async (request) => {
    const { accountId } = accountAccess(request, 'inboxes#create', true);
    const input = body(request);
    const channel = (input.channel ?? {}) as Json;
    if (channel.type !== 'api') throw new HttpError(422, { message: 'Only API inboxes are faked' });
    const inbox: Inbox = {
      id: s.nextId(),
      accountId,
      name: String(input.name ?? 'Inbox'),
      identifier: token(18),
      hmacToken: token(18),
      secret: token(18),
      webhookUrl: typeof channel.webhook_url === 'string' ? channel.webhook_url : null,
      hmacMandatory: channel.hmac_mandatory === true,
      autoAssignment: input.enable_auto_assignment !== false,
      botId: null,
      members: new Set(),
    };
    s.inboxes.set(inbox.id, inbox);
    return {
      id: inbox.id,
      name: inbox.name,
      channel_type: 'Channel::Api',
      enable_auto_assignment: inbox.autoAssignment,
      hmac_mandatory: inbox.hmacMandatory,
      hmac_token: inbox.hmacToken,
      secret: inbox.secret,
      webhook_url: inbox.webhookUrl,
      inbox_identifier: inbox.identifier,
    };
  });

  app.post('/api/v1/accounts/:account_id/agent_bots', async (request) => {
    const { accountId } = accountAccess(request, 'agent_bots#create', true);
    const input = body(request);
    const bot: Bot = {
      id: s.nextId(),
      accountId,
      name: String(input.name ?? 'Bot'),
      description: String(input.description ?? ''),
      outgoingUrl: typeof input.outgoing_url === 'string' ? input.outgoing_url : null,
      token: token(),
      secret: token(),
    };
    s.bots.set(bot.id, bot);
    return {
      id: bot.id,
      name: bot.name,
      description: bot.description,
      thumbnail: '',
      outgoing_url: bot.outgoingUrl,
      bot_type: 'webhook',
      bot_config: {},
      account_id: accountId,
      access_token: bot.token,
      secret: bot.secret,
      system_bot: false,
    };
  });

  app.post(
    '/api/v1/accounts/:account_id/inboxes/:id/set_agent_bot',
    async (request, reply: FastifyReply) => {
      const { accountId } = accountAccess(request, 'inboxes#set_agent_bot', true);
      const inbox = s.inboxes.get(Number((request.params as Json).id));
      if (!inbox || inbox.accountId !== accountId) throw notFound();
      const botId = body(request).agent_bot;
      if (botId === null || botId === undefined) inbox.botId = null;
      else {
        const bot = s.bots.get(Number(botId));
        if (!bot || bot.accountId !== accountId) throw notFound();
        inbox.botId = bot.id;
      }
      return reply.code(200).send();
    },
  );

  app.post('/api/v1/accounts/:account_id/inbox_members', async (request) => {
    const { accountId } = accountAccess(request, 'inbox_members#create', true);
    const input = body(request);
    const inbox = s.inboxes.get(Number(input.inbox_id));
    if (!inbox || inbox.accountId !== accountId) throw notFound();
    for (const id of (input.user_ids as unknown[]) ?? []) {
      const user = s.users.get(Number(id));
      if (!user?.roles.has(accountId)) throw notFound();
      inbox.members.add(user.id);
    }
    return { payload: [...inbox.members].map((id) => userSender(s.users.get(id) as User)) };
  });

  app.post('/api/v1/accounts/:account_id/webhooks', async (request) => {
    const { accountId } = accountAccess(request, 'webhooks#create', true);
    const input = (body(request).webhook ?? {}) as Json;
    const hook: Webhook = {
      id: s.nextId(),
      accountId,
      url: String(input.url),
      subscriptions: Array.isArray(input.subscriptions) ? input.subscriptions.map(String) : [],
      secret: token(),
    };
    s.webhooks.set(hook.id, hook);
    return {
      payload: {
        webhook: {
          id: hook.id,
          name: null,
          url: hook.url,
          account_id: accountId,
          subscriptions: hook.subscriptions,
          secret: hook.secret,
        },
      },
    };
  });

  app.post('/api/v1/accounts/:account_id/dashboard_apps', async (request) => {
    accountAccess(request, 'dashboard_apps#create', true);
    const input = body(request);
    return {
      id: s.nextId(),
      title: input.title,
      content: input.content,
      created_at: new Date().toISOString(),
    };
  });

  app.post('/api/v1/accounts/:account_id/teams', async (request) => {
    const { accountId } = accountAccess(request, 'teams#create', true);
    const team = { id: s.nextId(), accountId, name: String(body(request).name ?? 'Team') };
    s.teams.set(team.id, team);
    return { id: team.id, name: team.name, account_id: accountId };
  });

  // ---------------------------------------------------------------- Application API: conversations

  app.get('/api/v1/accounts/:account_id/conversations/:conversation_id', async (request) => {
    const { conversation } = conversationAccess(request, 'conversations#show');
    return conversationApi(conversation);
  });

  app.get(
    '/api/v1/accounts/:account_id/conversations/:conversation_id/messages',
    async (request) => {
      const { conversation } = conversationAccess(request, 'messages#index');
      const query = request.query as Json;
      let list = messagesOf(conversation);
      if (query.filter_internal_messages)
        list = list.filter((m) => !m.private && m.messageType !== 2);
      const after = query.after === undefined ? null : Number(query.after);
      const before = query.before === undefined ? null : Number(query.before);
      let page: Message[];
      if (after !== null && before !== null)
        page = list.filter((m) => m.id >= after && m.id < before).slice(0, 1000);
      else if (before !== null) page = list.filter((m) => m.id < before).slice(-20);
      else if (after !== null) page = list.filter((m) => m.id > after).slice(0, 100);
      else page = list.slice(-20);
      const contact = s.contacts.get(conversation.contactId) as Contact;
      return {
        meta: {
          labels: conversation.labels,
          additional_attributes: {},
          contact: contactApi(contact),
          agent_last_seen_at: null,
          assignee_last_seen_at: null,
        },
        payload: page.map(messageApi),
      };
    },
  );

  app.post(
    '/api/v1/accounts/:account_id/conversations/:conversation_id/messages',
    async (request) => {
      const { principal, conversation } = conversationAccess(request, 'messages#create');
      const input = body(request);
      const requested = String(input.message_type ?? 'outgoing');
      const messageType =
        requested === 'incoming'
          ? 0
          : requested === 'template'
            ? 3
            : requested === 'activity'
              ? 2
              : 1;
      let senderType: Message['senderType'] = null;
      let senderId: number | null = null;
      if (messageType === 0) {
        senderType = 'Contact';
        senderId = conversation.contactId;
      } else if (input.sender_type === 'AgentBot') {
        const bot = s.bots.get(Number(input.sender_id));
        if (bot && bot.accountId === conversation.accountId) {
          senderType = 'AgentBot';
          senderId = bot.id;
        }
      }
      if (!senderType && messageType !== 0) {
        senderType = principal.kind === 'bot' ? 'AgentBot' : 'User';
        senderId = principal.kind === 'bot' ? principal.bot.id : principal.user.id;
      }
      const attributes = input.content_attributes;
      const message: Message = {
        id: s.nextId(),
        accountId: conversation.accountId,
        conversationId: conversation.id,
        content: typeof input.content === 'string' ? input.content : null,
        messageType,
        private: input.private === true || input.private === 'true',
        sourceId: typeof input.source_id === 'string' ? input.source_id : null,
        contentAttributes:
          typeof attributes === 'object' && attributes !== null ? (attributes as Json) : {},
        senderType,
        senderId,
        createdAt: s.clock(),
        externalCreatedAt:
          typeof input.external_created_at === 'number' ? input.external_created_at : null,
      };
      s.messages.set(message.id, message);
      // Incoming messages reopen resolved or snoozed conversations (pending again when a bot is active).
      let statusChanged = false;
      if (
        messageType === 0 &&
        (conversation.status === 'resolved' || conversation.status === 'snoozed')
      ) {
        const inbox = s.inboxes.get(conversation.inboxId) as Inbox;
        const next: Status = conversation.status === 'resolved' && inbox.botId ? 'pending' : 'open';
        statusChanged = setStatus(conversation, next);
        if (next === 'pending') conversation.aiAssigneeId = inbox.botId;
      }
      emit(conversation.accountId, 'message_created', messageWebhook(message), conversation);
      touch(conversation, statusChanged ? ['status'] : [], statusChanged);
      return messageApi(message);
    },
  );

  app.post(
    '/api/v1/accounts/:account_id/conversations/:conversation_id/assignments',
    async (request) => {
      const { conversation } = conversationAccess(request, 'assignments#create');
      const input = body(request);
      if ('assignee_id' in input || input.assignee_type === 'AgentBot') {
        if (input.assignee_type === 'AgentBot') {
          const bot = s.bots.get(Number(input.assignee_id));
          if (!bot || bot.accountId !== conversation.accountId) return null;
          conversation.assigneeId = null;
          conversation.aiAssigneeId = bot.id;
          const statusChanged = setStatus(conversation, 'pending');
          touch(conversation, ['assignee_id', 'ai_assignee'], statusChanged);
          return botSender(bot);
        }
        const user =
          input.assignee_id === null ? undefined : s.users.get(Number(input.assignee_id));
        const assignee = user?.roles.has(conversation.accountId) ? user : undefined;
        let statusChanged = false;
        if (assignee && conversation.aiAssigneeId && conversation.status === 'pending') {
          statusChanged = setStatus(conversation, 'open');
        }
        conversation.assigneeId = assignee?.id ?? null;
        conversation.aiAssigneeId = null;
        touch(conversation, ['assignee_id'], statusChanged);
        return assignee ? userSender(assignee) : null;
      }
      if ('team_id' in input) {
        const teamId = Number(input.team_id);
        const team = teamId > 0 ? s.teams.get(teamId) : undefined;
        if (teamId > 0 && (!team || team.accountId !== conversation.accountId)) throw notFound();
        conversation.teamId = team?.id ?? null;
        touch(conversation, ['team_id']);
        return team ? { id: team.id, name: team.name } : null;
      }
      return null;
    },
  );

  app.post(
    '/api/v1/accounts/:account_id/conversations/:conversation_id/toggle_status',
    async (request) => {
      const { principal, conversation } = conversationAccess(
        request,
        'conversations#toggle_status',
      );
      const requested = body(request).status as Status | undefined;
      const previous = conversation.status;
      let changed: boolean;
      if (principal.kind === 'bot' && previous === 'pending' && requested === 'open') {
        // Bot handoff: the bot lets go and the conversation waits for a person.
        conversation.aiAssigneeId = null;
        changed = setStatus(conversation, 'open');
      } else if (requested) {
        changed = setStatus(conversation, requested);
      } else {
        changed = setStatus(conversation, previous === 'open' ? 'resolved' : 'open');
      }
      if (conversation.status === 'open' && principal.kind === 'user') {
        conversation.aiAssigneeId = null;
        if (principal.user.roles.get(conversation.accountId) === 'agent')
          conversation.assigneeId = principal.user.id;
      }
      touch(conversation, changed ? ['status'] : [], changed);
      return {
        meta: {},
        payload: {
          success: true,
          current_status: conversation.status,
          conversation_id: conversation.displayId,
        },
      };
    },
  );

  app.post(
    '/api/v1/accounts/:account_id/conversations/:conversation_id/custom_attributes',
    async (request) => {
      const { conversation } = conversationAccess(request, 'conversations#custom_attributes');
      const attributes = body(request).custom_attributes;
      conversation.customAttributes =
        typeof attributes === 'object' && attributes !== null ? (attributes as Json) : {};
      touch(conversation, ['custom_attributes']);
      return { custom_attributes: conversation.customAttributes };
    },
  );

  app.post(
    '/api/v1/accounts/:account_id/conversations/:conversation_id/labels',
    async (request) => {
      const { conversation } = conversationAccess(request, 'labels#create');
      const labels = body(request).labels;
      conversation.labels = Array.isArray(labels) ? labels.map(String) : [];
      touch(conversation, ['label_list']);
      return { payload: conversation.labels };
    },
  );

  app.post(
    '/api/v1/accounts/:account_id/conversations/:conversation_id/toggle_typing_status',
    async (request, reply: FastifyReply) => {
      const { principal, conversation } = conversationAccess(
        request,
        'conversations#toggle_typing_status',
      );
      const on = body(request).typing_status === 'on';
      const user = principal.kind === 'bot' ? botSender(principal.bot) : userSender(principal.user);
      emit(
        conversation.accountId,
        on ? 'conversation_typing_on' : 'conversation_typing_off',
        {
          conversation: conversationWebhook(conversation),
          user,
          is_private: body(request).is_private === true,
        },
        conversation,
      );
      return reply.code(200).send();
    },
  );

  // ---------------------------------------------------------------- Client (public) API

  function inboxByIdentifier(request: FastifyRequest): Inbox {
    const identifier = String((request.params as Json).inbox_identifier);
    const inbox = [...s.inboxes.values()].find((i) => i.identifier === identifier);
    if (!inbox) throw notFound();
    return inbox;
  }

  function contactInboxOf(inbox: Inbox, sourceId: string): ContactInbox {
    const contactInbox = [...s.contactInboxes.values()].find(
      (ci) => ci.inboxId === inbox.id && ci.sourceId === sourceId,
    );
    if (!contactInbox) throw notFound();
    return contactInbox;
  }

  app.post('/public/api/v1/inboxes/:inbox_identifier/contacts', async (request) => {
    const inbox = inboxByIdentifier(request);
    const input = body(request);
    const identifier = typeof input.identifier === 'string' ? input.identifier : '';
    if (input.identifier_hash || inbox.hmacMandatory) {
      const expected = createHmac('sha256', inbox.hmacToken).update(identifier).digest('hex');
      // Chatwoot raises a plain StandardError here, which surfaces as HTTP 500.
      if (input.identifier_hash !== expected)
        throw new HttpError(500, { status: 500, error: 'Internal Server Error' });
    }
    const sourceId =
      typeof input.source_id === 'string' && input.source_id ? input.source_id : randomUUID();
    let contactInbox = [...s.contactInboxes.values()].find(
      (ci) => ci.inboxId === inbox.id && ci.sourceId === sourceId,
    );
    if (!contactInbox) {
      const email = typeof input.email === 'string' ? input.email.toLowerCase() : null;
      let contact = [...s.contacts.values()].find(
        (c) =>
          c.accountId === inbox.accountId &&
          ((identifier && c.identifier === identifier) || (email && c.email === email)),
      );
      if (!contact) {
        contact = {
          id: s.nextId(),
          accountId: inbox.accountId,
          name: typeof input.name === 'string' ? input.name : 'Visitor',
          email,
          identifier: identifier || null,
          customAttributes: (input.custom_attributes as Json) ?? {},
        };
        s.contacts.set(contact.id, contact);
        emit(inbox.accountId, 'contact_created', contactWebhook(contact));
      }
      contactInbox = {
        id: s.nextId(),
        contactId: contact.id,
        inboxId: inbox.id,
        sourceId,
        hmacVerified: false,
      };
      s.contactInboxes.set(contactInbox.id, contactInbox);
    }
    const contact = s.contacts.get(contactInbox.contactId) as Contact;
    return {
      source_id: contactInbox.sourceId,
      pubsub_token: 'fake-pubsub-token',
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone_number: null,
    };
  });

  app.post(
    '/public/api/v1/inboxes/:inbox_identifier/contacts/:contact_identifier/conversations',
    async (request) => {
      const inbox = inboxByIdentifier(request);
      const contactInbox = contactInboxOf(
        inbox,
        String((request.params as Json).contact_identifier),
      );
      const account = s.accounts.get(inbox.accountId) as Account;
      account.conversationSeq += 1;
      const now = s.clock();
      const attributes = body(request).custom_attributes;
      const conversation: Conversation = {
        id: s.nextId(),
        displayId: account.conversationSeq,
        accountId: inbox.accountId,
        inboxId: inbox.id,
        contactId: contactInbox.contactId,
        contactInboxId: contactInbox.id,
        uuid: randomUUID(),
        status: inbox.botId ? 'pending' : 'open',
        assigneeId: null,
        aiAssigneeId: inbox.botId,
        teamId: null,
        labels: [],
        customAttributes:
          typeof attributes === 'object' && attributes !== null ? (attributes as Json) : {},
        createdAt: now,
        updatedAt: now,
        waitingSince: now,
      };
      s.conversations.set(conversation.id, conversation);
      emit(
        inbox.accountId,
        'conversation_created',
        conversationWebhook(conversation),
        conversation,
      );
      const contact = s.contacts.get(conversation.contactId) as Contact;
      return {
        id: conversation.displayId,
        uuid: conversation.uuid,
        inbox_id: inbox.id,
        contact_last_seen_at: 0,
        status: conversation.status,
        agent_last_seen_at: 0,
        messages: [],
        contact: {
          id: contact.id,
          name: contact.name,
          email: contact.email,
          phone_number: null,
          account_id: contact.accountId,
          identifier: contact.identifier,
        },
      };
    },
  );

  app.get(
    '/public/api/v1/inboxes/:inbox_identifier/contacts/:contact_identifier/conversations/:conversation_id/messages',
    async (request) => {
      const inbox = inboxByIdentifier(request);
      const params = request.params as Json;
      const contactInbox = contactInboxOf(inbox, String(params.contact_identifier));
      const conversation = [...s.conversations.values()].find(
        (c) =>
          c.contactInboxId === contactInbox.id && c.displayId === Number(params.conversation_id),
      );
      if (!conversation) throw notFound();
      return messagesOf(conversation)
        .filter((m) => !m.private && m.messageType !== 2)
        .map((m) => {
          const {
            inbox_id: _inbox,
            status: _status,
            private: _private,
            source_id: _source,
            ...rest
          } = messageApi(m);
          return rest;
        });
    },
  );

  const address = await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });

  async function flush() {
    while (pumping || (!paused && queue.length > 0)) {
      schedule();
      await pumping;
    }
  }

  return {
    url: address.replace('0.0.0.0', '127.0.0.1'),
    platformToken,
    deliveries,
    flush,
    setChaos(next) {
      chaos = next;
      random = mulberry32(next.seed ?? 1);
    },
    pauseDeliveries() {
      paused = true;
    },
    setResponseFault(fault) {
      responseFault = fault;
    },
    resumeDeliveries() {
      paused = false;
      schedule();
    },
    async close() {
      paused = false;
      await flush();
      await app.close();
    },
  };
}
