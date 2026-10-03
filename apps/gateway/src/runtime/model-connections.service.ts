import { PROBE_TIMEOUT_MS, probeModel } from '@hamnivo/adapters/models';
import {
  checkDestination,
  EgressError,
  type EgressPolicy,
  guardedFetch,
} from '@hamnivo/adapters/net';
import {
  type CreateModelConnectionRequest,
  MODEL_PROBE_MESSAGES,
  type ModelConnection,
  type ModelProbeResult,
  type ModelSetupStatus,
  type ReplaceModelKeyRequest,
  recommendedModel,
  type TestModelConnectionRequest,
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
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { DecisionProviders } from '../decisions/providers.js';
import { EgressService } from '../developer/egress.service.js';
import { enforce } from '../identity/staff.guard.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

type Row = typeof schema.modelConnections.$inferSelect;

function view(row: Row, keyHint: string): ModelConnection {
  return {
    id: toPublicId('modelConnection', row.id),
    provider: row.provider,
    label: row.label,
    baseUrl: row.baseUrl,
    allowedModels: row.allowedModels,
    status: row.status,
    keyHint,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The words for a server address the egress guard refuses, as the base URL field's error. */
function baseUrlProblem(error: EgressError): string {
  switch (error.problem) {
    case 'insecure_url':
      return 'Use an https:// address.';
    case 'host_not_allowed':
      return 'This host is not on the list of allowed hosts. Add it under Allowed hosts first.';
    case 'private_address':
      return 'This address points to a private or local network. A server administrator can allow it.';
    default:
      return 'Enter the full address of the server, starting with https://.';
  }
}

/**
 * The model a test calls: the one asked for if the connection allows it, else the connection's
 * first allowed model, else the provider's recommended one.
 */
function modelToTest(row: Row, requested: string | undefined): string {
  const allowed = row.allowedModels;
  if (requested) {
    if (allowed.length > 0 && !allowed.includes(requested)) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [
          { path: 'modelId', message: `This connection only allows: ${allowed.join(', ')}.` },
        ],
      });
    }
    return requested;
  }
  const chosen = allowed[0] ?? recommendedModel(row.provider);
  if (!chosen) {
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ path: 'modelId', message: 'Name the model to test.' }],
    });
  }
  return chosen;
}

/** A provider's own public address is held to the public-internet rules, not to the workspace's host list. */
function publicOnly(policy: EgressPolicy): EgressPolicy {
  const { allowedHosts: _list, ...rest } = policy;
  return rest;
}

/**
 * Tenant model credentials. The API key goes straight into the secret broker. The tenant's own
 * server address (a base URL) is a request the server makes for the tenant, so it is held to the
 * egress guard: public HTTPS, the workspace's allowed hosts, and EGRESS_TRUSTED_ORIGINS for a
 * model server the administrator runs on the local network.
 */
