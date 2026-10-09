import { ChatwootAuthority, call, createChatwootClient } from '@hamnivo/chatwoot';
import { type Db, schema, withTenant } from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

const TTL_MS = 5 * 60_000;

export interface RuntimeInbox {
  id: string;
  externalInboxId: number;
  brandId: string | null;
  purpose: 'live' | 'import' | 'channel';
  webhookSecret: string | null;
}

export interface RuntimeBot {
  id: string;
  externalBotId: number;
  role: 'primary' | 'specialist';
  name: string;
  webhookSecret: string | null;
}

/** Everything the gateway needs to talk to one Chatwoot account, with credentials decrypted. */
export interface ConnectionRuntime {
  tenantId: string;
  connectionId: string;
  baseUrl: string;
  accountId: number;
  status: string;
  authority: ChatwootAuthority;
  inboxes: RuntimeInbox[];
  bots: RuntimeBot[];
  accountWebhookSecret: string | null;
  primaryBot: RuntimeBot | null;
  /** The integration user's token, for administration calls outside the authority port. */
  integrationToken: string;
}

/**
 * Builds a ChatwootAuthority per connection with credentials loaded from the secret broker just
 * in time and kept in memory for at most five minutes. Staff tokens come from the Platform API
 * on demand, so every staff action in Chatwoot runs as that person.
 */
@Injectable()
export class AuthorityRegistry {
  private readonly cache = new Map<
    string,
    { value: Promise<ConnectionRuntime>; expiresAt: number }
  >();
  private readonly staffTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly secrets: SecretBroker,
  ) {}

  async get(tenantId: string, connectionId: string): Promise<ConnectionRuntime> {
    const key = `${tenantId}:${connectionId}`;
    const now = this.clock().getTime();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = this.load(tenantId, connectionId);
    this.cache.set(key, { value, expiresAt: now + TTL_MS });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  invalidate(tenantId: string, connectionId: string): void {
    this.cache.delete(`${tenantId}:${connectionId}`);
  }

  private async load(tenantId: string, connectionId: string): Promise<ConnectionRuntime> {
    const loaded = await withTenant(this.db, { tenantId }, async (tx) => {
      const [connection] = await tx
        .select()
        .from(schema.authorityConnections)
        .where(eq(schema.authorityConnections.id, connectionId));
      if (!connection) throw new AppError('NOT_FOUND', { detail: 'Unknown authority connection.' });
      const reveal = (id: string | null) => (id ? this.secrets.reveal(tx, tenantId, id) : null);
      const inboxRows = await tx
        .select()
        .from(schema.authorityInboxes)
        .where(
          and(
            eq(schema.authorityInboxes.connectionId, connectionId),
            eq(schema.authorityInboxes.status, 'active'),
          ),
        );
      const botRows = await tx
        .select()
        .from(schema.authorityBots)
        .where(
          and(
            eq(schema.authorityBots.connectionId, connectionId),
            eq(schema.authorityBots.status, 'active'),
          ),
        );
      const inboxes = [];
      for (const row of inboxRows) {
        inboxes.push({
          row,
          hmacToken: await reveal(row.hmacSecretId),
          webhookSecret: await reveal(row.webhookSecretId),
        });
      }
      const bots = [];
      for (const row of botRows) {
        bots.push({
          row,
          token: (await reveal(row.accessTokenSecretId)) as string,
          webhookSecret: await reveal(row.webhookSecretId),
        });
      }
      return {
        connection,
        integrationToken: await reveal(connection.integrationTokenSecretId),
        accountWebhookSecret: await reveal(connection.webhookSecretId),
        inboxes,
        bots,
      };
    });
    const { connection, inboxes, bots } = loaded;
    if (!loaded.integrationToken) {
      throw new AppError('AUTHORITY_UNAVAILABLE', { detail: 'The connection has no credentials.' });
    }
    const inboxCredentials = new Map(
      inboxes
        .filter((i) => i.row.inboxIdentifier && i.hmacToken)
        .map((i) => [
          String(i.row.externalInboxId),
          { identifier: i.row.inboxIdentifier as string, hmacToken: i.hmacToken as string },
        ]),
    );
    const botTokens = new Map(bots.map((b) => [String(b.row.externalBotId), b.token]));
    const authority = new ChatwootAuthority({
      baseUrl: connection.baseUrl,
      accountId: connection.accountId,
      integrationToken: loaded.integrationToken,
      timeoutMs: this.config.CHATWOOT_TIMEOUT_MS,
      botToken: (ref) => {
        const token = botTokens.get(ref);
        if (!token) throw new Error(`No token for Chatwoot bot ${ref}`);
        return token;
      },
      inbox: (ref) => {
        const credentials = inboxCredentials.get(ref);
        if (!credentials) throw new Error(`No credentials for Chatwoot inbox ${ref}`);
        return credentials;
      },
      staffToken: (userRef) => this.staffToken(connection.baseUrl, userRef),
    });
    const runtimeBots: RuntimeBot[] = bots.map((b) => ({
      id: b.row.id,
      externalBotId: b.row.externalBotId,
      role: b.row.role,
      name: b.row.name,
      webhookSecret: b.webhookSecret,
    }));
    return {
      tenantId,
      connectionId,
      baseUrl: connection.baseUrl,
      accountId: connection.accountId,
      status: connection.status,
      authority,
      inboxes: inboxes.map((i) => ({
        id: i.row.id,
        externalInboxId: i.row.externalInboxId,
        brandId: i.row.brandId,
        purpose: i.row.purpose,
        webhookSecret: i.webhookSecret,
      })),
      bots: runtimeBots,
      accountWebhookSecret: loaded.accountWebhookSecret,
      primaryBot: runtimeBots.find((b) => b.role === 'primary') ?? null,
      integrationToken: loaded.integrationToken,
    };
  }

  /** A staff member's own Chatwoot token, from the Platform API (cached five minutes in memory). */
  private async staffToken(baseUrl: string, userRef: string): Promise<string> {
    const now = this.clock().getTime();
    const key = `${baseUrl}#${userRef}`;
    const cached = this.staffTokens.get(key);
    if (cached && cached.expiresAt > now) return cached.token;
    if (
      !this.config.CHATWOOT_PLATFORM_TOKEN ||
      this.config.CHATWOOT_URL?.replace(/\/$/, '') !== baseUrl.replace(/\/$/, '')
    ) {
      throw new AppError('AUTHORITY_UNAVAILABLE', {
        detail: 'Staff actions need the Chatwoot Platform App token for this Chatwoot.',
      });
    }
    const platform = createChatwootClient({
      baseUrl,
      token: this.config.CHATWOOT_PLATFORM_TOKEN,
      timeoutMs: this.config.CHATWOOT_TIMEOUT_MS,
    });
    const result = await call<{ access_token?: string }>(
      'createUserToken',
      platform.POST('/platform/api/v1/users/{id}/token', {
        params: { path: { id: Number(userRef) } },
      }) as never,
    );
    if (!result.access_token) throw new Error('Chatwoot returned no user token');
    this.staffTokens.set(key, { token: result.access_token, expiresAt: now + TTL_MS });
    return result.access_token;
  }
}
