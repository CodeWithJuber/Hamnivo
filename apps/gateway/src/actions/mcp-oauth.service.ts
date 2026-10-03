import { createHash, randomBytes } from 'node:crypto';
import {
  finishMcpOAuth,
  type McpOAuthClient,
  type McpOAuthDiscovery,
  McpOAuthError,
  probeMcpAuth,
  revokeMcpOAuthToken,
  startMcpOAuth,
} from '@hamnivo/adapters/mcp';
import { checkUrl, EgressError } from '@hamnivo/adapters/net';
import type {
  CompleteMcpOAuthRequest,
  McpOAuthStart,
  McpServer,
  StartMcpOAuthRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import {
  authorize,
  type Permission,
  type ResourceScope,
  type StaffPrincipal,
} from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { EgressService } from '../developer/egress.service.js';
import { enforce } from '../identity/staff.guard.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { mcpTrustedOrigins } from './mcp-origins.js';
import { serverViews } from './server-views.js';

/** A sign-in that is not finished in this time is forgotten, and its secrets with it. */
const ATTEMPT_MINUTES = 10;

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const sameAddress = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** Where a sign-in sends the browser back to: a page of Studio that finishes it. */
export const mcpRedirectUri = (config: Pick<AppConfig, 'PUBLIC_CONSOLE_ORIGIN'>) =>
  new URL('/connect/mcp', config.PUBLIC_CONSOLE_ORIGIN).href;

/** The words and status for a sign-in step that failed (never a response from the service). */
function problem(error: unknown): never {
  if (error instanceof McpOAuthError) {
    if (error.kind === 'registration_unsupported') {
      throw new AppError('VALIDATION_FAILED', {
        detail: error.message,
        fields: [{ path: 'clientId', message: error.message }],
        reason: 'client_required',
      });
    }
    if (error.kind === 'unavailable') {
      throw new AppError('PROVIDER_UNAVAILABLE', { detail: error.message, retryAfter: 5 });
    }
    throw new AppError('VALIDATION_FAILED', { detail: error.message });
  }
  throw error;
}

/**
 * Ends a server's OAuth sign-in inside the transaction: its refresh token and client registration
 * are revoked and the record is removed. The access token is the server's own token and is left to
 * the caller, which replaces or clears it. Returns what the sign-in held, to tell the service.
 */
export async function dropSignIn(
  tx: TenantTx,
  secrets: SecretBroker,
  serverId: string,
): Promise<typeof schema.mcpServerOauth.$inferSelect | null> {
  const [row] = await tx
    .select()
    .from(schema.mcpServerOauth)
    .where(eq(schema.mcpServerOauth.mcpServerId, serverId))
    .for('update');
  if (!row) return null;
  await tx.delete(schema.mcpServerOauth).where(eq(schema.mcpServerOauth.id, row.id));
  if (row.refreshSecretId) await secrets.revokeIn(tx, row.refreshSecretId);
  await secrets.revokeIn(tx, row.clientSecretId);
  return row;
}

/**
 * Signing in to an MCP server with OAuth (D10), as the MCP authorization spec describes: the
 * protocol steps are in `@hamnivo/adapters/mcp`, and this holds what must survive between the
 * person leaving for the service's sign-in page and coming back: who started it, when it ends, and
 * the secrets it needs (the PKCE verifier and the client registration, in the secret broker).
 * Starting needs a fresh sign-in to Studio; finishing is by the same person, once, within ten
 * minutes, and its tokens go to the secret broker like any other credential.
 */
@Injectable()
export class McpOAuthService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly secrets: SecretBroker,
    private readonly egress: EgressService,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private decide(
    principal: StaffPrincipal,
    permission: Permission,
    resource: ResourceScope,
    freshSignIn = true,
  ) {
    return authorize(principal, permission, resource, {
      now: this.clock(),
      stepUpMaxAgeMs: freshSignIn
        ? this.config.STEP_UP_MAX_AGE_MINUTES * 60_000
        : Number.MAX_SAFE_INTEGER,
    });
  }

  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    serverId: string,
    data: Record<string, unknown>,
    outcome: 'success' | 'failed' = 'success',
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: 'mcp_server',
      targetId: toPublicId('mcpServer', serverId),
      outcome,
      data,
    });
  }

  private async server(tx: TenantTx, principal: StaffPrincipal, publicId: string, fresh = true) {
    const [row] = await tx
      .select()
      .from(schema.mcpServers)
      .where(eq(schema.mcpServers.id, fromPublicId('mcpServer', publicId)))
      .for('update');
    if (!row || row.status === 'deleted') {
      throw new AppError('NOT_FOUND', { detail: 'Server not found.' });
    }
    enforce(
      this.decide(
        principal,
        'tools.manage',
        { workspaceId: row.workspaceId, brandId: row.brandId },
        fresh,
      ),
    );
    return row;
  }

  /** The workspace's egress policy for a server: public HTTPS, its allowed hosts. */
  private async policy(tx: TenantTx, url: string) {
    const trusted = mcpTrustedOrigins(this.config, url);
    const policy = await this.egress.policyIn(tx, trusted);
    try {
      checkUrl(url, policy);
    } catch (error) {
      if (error instanceof EgressError) {
        throw new AppError('VALIDATION_FAILED', {
          detail:
            error.problem === 'host_not_allowed'
              ? 'This host is not on the list of allowed hosts. Add it under Allowed hosts first.'
              : error.message,
          fields: [{ path: 'url', message: error.message }],
        });
      }
      throw error;
    }
    return policy;
  }

  /**
   * Begins signing in: finds out how the server wants it, registers Hamnivo with the sign-in
   * service (or uses the client the person entered), and returns where to send the browser.
   */
  async start(
    principal: StaffPrincipal,
    serverPublicId: string,
    input: z.output<typeof StartMcpOAuthRequest>,
  ): Promise<McpOAuthStart> {
    const loaded = await this.tx(principal, async (tx) => {
      const server = await this.server(tx, principal, serverPublicId);
      if (server.status !== 'active') {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Turn the server on before signing in to it.',
        });
      }
      return { server, policy: await this.policy(tx, server.url) };
    });
    const { server, policy } = loaded;
    const redirectUri = mcpRedirectUri(this.config);
    const state = randomBytes(32).toString('base64url');
    let begun: Awaited<ReturnType<typeof startMcpOAuth>>;
    try {
      const challenge = await probeMcpAuth({ serverUrl: server.url, policy, timeoutMs: 10_000 });
      if (challenge.required === false) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'This server did not ask for a sign-in. Use a token only if it needs one.',
        });
      }
      const scope = input.scope ?? challenge.scope;
      begun = await startMcpOAuth({
        serverUrl: server.url,
        redirectUri,
        policy,
        state,
        ...(input.clientId
          ? {
              client: {
                clientId: input.clientId,
                ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
              },
            }
          : {}),
        ...(scope ? { scope } : {}),
        ...(challenge.resourceMetadataUrl
          ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
          : {}),
      });
    } catch (error) {
      return problem(error);
    }
    const expiresAt = new Date(this.clock().getTime() + ATTEMPT_MINUTES * 60_000);
    await this.tx(principal, async (tx) => {
      // Starting again ends a sign-in that was begun and not finished: only the newest link works.
      const earlier = await tx
        .select()
        .from(schema.mcpOauthAttempts)
        .where(
          and(
            eq(schema.mcpOauthAttempts.mcpServerId, server.id),
            isNull(schema.mcpOauthAttempts.consumedAt),
          ),
        );
      for (const attempt of earlier) {
        await tx.delete(schema.mcpOauthAttempts).where(eq(schema.mcpOauthAttempts.id, attempt.id));
        await this.secrets.revokeIn(tx, attempt.verifierSecretId);
        await this.secrets.revokeIn(tx, attempt.clientSecretId);
      }
      const verifierSecretId = await this.secrets.storeIn(tx, principal.tenantId, {
        kind: 'mcp_oauth_verifier',
        label: `MCP sign-in · ${server.label}`,
        value: begun.codeVerifier,
      });
      const clientSecretId = await this.secrets.storeIn(tx, principal.tenantId, {
        kind: 'mcp_oauth_client',
        label: `MCP sign-in client · ${server.label}`,
        value: JSON.stringify(begun.client),
      });
      await tx.insert(schema.mcpOauthAttempts).values({
        tenantId: principal.tenantId,
        mcpServerId: server.id,
        staffMemberId: principal.staffMemberId,
        stateHash: sha256(state),
        verifierSecretId,
        clientSecretId,
        clientId: begun.client.client_id,
        registration: begun.registration,
        authorizationServer: begun.authorizationServer,
        resource: begun.resource,
        scope: begun.scope,
        discovery: begun.discovery as unknown as Record<string, unknown>,
        redirectUri,
        expiresAt,
      });
      await this.audit(tx, principal, 'mcp_server.oauth_started', server.id, {
        host: new URL(server.url).hostname,
        authorizationHost: new URL(begun.authorizationServer).hostname,
        registration: begun.registration,
      });
    });
    return {
      authorizationUrl: begun.authorizationUrl,
      authorizationHost: new URL(begun.authorizationUrl).hostname,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Finishes a sign-in with what the browser came back with. The person who started it is the one
   * who finishes it, once: a code is used a single time, so the sign-in ends here whether the
   * service accepts it or not.
   */
  async complete(
    principal: StaffPrincipal,
    input: z.output<typeof CompleteMcpOAuthRequest>,
  ): Promise<McpServer> {
    const now = this.clock();
    const taken = await this.tx(principal, async (tx) => {
      const [attempt] = await tx
        .select()
        .from(schema.mcpOauthAttempts)
        .where(eq(schema.mcpOauthAttempts.stateHash, sha256(input.state)))
        .for('update');
      if (
        !attempt ||
        attempt.consumedAt !== null ||
        attempt.expiresAt <= now ||
        attempt.staffMemberId !== principal.staffMemberId
      ) {
        // The same answer for a wrong state, a used one, an old one and someone else's.
        throw new AppError('VALIDATION_FAILED', {
          detail: 'This sign-in has ended or was started by someone else. Start it again.',
          reason: 'sign_in_ended',
        });
      }
      const server = await this.server(
        tx,
        principal,
        toPublicId('mcpServer', attempt.mcpServerId),
        false,
      );
      await tx
        .update(schema.mcpOauthAttempts)
        .set({ consumedAt: now, ...(input.error ? { error: input.error.slice(0, 100) } : {}) })
        .where(eq(schema.mcpOauthAttempts.id, attempt.id));
      const verifier = await this.secrets.reveal(tx, principal.tenantId, attempt.verifierSecretId);
      const client = JSON.parse(
        await this.secrets.reveal(tx, principal.tenantId, attempt.clientSecretId),
      ) as McpOAuthClient;
      // Whatever happens next, the attempt's own secrets are not needed again.
      await this.secrets.revokeIn(tx, attempt.verifierSecretId);
      await this.secrets.revokeIn(tx, attempt.clientSecretId);
      return {
        attempt,
        server,
        verifier,
        client,
        policy: await this.policy(tx, server.url),
      };
    });
    const { attempt, server, client } = taken;
    const discovery = attempt.discovery as unknown as McpOAuthDiscovery;
    if (input.error || !input.code) {
      await this.tx(principal, (tx) =>
        this.audit(
          tx,
          principal,
          'mcp_server.oauth_failed',
          server.id,
          { reason: input.error ?? 'no_code' },
          'failed',
        ),
      );
      throw new AppError('VALIDATION_FAILED', {
        detail:
          input.error === 'access_denied'
            ? 'The service did not allow the sign-in.'
            : 'The service did not complete the sign-in. Start it again.',
        reason: 'sign_in_refused',
      });
    }
    // RFC 9207: a service that names itself in the answer must be the one that was asked, and one
    // that says it always does must have.
    const metadata = discovery.authorizationServerMetadata as
      | { issuer?: string; authorization_response_iss_parameter_supported?: boolean }
      | undefined;
    const issuer = metadata?.issuer ?? discovery.authorizationServerUrl;
    if (
      (input.iss !== undefined && !sameAddress(input.iss, issuer)) ||
      (input.iss === undefined && metadata?.authorization_response_iss_parameter_supported === true)
    ) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The answer came from a different sign-in service than the one that was asked.',
        reason: 'sign_in_refused',
      });
    }
    let tokens: Awaited<ReturnType<typeof finishMcpOAuth>>;
    try {
      tokens = await finishMcpOAuth({
        serverUrl: server.url,
        redirectUri: attempt.redirectUri,
        policy: taken.policy,
        code: input.code,
        client,
        codeVerifier: taken.verifier,
        discovery,
        now: this.clock,
        timeoutMs: 15_000,
      });
    } catch (error) {
      await this.tx(principal, (tx) =>
        this.audit(
          tx,
          principal,
          'mcp_server.oauth_failed',
          server.id,
          { reason: error instanceof McpOAuthError ? error.kind : 'unexpected' },
          'failed',
        ),
      );
      return problem(error);
    }
    return this.tx(principal, async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.mcpServers)
        .where(eq(schema.mcpServers.id, server.id))
        .for('update');
      if (!current || current.status === 'deleted') {
        throw new AppError('NOT_FOUND', { detail: 'Server not found.' });
      }
      // A sign-in replaces what the server used before: a pasted token, or an earlier sign-in.
      await dropSignIn(tx, this.secrets, server.id);
      if (current.tokenSecretId) await this.secrets.revokeIn(tx, current.tokenSecretId);
      const accessSecretId = await this.secrets.storeIn(tx, principal.tenantId, {
        kind: 'mcp_token',
        label: `MCP sign-in · ${server.label}`,
        value: tokens.accessToken,
      });
      const refreshSecretId = tokens.refreshToken
        ? await this.secrets.storeIn(tx, principal.tenantId, {
            kind: 'mcp_refresh_token',
            label: `MCP sign-in refresh · ${server.label}`,
            value: tokens.refreshToken,
          })
        : null;
      const clientSecretId = await this.secrets.storeIn(tx, principal.tenantId, {
        kind: 'mcp_oauth_client',
        label: `MCP sign-in client · ${server.label}`,
        value: JSON.stringify(client),
      });
      await tx.insert(schema.mcpServerOauth).values({
        tenantId: principal.tenantId,
        mcpServerId: server.id,
        status: 'connected',
        authorizationServer: attempt.authorizationServer,
        resource: attempt.resource,
        clientId: attempt.clientId,
        registration: attempt.registration,
        clientSecretId,
        refreshSecretId,
        scope: tokens.scope ?? attempt.scope,
        discovery: attempt.discovery,
        accessExpiresAt: tokens.expiresAt,
        connectedBy: principal.staffMemberId,
        connectedAt: now,
      });
      const [updated] = await tx
        .update(schema.mcpServers)
        .set({ tokenSecretId: accessSecretId, lastError: null, updatedAt: now })
        .where(eq(schema.mcpServers.id, server.id))
        .returning();
      await this.audit(tx, principal, 'mcp_server.oauth_connected', server.id, {
        host: new URL(server.url).hostname,
        authorizationHost: new URL(attempt.authorizationServer).hostname,
        registration: attempt.registration,
        scope: tokens.scope ?? attempt.scope,
        renewable: refreshSecretId !== null,
      });
      return (await serverViews(tx, [updated ?? current]))[0] as McpServer;
    });
  }

  /**
   * Signs out of a server: the service is told to forget the tokens (when it can be), and the
   * tokens and the client registration are dropped here. The server's tools stay and fail to run
   * until it is signed in again or given a token.
   */
  async disconnect(principal: StaffPrincipal, serverPublicId: string): Promise<McpServer> {
    const loaded = await this.tx(principal, async (tx) => {
      const server = await this.server(tx, principal, serverPublicId);
      const [oauth] = await tx
        .select()
        .from(schema.mcpServerOauth)
        .where(eq(schema.mcpServerOauth.mcpServerId, server.id));
      if (!oauth) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'This server is not signed in with OAuth.',
        });
      }
      return {
        server,
        discovery: oauth.discovery as unknown as McpOAuthDiscovery,
        client: JSON.parse(
          await this.secrets.reveal(tx, principal.tenantId, oauth.clientSecretId),
        ) as McpOAuthClient,
        access: server.tokenSecretId
          ? await this.secrets.reveal(tx, principal.tenantId, server.tokenSecretId)
          : null,
        refresh: oauth.refreshSecretId
          ? await this.secrets.reveal(tx, principal.tenantId, oauth.refreshSecretId)
          : null,
        policy: await this.egress.policyIn(tx, mcpTrustedOrigins(this.config, server.url)),
      };
    });
    // Best effort: the tokens are dropped here whether or not the service could be told.
    let told = false;
    for (const [token, kind] of [
      [loaded.refresh, 'refresh_token'],
      [loaded.access, 'access_token'],
    ] as const) {
      if (!token) continue;
      told =
        (await revokeMcpOAuthToken({
          policy: loaded.policy,
          token,
          kind,
          client: loaded.client,
          discovery: loaded.discovery,
        })) || told;
    }
    return this.tx(principal, async (tx) => {
      const server = await this.server(tx, principal, serverPublicId);
      await dropSignIn(tx, this.secrets, server.id);
      if (server.tokenSecretId) await this.secrets.revokeIn(tx, server.tokenSecretId);
      const [updated] = await tx
        .update(schema.mcpServers)
        .set({ tokenSecretId: null, lastError: null, updatedAt: this.clock() })
        .where(eq(schema.mcpServers.id, server.id))
        .returning();
      await this.audit(tx, principal, 'mcp_server.oauth_disconnected', server.id, {
        host: new URL(server.url).hostname,
        serviceTold: told,
      });
      return (await serverViews(tx, [updated ?? server]))[0] as McpServer;
    });
  }
}
