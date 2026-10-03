import { randomBytes } from 'node:crypto';
import { type ChatwootClient, ChatwootError, call, createChatwootClient } from './client.js';

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
  return provisionAccountResumable(options);
}

/** The steps of provisioning, in order; each is recorded before the next one starts. */
export type ProvisionStep =
  | 'account'
  | 'integration_user'
  | 'account_user'
  | 'inbox'
  | 'bot'
  | 'bot_attached'
  | 'webhook'
  | 'dashboard_app';

/**
 * What already exists in Chatwoot for one provisioning, step by step. It holds tokens and
 * secrets: the caller stores it encrypted and hands it back to continue after a failure.
 */
export interface ProvisionProgress {
  accountId?: number;
  integration?: CreatedUser;
  integrationMember?: boolean;
  inbox?: ProvisionedAccount['inbox'];
  bot?: ProvisionedAccount['bot'];
  botAttached?: boolean;
  accountWebhook?: ProvisionedAccount['accountWebhook'];
  /** null: no dashboard app was asked for. */
  dashboardAppId?: number | null;
}

export interface ResumableProvisionOptions extends ProvisionOptions {
  /** What an earlier attempt completed; those steps are skipped. */
  progress?: ProvisionProgress;
  /** Called after every step with everything done so far; store it before resolving. */
  onProgress?: (progress: ProvisionProgress, step: ProvisionStep) => Promise<void>;
  /**
   * The integration address is derived from a Hamnivo id, so an existing user with it can only be
   * one an earlier attempt created before it could record it. Only then may it be reused.
   */
  adoptOwnAddress?: boolean;
}

/**
 * provisionAccount that can continue: every completed step is reported through `onProgress`, and
 * given that progress again it carries on from the first missing step, so a retry after a failure
 * (or a crash) never creates a second account once the account step was recorded. A request whose
 * answer was lost may still leave one unused object behind in the same account (an inbox, say).
 */
export async function provisionAccountResumable(
  options: ResumableProvisionOptions,
): Promise<ProvisionedAccount> {
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};
  const platform = createChatwootClient({
    baseUrl: options.baseUrl,
    token: options.platformToken,
    ...fetchOption,
  });
  const progress: ProvisionProgress = { ...options.progress };
  const done = async (step: ProvisionStep) => {
    await options.onProgress?.({ ...progress }, step);
  };

  if (progress.accountId === undefined) {
    const account = await call<Json>(
      'createAccount',
      platform.POST('/platform/api/v1/accounts', {
        body: { name: options.accountName } as never,
      }) as never,
    );
    progress.accountId = Number(account.id);
    await done('account');
  }
  const accountId = progress.accountId;

  if (!progress.integration) {
    try {
      progress.integration = await createPlatformUser(platform, {
        name: 'Hamnivo Integration',
        email: options.integrationEmail,
      });
    } catch (error) {
      if (!(options.adoptOwnAddress && error instanceof ChatwootUserAdoptedError)) throw error;
      const token = await call<Json>(
        'createUserToken',
        platform.POST('/platform/api/v1/users/{id}/token', {
          params: { path: { id: error.userId } },
        }) as never,
      );
      progress.integration = { userId: error.userId, token: String(token.access_token) };
    }
    await done('integration_user');
  }
  const integration = progress.integration;

  if (!progress.integrationMember) {
    try {
      await addAccountUser(platform, accountId, integration.userId, 'administrator');
    } catch (error) {
      // Chatwoot refuses a second membership: an earlier attempt added it already.
      if (!(error instanceof ChatwootError && error.status === 422 && options.progress)) {
        throw error;
      }
    }
    progress.integrationMember = true;
    await done('account_user');
  }

  const app = createChatwootClient({
    baseUrl: options.baseUrl,
    token: integration.token,
    ...fetchOption,
  });
  const path = { account_id: accountId };
  if (!progress.inbox) {
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
    progress.inbox = {
      id: Number(inbox.id),
      identifier: String(inbox.inbox_identifier),
      hmacToken: String(inbox.hmac_token),
      webhookSecret: String(inbox.secret),
    };
    await done('inbox');
  }
  const inbox = progress.inbox;

  if (!progress.bot) {
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
    progress.bot = {
      id: Number(bot.id),
      token: String(bot.access_token),
      webhookSecret: String(bot.secret),
    };
    await done('bot');
  }
  const bot = progress.bot;

  if (!progress.botAttached) {
    await call(
      'setAgentBot',
      app.POST('/api/v1/accounts/{account_id}/inboxes/{id}/set_agent_bot', {
        params: { path: { account_id: accountId, id: inbox.id } },
        body: { agent_bot: bot.id } as never,
      }) as never,
    );
    progress.botAttached = true;
    await done('bot_attached');
  }

  if (!progress.accountWebhook) {
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
    progress.accountWebhook = { id: Number(hook.id), secret: String(hook.secret) };
    await done('webhook');
  }

  if (progress.dashboardAppId === undefined) {
    progress.dashboardAppId = null;
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
      progress.dashboardAppId = Number(dashboardApp.id);
    }
    await done('dashboard_app');
  }

  return {
    accountId,
    integration,
    inbox,
    bot,
    accountWebhook: progress.accountWebhook,
    dashboardAppId: progress.dashboardAppId,
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
