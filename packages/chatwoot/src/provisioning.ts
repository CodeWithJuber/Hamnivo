import { randomBytes } from 'node:crypto';
import { type ChatwootClient, call, createChatwootClient } from './client.js';

export const WEBHOOK_SUBSCRIPTIONS = [
  'conversation_created',
  'conversation_status_changed',
  'conversation_updated',
  'message_created',
  'message_updated',
  'contact_created',
  'contact_updated',
  'conversation_typing_on',
  'conversation_typing_off',
] as const;

/** Chatwoot returned an existing user for the email instead of creating one. */
export class ChatwootUserAdoptedError extends Error {
  override name = 'ChatwootUserAdoptedError';
  constructor(readonly userId: number) {
    super(
      `Chatwoot already has a user with this email (id ${userId}); Hamnivo only uses users it created`,
    );
  }
}

type Json = Record<string, unknown>;

function strongPassword(): string {
  // Chatwoot requires upper and lower case letters, a digit and a symbol.
  return `Hv-${randomBytes(18).toString('base64url')}-7a!`;
}

export interface CreatedUser {
  userId: number;
  token: string;
}

/**
 * Creates a Chatwoot user through the Platform API and returns its access token. Chatwoot silently
 * returns an existing user when the email is taken (and grants the Platform App access to it), so
 * the request carries a one-time nonce that only a newly created user can echo back; anything else
 * is refused and the returned token is discarded.
 */
export async function createPlatformUser(
  platform: ChatwootClient,
  input: { name: string; email: string },
): Promise<CreatedUser> {
  const nonce = randomBytes(16).toString('hex');
  const user = await call<Json>(
    'createUser',
    platform.POST('/platform/api/v1/users', {
      body: {
        name: input.name,
        email: input.email,
        password: strongPassword(),
        custom_attributes: { hv_provisioning_nonce: nonce },
      } as never,
    }) as never,
  );
  const userId = Number(user.id);
  const attributes = (user.custom_attributes ?? {}) as Json;
  if (attributes.hv_provisioning_nonce !== nonce) throw new ChatwootUserAdoptedError(userId);
  if (typeof user.access_token === 'string') return { userId, token: user.access_token };
  const token = await call<Json>(
    'createUserToken',
    platform.POST('/platform/api/v1/users/{id}/token', {
      params: { path: { id: userId } },
    }) as never,
  );
  return { userId, token: String(token.access_token) };
}

export interface ProvisionOptions {
  baseUrl: string;
  platformToken: string;
  accountName: string;
  /** Unique, Hamnivo-owned address for the automation user (never a real person's email). */
  integrationEmail: string;
  webhookUrls: { account: string; inbox: string; bot: string };
  inboxName?: string;
  botName?: string;
  /** Hamnivo Copilot URL shown as a Dashboard App inside Chatwoot, if set. */
  copilotUrl?: string;
  fetch?: typeof fetch;
}

export interface ProvisionedAccount {
  accountId: number;
  integration: CreatedUser;
  inbox: { id: number; identifier: string; hmacToken: string; webhookSecret: string };
  bot: { id: number; token: string; webhookSecret: string };
  accountWebhook: { id: number; secret: string };
  dashboardAppId: number | null;
}

/**
 * Creates a Chatwoot account wired to Hamnivo: an automation user (account administrator, used only
 * by the gateway), an API inbox with mandatory HMAC identity and Chatwoot's auto-assignment off
 * (Hamnivo routes), the Hamnivo AI agent bot attached to it, a signed account webhook and the
 * Copilot dashboard app. Returns the IDs and secrets the gateway stores encrypted.
 */
