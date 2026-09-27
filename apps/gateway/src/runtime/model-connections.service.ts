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

/** Tenant model credentials. The API key goes straight into the secret broker. */
@Injectable()
export class ModelConnectionsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly secrets: SecretBroker,
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

  async create(
    principal: StaffPrincipal,
    input: z.output<typeof CreateModelConnectionRequest>,
  ): Promise<ModelConnection> {
    this.enforceManage(principal);
    return this.tx(principal, async (tx) => {
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
