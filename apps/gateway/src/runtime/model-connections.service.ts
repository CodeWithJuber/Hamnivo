import { checkDestination, EgressError } from '@hamnivo/adapters/net';
import type { CreateModelConnectionRequest, ModelConnection } from '@hamnivo/contracts';
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