export async function provisionAccount(options: ProvisionOptions): Promise<ProvisionedAccount> {
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};
  const platform = createChatwootClient({
    baseUrl: options.baseUrl,
    token: options.platformToken,
    ...fetchOption,
  });

  const account = await call<Json>(
    'createAccount',
    platform.POST('/platform/api/v1/accounts', {
      body: { name: options.accountName } as never,
    }) as never,
  );
  const accountId = Number(account.id);

  const integration = await createPlatformUser(platform, {
    name: 'Hamnivo Integration',
    email: options.integrationEmail,
  });
  await addAccountUser(platform, accountId, integration.userId, 'administrator');

  const app = createChatwootClient({
    baseUrl: options.baseUrl,
    token: integration.token,
    ...fetchOption,
  });
  const path = { account_id: accountId };
  const inbox = await call<Json>(
    'createInbox',
    app.POST('/api/v1/accounts/{account_id}/inboxes', {
      params: { path },
      body: {
        name: options.inboxName ?? 'Hamnivo Chat',
        enable_auto_assignment: false,
        channel: { type: 'api', webhook_url: options.webhookUrls.inbox, hmac_mandatory: true },
      } as never,
    }) as never,
  );
  const bot = await call<Json>(
    'createAgentBot',
    app.POST('/api/v1/accounts/{account_id}/agent_bots', {
      params: { path },
      body: {
        name: options.botName ?? 'Hamnivo AI',
        description: 'AI assistant operated by Hamnivo',
        outgoing_url: options.webhookUrls.bot,
      } as never,
    }) as never,
  );
  await call(
    'setAgentBot',
    app.POST('/api/v1/accounts/{account_id}/inboxes/{id}/set_agent_bot', {
      params: { path: { account_id: accountId, id: Number(inbox.id) } },
      body: { agent_bot: Number(bot.id) } as never,
    }) as never,
  );
  const webhook = await call<Json>(
    'createWebhook',
    app.POST('/api/v1/accounts/{account_id}/webhooks', {
      params: { path },
      body: {
        webhook: { url: options.webhookUrls.account, subscriptions: [...WEBHOOK_SUBSCRIPTIONS] },
      } as never,
    }) as never,
  );
  const hook = ((webhook.payload as Json | undefined)?.webhook ?? webhook) as Json;

  let dashboardAppId: number | null = null;
  if (options.copilotUrl) {
    const dashboardApp = await call<Json>(
      'createDashboardApp',
      app.POST('/api/v1/accounts/{account_id}/dashboard_apps', {
        params: { path },
        body: {
          title: 'Hamnivo Copilot',
          content: [{ type: 'frame', url: options.copilotUrl }],
        },
      }) as never,
    );
    dashboardAppId = Number(dashboardApp.id);
  }

  return {
    accountId,
    integration,
    inbox: {
      id: Number(inbox.id),
      identifier: String(inbox.inbox_identifier),
      hmacToken: String(inbox.hmac_token),
      webhookSecret: String(inbox.secret),
    },
    bot: {
      id: Number(bot.id),
      token: String(bot.access_token),
      webhookSecret: String(bot.secret),
    },
    accountWebhook: { id: Number(hook.id), secret: String(hook.secret) },
    dashboardAppId,
  };
}

export type ChatwootRole = 'administrator' | 'agent';

async function addAccountUser(
  platform: ChatwootClient,
  accountId: number,
  userId: number,
  role: ChatwootRole,
): Promise<void> {
  await call(
    'createAccountUser',
    platform.POST('/platform/api/v1/accounts/{account_id}/account_users', {
      params: { path: { account_id: accountId } },
      body: { user_id: userId, role } as never,
    }) as never,
  );
}

/**
 * Creates the Chatwoot user behind a Hamnivo staff member so their actions keep their own
 * attribution and Chatwoot permissions. Only owners and admins get Chatwoot's administrator role.
 */
export async function provisionStaffUser(options: {
  baseUrl: string;
  platformToken: string;
  accountId: number;
  name: string;
  /** Hamnivo-generated unique address (never adopt an existing Chatwoot user). */
  email: string;
  role: ChatwootRole;
  /**
   * The address is derived from a Hamnivo id, so an existing user with it can only be one Hamnivo
   * created before (a retry after a crash). Only then may it be reused.
   */
  adoptOwnAddress?: boolean;
  fetch?: typeof fetch;
}): Promise<CreatedUser> {
  const platform = createChatwootClient({
    baseUrl: options.baseUrl,
    token: options.platformToken,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  let user: CreatedUser;
  try {
    user = await createPlatformUser(platform, { name: options.name, email: options.email });
  } catch (error) {
    if (!(options.adoptOwnAddress && error instanceof ChatwootUserAdoptedError)) throw error;
    const token = await call<Json>(
      'createUserToken',
      platform.POST('/platform/api/v1/users/{id}/token', {
        params: { path: { id: error.userId } },
      }) as never,
    );
    user = { userId: error.userId, token: String(token.access_token) };
  }
  await addAccountUser(platform, options.accountId, user.userId, options.role);
  return user;
}

/** Adds users to an inbox, so agent-role users can see and act on its conversations. */
export async function addInboxMembers(options: {
  baseUrl: string;
  /** An administrator's token (the integration user). */
  token: string;
  accountId: number;
  inboxId: number;
  userIds: number[];
  fetch?: typeof fetch;
}): Promise<void> {
  const client = createChatwootClient({
    baseUrl: options.baseUrl,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  await call(
    'addInboxMembers',
    client.POST('/api/v1/accounts/{account_id}/inbox_members', {
      params: { path: { account_id: options.accountId } },
      body: { inbox_id: options.inboxId, user_ids: options.userIds } as never,
    }) as never,
  );
}
