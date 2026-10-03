import {
  type McpOAuthClient,
  type McpOAuthDiscovery,
  McpOAuthError,
  refreshMcpOAuth,
} from '@hamnivo/adapters/mcp';
import { appendAudit, type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { EgressService } from '../developer/egress.service.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { mcpTrustedOrigins } from './mcp-origins.js';

/** An access token is renewed when it has less than this left, so a call never starts with a dying one. */
const RENEW_MARGIN_MS = 60_000;

/**
 * Why a server's bearer token cannot be had right now. `reconnect`: the sign-in no longer works
 * and a person has to sign in again. `unavailable`: the sign-in service did not answer; the saved
 * sign-in is untouched and a later call tries again. Nothing has been sent to the MCP server.
 */
export class McpTokenUnavailable extends Error {
  override readonly name = 'McpTokenUnavailable';
  constructor(
    readonly kind: 'reconnect' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The bearer token to send to an MCP server (D10, X04). A pasted token is returned as stored. A
 * token from an OAuth sign-in is renewed with its refresh token when it is about to end, or when
 * the server just refused it. Renewing happens under a row lock, so two calls at once renew once
 * (a refresh token that rotates can be used only once), and a refresh token the service no longer
 * accepts marks the sign-in as needing a person instead of failing every call the same way.
 */
@Injectable()
export class McpCredentials {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly secrets: SecretBroker,
    private readonly egress: EgressService,
  ) {}

  /**
   * The token to send now, or null when the server has none. `rejected` is the token the server
   * just refused: when the stored one is a different (newer) token it is returned as is, and
   * when it is the same one it is renewed even if it looks valid.
   */
  async bearer(
    tenantId: string,
    serverId: string,
    options: { rejected?: string | null } = {},
  ): Promise<string | null> {
    const outcome = await withTenant(this.db, { tenantId, actorId: 'ai' }, async (tx) => {
      const [server] = await tx
        .select()
        .from(schema.mcpServers)
        .where(eq(schema.mcpServers.id, serverId));
      if (!server?.tokenSecretId) return { kind: 'token' as const, token: null };
      const [oauth] = await tx
        .select()
        .from(schema.mcpServerOauth)
        .where(eq(schema.mcpServerOauth.mcpServerId, serverId))
        .for('update');
      const current = await this.secrets.reveal(tx, tenantId, server.tokenSecretId);
      if (!oauth) return { kind: 'token' as const, token: current };
      if (oauth.status === 'needs_reconnect') return { kind: 'reconnect' as const };
      const now = this.clock();
      const ending =
        oauth.accessExpiresAt !== null &&
        oauth.accessExpiresAt.getTime() - now.getTime() < RENEW_MARGIN_MS;
      // The token the server refused is no longer the stored one: someone renewed it already.
      if (options.rejected !== undefined && options.rejected !== current) {
        return { kind: 'token' as const, token: current };
      }
      if (!ending && options.rejected !== current)
        return { kind: 'token' as const, token: current };
      if (!oauth.refreshSecretId) {
        // An access token that cannot be renewed: when it ends, a person signs in again.
        return this.needReconnect(tx, tenantId, server, oauth.id, 'The sign-in cannot be renewed.');
      }
      try {
        const client = JSON.parse(
          await this.secrets.reveal(tx, tenantId, oauth.clientSecretId),
        ) as McpOAuthClient;
        const refreshToken = await this.secrets.reveal(tx, tenantId, oauth.refreshSecretId);
        const policy = await this.egress.policyIn(tx, mcpTrustedOrigins(this.config, server.url));
        const renewed = await refreshMcpOAuth({
          policy,
          client,
          tokens: { refresh_token: refreshToken },
          discovery: oauth.discovery as unknown as McpOAuthDiscovery,
          resource: oauth.resource,
          timeoutMs: 10_000,
          now: this.clock,
        });
        await this.secrets.rotateIn(tx, tenantId, server.tokenSecretId, renewed.accessToken);
        // A service that rotates refresh tokens sends a new one; the old one stops working.
        if (renewed.refreshToken && renewed.refreshToken !== refreshToken) {
          await this.secrets.rotateIn(tx, tenantId, oauth.refreshSecretId, renewed.refreshToken);
        }
        await tx
          .update(schema.mcpServerOauth)
          .set({
            accessExpiresAt: renewed.expiresAt,
            ...(renewed.scope ? { scope: renewed.scope } : {}),
            lastRefreshedAt: now,
            lastError: null,
            updatedAt: now,
          })
          .where(eq(schema.mcpServerOauth.id, oauth.id));
        return { kind: 'token' as const, token: renewed.accessToken };
      } catch (error) {
        if (error instanceof McpOAuthError && error.kind === 'reconnect_required') {
          return this.needReconnect(tx, tenantId, server, oauth.id, error.message);
        }
        const message = error instanceof McpOAuthError ? error.message : 'The sign-in failed.';
        return { kind: 'unavailable' as const, message };
      }
    });
    if (outcome.kind === 'reconnect') {
      throw new McpTokenUnavailable(
        'reconnect',
        'The saved sign-in to this server no longer works. Sign in again in Studio.',
      );
    }
    if (outcome.kind === 'unavailable') {
      throw new McpTokenUnavailable('unavailable', outcome.message);
    }
    return outcome.token;
  }

  /** Saves that a person must sign in again; kept even though the call that found out fails. */
  private async needReconnect(
    tx: TenantTx,
    tenantId: string,
    server: typeof schema.mcpServers.$inferSelect,
    oauthId: string,
    why: string,
  ) {
    const now = this.clock();
    await tx
      .update(schema.mcpServerOauth)
      .set({ status: 'needs_reconnect', lastError: why.slice(0, 300), updatedAt: now })
      .where(eq(schema.mcpServerOauth.id, oauthId));
    await tx
      .update(schema.mcpServers)
      .set({ lastError: 'The sign-in needs to be renewed. Sign in again.', updatedAt: now })
      .where(eq(schema.mcpServers.id, server.id));
    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'ai',
      action: 'mcp_server.oauth_needs_reconnect',
      targetType: 'mcp_server',
      targetId: toPublicId('mcpServer', server.id),
      outcome: 'failed',
      occurredAt: now,
      data: { host: new URL(server.url).hostname, tenant: toPublicId('tenant', tenantId) },
    });
    return { kind: 'reconnect' as const };
  }
}