@Injectable()
export class ModelConnectionsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly secrets: SecretBroker,
    private readonly egress: EgressService,
    private readonly decisions: DecisionProviders,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  /** Tenant-level credentials: the grant must cover the whole tenant. */
  private enforceManage(principal: StaffPrincipal) {
    enforce(
      authorize(
        principal,
        'integrations.manage',
        {},
        { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 },
      ),
    );
  }

  private async hints(tx: TenantTx) {
    const rows = await tx
      .select({ id: schema.secrets.id, hint: schema.secrets.hint })
      .from(schema.secrets)
      .where(eq(schema.secrets.kind, 'model_api_key'));
    return new Map(rows.map((r) => [r.id, r.hint]));
  }

  async list(principal: StaffPrincipal): Promise<ModelConnection[]> {
    this.enforceManage(principal);
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.modelConnections)
        .orderBy(asc(schema.modelConnections.createdAt));
      const hints = await this.hints(tx);
      return rows.map((row) => view(row, hints.get(row.apiKeySecretId) ?? ''));
    });
  }

  /**
   * Checks the server address now, so a person hears at once that it points to a private network.
   * A name that does not resolve yet is accepted: it is checked again whenever a model is called.
   */
  private async checkBaseUrl(tx: TenantTx, baseUrl: string | undefined) {
    if (!baseUrl) return;
    try {
      await checkDestination(baseUrl, await this.egress.policyIn(tx));
    } catch (error) {
      if (!(error instanceof EgressError)) throw error;
      if (error.problem === 'unresolvable') return;
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'baseUrl', message: baseUrlProblem(error) }],
      });
    }
  }

  async create(
    principal: StaffPrincipal,
    input: z.output<typeof CreateModelConnectionRequest>,
  ): Promise<ModelConnection> {
    this.enforceManage(principal);
    return this.tx(principal, async (tx) => {
      await this.checkBaseUrl(tx, input.baseUrl);
      const secretId = await this.secrets.storeIn(tx, principal.tenantId, {
        kind: 'model_api_key',
        label: `${input.provider}: ${input.label}`,
        value: input.apiKey,
      });
      const [row] = await tx
        .insert(schema.modelConnections)
        .values({
          tenantId: principal.tenantId,
          provider: input.provider,
          label: input.label,
          baseUrl: input.baseUrl ?? null,
          apiKeySecretId: secretId,
          allowedModels: [...new Set(input.allowedModels)],
          createdBy: principal.staffMemberId,
        })
        .returning();
      if (!row) throw new Error('model connection insert returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'model_connection.created',
        targetType: 'model_connection',
        targetId: toPublicId('modelConnection', row.id),
        outcome: 'success',
        data: { provider: row.provider, label: row.label, allowedModels: row.allowedModels },
      });
      const hints = await this.hints(tx);
      return view(row, hints.get(secretId) ?? '');
    });
  }

  private parseId(publicId: string): string {
    try {
      return fromPublicId('modelConnection', publicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Model connection not found.' });
    }
  }

  /**
   * Replaces the key in place: the connection keeps its id, so every agent that uses it carries on
   * with the new key. What the last test said about the old key no longer counts.
   */
  async rotate(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof ReplaceModelKeyRequest>,
  ): Promise<ModelConnection> {
    this.enforceManage(principal);
    const id = this.parseId(publicId);
    return this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.modelConnections)
        .where(eq(schema.modelConnections.id, id))
        .for('update');
      if (!row) throw new AppError('NOT_FOUND', { detail: 'Model connection not found.' });
      if (row.status !== 'active') {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'This connection is turned off. Add a new connection to use another key.',
        });
      }
      await this.secrets.rotateIn(tx, principal.tenantId, row.apiKeySecretId, input.apiKey);
      await tx
        .delete(schema.modelConnectionTests)
        .where(eq(schema.modelConnectionTests.connectionId, row.id));
      const [updated] = await tx
        .update(schema.modelConnections)
        .set({ updatedAt: this.clock() })
        .where(eq(schema.modelConnections.id, row.id))
        .returning();
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'model_connection.key_replaced',
        targetType: 'model_connection',
        targetId: publicId,
        outcome: 'success',
        data: { provider: row.provider, label: row.label },
      });
      const hints = await this.hints(tx);
      return view(updated ?? row, hints.get(row.apiKeySecretId) ?? '');
    });
  }

  /**
   * One real call of a few tokens with the connection's key, to say in plain words whether it
   * works. The key is revealed for the call and dropped. The call goes through the egress guard
   * (the connection's own server address under the workspace's rules, a provider's public address
   * under the public-internet rules), is made once and gives up after ten seconds. The result is
   * kept as the connection's last test; it never holds the key or the provider's own words.
   */
  async test(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof TestModelConnectionRequest>,
  ): Promise<ModelProbeResult> {
    this.enforceManage(principal);
    const id = this.parseId(publicId);
    // The database is not held open while the provider answers.
    const { row, modelId, apiKey, policy } = await this.tx(principal, async (tx) => {
      const [found] = await tx
        .select()
        .from(schema.modelConnections)
        .where(eq(schema.modelConnections.id, id));
      if (!found) throw new AppError('NOT_FOUND', { detail: 'Model connection not found.' });
      if (found.status !== 'active') {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'This connection is turned off. Add a new connection to test another key.',
        });
      }
      return {
        row: found,
        modelId: modelToTest(found, input.modelId),
        apiKey: await this.secrets.reveal(tx, principal.tenantId, found.apiKeySecretId),
        policy: await this.egress.policyIn(tx),
      };
    });
    const fetcher = guardedFetch(row.baseUrl ? policy : publicOnly(policy), {
      refuseRedirects: true,
      maxResponseBytes: 1024 * 1024,
    });
    let outcome: Awaited<ReturnType<typeof probeModel>>;
    try {
      outcome = await probeModel(
        {
          provider: row.provider,
          modelId,
          apiKey,
          ...(row.baseUrl ? { baseURL: row.baseUrl } : {}),
          fetch: fetcher,
        },
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
    } finally {
      await fetcher.close().catch(() => undefined);
    }
    const testedAt = this.clock();
    await this.tx(principal, async (tx) => {
      const values = {
        ok: outcome.ok,
        kind: outcome.kind,
        modelId,
        testedBy: principal.staffMemberId,
        testedAt,
      };
      await tx
        .insert(schema.modelConnectionTests)
        .values({ tenantId: principal.tenantId, connectionId: row.id, ...values })
        .onConflictDoUpdate({
          target: [schema.modelConnectionTests.tenantId, schema.modelConnectionTests.connectionId],
          set: values,
        });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'model_connection.tested',
        targetType: 'model_connection',
        targetId: publicId,
        outcome: outcome.ok ? 'success' : 'failed',
        data: { provider: row.provider, modelId, result: outcome.kind },
      });
    });
    return {
      ok: outcome.ok,
      kind: outcome.kind,
      message: MODEL_PROBE_MESSAGES[outcome.kind],
      modelId,
      latencyMs: outcome.latencyMs,
      testedAt: testedAt.toISOString(),
    };
  }

  /**
   * What the person setting up needs to know before adding a key: which keys the server holds of
   * its own (yes or no, never a value), whether Jev is set up, what searches the knowledge, and
   * the last test of each connection.
   */
  async status(principal: StaffPrincipal): Promise<ModelSetupStatus> {
    this.enforceManage(principal);
    const c = this.config;
    const serverKeys = {
      anthropic: Boolean(c.ANTHROPIC_API_KEY),
      openai: Boolean(c.OPENAI_API_KEY),
      google: Boolean(c.GOOGLE_GENERATIVE_AI_API_KEY),
      openaiCompatible: Boolean(c.OPENAI_COMPATIBLE_BASE_URL),
    };
    const embeddingReady = {
      mock: true,
      openai: serverKeys.openai,
      google: serverKeys.google,
      'openai-compatible': serverKeys.openaiCompatible,
    }[c.EMBEDDING_PROVIDER];
    const tests = await this.tx(principal, (tx) =>
      tx
        .select()
        .from(schema.modelConnectionTests)
        .orderBy(asc(schema.modelConnectionTests.testedAt)),
    );
    return {
      serverKeys,
      jev: { configured: this.decisions.jevStatus().configured },
      embeddings: { provider: c.EMBEDDING_PROVIDER, ready: embeddingReady },
      tests: tests.map((row) => ({
        connectionId: toPublicId('modelConnection', row.connectionId),
        ok: row.ok,
        kind: row.kind as ModelSetupStatus['tests'][number]['kind'],
        modelId: row.modelId,
        testedAt: row.testedAt.toISOString(),
      })),
    };
  }

  async disable(principal: StaffPrincipal, publicId: string): Promise<ModelConnection> {
    this.enforceManage(principal);
    return this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.modelConnections)
        .where(eq(schema.modelConnections.id, fromPublicId('modelConnection', publicId)))
        .for('update');
      if (!row) throw new AppError('NOT_FOUND', { detail: 'Model connection not found.' });
      const now = this.clock();
      const [updated] = await tx
        .update(schema.modelConnections)
        .set({ status: 'disabled', updatedAt: now })
        .where(eq(schema.modelConnections.id, row.id))
        .returning();
      // The stored key is revoked with the connection; re-enabling means adding a new key.
      await tx
        .update(schema.secrets)
        .set({ revokedAt: now })
        .where(eq(schema.secrets.id, row.apiKeySecretId));
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'model_connection.disabled',
        targetType: 'model_connection',
        targetId: publicId,
        outcome: 'success',
        data: { provider: row.provider },
      });
      const hints = await this.hints(tx);
      return view(updated ?? row, hints.get(row.apiKeySecretId) ?? '');
    });
  }
}
