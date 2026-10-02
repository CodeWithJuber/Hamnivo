import type {
  ApiKey,
  ApiKeyIdentity,
  CreateApiKeyRequest,
  CreatedApiKey,
  RotateApiKeyRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  newId,
  resolveApiKey,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import {
  API_KEY_PERMISSIONS,
  authorizeAny,
  checkDelegation,
  type DelegationProblem,
  inapplicablePermissions,
  PERMISSIONS,
  type Scope,
  type ServiceAccountPrincipal,
  type StaffPrincipal,
} from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import type { z } from 'zod';
import { scopeParents } from '../admin/scopes.js';
import { AppError } from '../common/app-error.js';
import { scopeFromContract, scopeToContract } from '../common/views.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { ApiKeyHasher, generateApiKey, parseApiKey } from './keys.js';

type KeyRow = typeof schema.apiKeys.$inferSelect;
type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number];

const DAY = 86_400_000;
/** last_used_at is written at most this often per key (a hot key would otherwise write per request). */
const LAST_USED_GRANULARITY_MS = 60_000;

function scopeOf(row: Pick<KeyRow, 'scopeType' | 'scopeId'>): Scope {
  if (row.scopeType === 'tenant' || !row.scopeId) return { type: 'tenant' };
  return { type: row.scopeType, id: row.scopeId };
}

function invalid(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { fields: [{ path, message }] });
}

function delegationError(problems: DelegationProblem[]): AppError {
  const fields = problems.map((problem) => {
    switch (problem.code) {
      case 'exceeds_own_permissions':
        return {
          path: 'permissions',
          message: `You can only give a key what you hold yourself; you do not hold ${problem.permissions.join(', ')} there.`,
        };
      case 'outside_own_scope':
        return { path: 'scope', message: 'Your own access does not cover this scope.' };
      case 'expiry_beyond_own':
        return {
          path: 'expiresInDays',
          message: `Your own access ends ${problem.latest.toISOString().slice(0, 10)}; the key must expire by then.`,
        };
      default:
        return { path: '(body)', message: 'You cannot create keys here.' };
    }
  });
  return new AppError('VALIDATION_FAILED', { fields });
}

/**
 * API keys for server integrations (board 19, D01). A key acts as its own service account with
 * the permissions and scope it was given, never more than its creator held. The secret exists in
 * the creating (or rotating) response only; the database keeps an HMAC of it.
 */
@Injectable()
export class ApiKeysService {
  private readonly hasher: ApiKeyHasher;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.hasher = new ApiKeyHasher(config.kek);
  }

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private status(row: KeyRow): ApiKey['status'] {
    if (row.revokedAt) return 'revoked';
    if (row.expiresAt && row.expiresAt <= this.clock()) return 'expired';
    return row.replacedBy ? 'rotating' : 'active';
  }

  private view(row: KeyRow, name: string, creator: { id: string; name: string } | null): ApiKey {
    return {
      id: toPublicId('apiKey', row.id),
      name,
      prefix: row.prefix,
      permissions: row.scopes.filter((s): s is ApiKeyPermission =>
        (API_KEY_PERMISSIONS as readonly string[]).includes(s),
      ),
      scope: scopeToContract(scopeOf(row)),
      status: this.status(row),
      serviceAccountId: toPublicId('serviceAccount', row.serviceAccountId),
      createdAt: row.createdAt.toISOString(),
      createdBy: creator ? { id: toPublicId('staff', creator.id), name: creator.name } : null,
      expiresAt: (row.expiresAt ?? row.createdAt).toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      replacedBy: row.replacedBy ? toPublicId('apiKey', row.replacedBy) : null,
    };
  }

  private async rows(tx: TenantTx, keyId?: string) {
    const k = schema.apiKeys;
    const query = tx
      .select({
        key: k,
        name: schema.serviceAccounts.name,
        creatorId: schema.staffMembers.id,
        creatorName: schema.staffMembers.displayName,
      })
      .from(k)
      .innerJoin(schema.serviceAccounts, eq(schema.serviceAccounts.id, k.serviceAccountId))
      .leftJoin(schema.staffMembers, eq(schema.staffMembers.id, k.createdBy));
    const rows = await (keyId ? query.where(eq(k.id, keyId)) : query.orderBy(desc(k.createdAt)));
    return rows.map((row) =>
      this.view(
        row.key,
        row.name,
        row.creatorId && row.creatorName ? { id: row.creatorId, name: row.creatorName } : null,
      ),
    );
  }

  async list(principal: StaffPrincipal): Promise<ApiKey[]> {
    return this.tx(principal, (tx) => this.rows(tx));
  }

  /** What a key can be given, and which of it this person could give. */
  permissionOptions(principal: StaffPrincipal) {
    const options = {
      now: this.clock(),
      stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
    };
    return API_KEY_PERMISSIONS.map((permission) => ({
      permission,
      description: PERMISSIONS[permission].description,
      grantable: authorizeAny(principal, permission, options).allowed,
    }));
  }

  private parseId(publicId: string): string {
    try {
      return fromPublicId('apiKey', publicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'API key not found.' });
    }
  }

  /** The delegation ceiling: a key never gets more, wider or longer than its creator holds. */
  private async checkGrant(
    tx: TenantTx,
    principal: StaffPrincipal,
    permissions: readonly string[],
    scope: Scope,
    expiresAt: Date,
  ): Promise<void> {
    const inert = inapplicablePermissions(permissions, scope.type);
    if (inert.length > 0) {
      throw invalid(
        'permissions',
        `${inert.join(', ')} only works for keys that cover the whole workspace.`,
      );
    }
    const parents = await scopeParents(tx, scope);
    const problems = checkDelegation(
      principal,
      { granteeStaffMemberId: 'service-account', permissions, scope, expiresAt },
      () => parents,
      this.clock(),
      'api_keys.manage',
    );
    // The route already required api_keys.manage tenant-wide; this only guards other callers.
    if (problems.some((p) => p.code === 'not_allowed')) throw new AppError('SCOPE_DENIED');
    if (problems.length > 0) throw delegationError(problems);
  }

  private async insertKey(
    tx: TenantTx,
    principal: StaffPrincipal,
    input: {
      serviceAccountId: string;
      permissions: readonly string[];
      scope: Scope;
      expiresAt: Date;
    },
  ) {
    const generated = generateApiKey();
    const id = newId();
    await tx.insert(schema.apiKeys).values({
      id,
      tenantId: principal.tenantId,
      serviceAccountId: input.serviceAccountId,
      prefix: generated.prefix,
      secretHash: this.hasher.hash(generated.secret),
      hashVersion: this.hasher.version,
      scopes: [...input.permissions],
      scopeType: input.scope.type,
      scopeId: input.scope.type === 'tenant' ? null : input.scope.id,
      expiresAt: input.expiresAt,
      createdBy: principal.staffMemberId,
    });
    return { id, key: generated.key, prefix: generated.prefix };
  }

  async create(
    principal: StaffPrincipal,
    input: z.output<typeof CreateApiKeyRequest>,
  ): Promise<CreatedApiKey> {
    const scope = scopeFromContract(input.scope);
    const permissions = [...new Set(input.permissions)];
    const expiresAt = new Date(this.clock().getTime() + input.expiresInDays * DAY);
    return this.tx(principal, async (tx) => {
      await this.checkGrant(tx, principal, permissions, scope, expiresAt);
      const serviceAccountId = newId();
      await tx.insert(schema.serviceAccounts).values({
        id: serviceAccountId,
        tenantId: principal.tenantId,
        name: input.name,
        description: 'API key',
        createdBy: principal.staffMemberId,
      });
      const created = await this.insertKey(tx, principal, {
        serviceAccountId,
        permissions,
        scope,
        expiresAt,
      });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'api_key.created',
        targetType: 'api_key',
        targetId: toPublicId('apiKey', created.id),
        outcome: 'success',
        data: {
          name: input.name,
          prefix: created.prefix,
          permissions,
          scope: scopeToContract(scope),
          expiresAt: expiresAt.toISOString(),
        },
      });
      const [view] = await this.rows(tx, created.id);
      if (!view) throw new Error('api key not stored');
      return { ...view, secret: created.key };
    });
  }

  async rotate(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof RotateApiKeyRequest>,
  ): Promise<CreatedApiKey> {
    const id = this.parseId(publicId);
    return this.tx(principal, async (tx) => {
      const [old] = await tx
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.id, id))
        .for('update');
      if (!old) throw new AppError('NOT_FOUND', { detail: 'API key not found.' });
      const now = this.clock();
      if (old.revokedAt || old.replacedBy || (old.expiresAt && old.expiresAt <= now)) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'Only an active key can be rotated. Create a new key instead.',
        });
      }
      // The new key lives as long as the old one was meant to, up to a year.
      const lifetime = Math.min(
        365 * DAY,
        Math.max(DAY, (old.expiresAt ?? now).getTime() - old.createdAt.getTime()),
      );
      const expiresAt = new Date(now.getTime() + lifetime);
      const scope = scopeOf(old);
      await this.checkGrant(tx, principal, old.scopes, scope, expiresAt);
      const created = await this.insertKey(tx, principal, {
        serviceAccountId: old.serviceAccountId,
        permissions: old.scopes,
        scope,
        expiresAt,
      });
      const overlapEnds = new Date(now.getTime() + input.overlapMinutes * 60_000);
      await tx
        .update(schema.apiKeys)
        .set(
          input.overlapMinutes === 0
            ? { replacedBy: created.id, revokedAt: now, revokedBy: principal.staffMemberId }
            : {
                replacedBy: created.id,
                expiresAt:
                  old.expiresAt && old.expiresAt < overlapEnds ? old.expiresAt : overlapEnds,
              },
        )
        .where(eq(schema.apiKeys.id, old.id));
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'api_key.rotated',
        targetType: 'api_key',
        targetId: publicId,
        outcome: 'success',
        data: {
          replacedBy: toPublicId('apiKey', created.id),
          prefix: created.prefix,
          overlapMinutes: input.overlapMinutes,
        },
      });
      const [view] = await this.rows(tx, created.id);
      if (!view) throw new Error('api key not stored');
      return { ...view, secret: created.key };
    });
  }

  async revoke(principal: StaffPrincipal, publicId: string): Promise<ApiKey> {
    const id = this.parseId(publicId);
    return this.tx(principal, async (tx) => {
      const [row] = await tx
        .update(schema.apiKeys)
        .set({ revokedAt: this.clock(), revokedBy: principal.staffMemberId })
        .where(and(eq(schema.apiKeys.id, id), isNull(schema.apiKeys.revokedAt)))
        .returning({ id: schema.apiKeys.id });
      if (row) {
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', principal.staffMemberId),
          action: 'api_key.revoked',
          targetType: 'api_key',
          targetId: publicId,
          outcome: 'success',
        });
      }
      const [view] = await this.rows(tx, id);
      if (!view) throw new AppError('NOT_FOUND', { detail: 'API key not found.' });
      return view;
    });
  }

  /**
   * Checks a presented key and builds its principal. Every failure is AUTH_REQUIRED; only a
   * caller holding the whole key hears whether it expired or was revoked.
   */
  async authenticate(
    presented: string,
  ): Promise<{ principal: ServiceAccountPrincipal; keyId: string }> {
    const invalidKey = () => new AppError('AUTH_REQUIRED', { detail: 'The API key is not valid.' });
    const parsed = parseApiKey(presented);
    if (!parsed) throw invalidKey();
    const found = await resolveApiKey(this.db, parsed.prefix);
    if (!found || !this.hasher.verify(parsed.secret, found.secretHash, found.hashVersion)) {
      throw invalidKey();
    }
    const now = this.clock();
    if (found.revokedAt) {
      throw new AppError('AUTH_REQUIRED', { detail: 'This API key was revoked.' });
    }
    if (found.expiresAt && found.expiresAt <= now) {
      throw new AppError('AUTH_REQUIRED', { detail: 'This API key expired.' });
    }
    if (found.tenantStatus !== 'active' || found.serviceAccountStatus !== 'active') {
      throw invalidKey();
    }
    // Rehash with the current key-encryption key after a KEK rotation (lazy, like secrets).
    const rehash = found.hashVersion !== this.hasher.version;
    const k = schema.apiKeys;
    await withTenant(
      this.db,
      { tenantId: found.tenantId, actorId: toPublicId('apiKey', found.keyId) },
      (tx) =>
        tx
          .update(k)
          .set({
            lastUsedAt: now,
            ...(rehash
              ? { secretHash: this.hasher.hash(parsed.secret), hashVersion: this.hasher.version }
              : {}),
          })
          .where(
            rehash
              ? eq(k.id, found.keyId)
              : and(
                  eq(k.id, found.keyId),
                  or(
                    isNull(k.lastUsedAt),
                    lt(k.lastUsedAt, new Date(now.getTime() - LAST_USED_GRANULARITY_MS)),
                  ),
                ),
          ),
    );
    const scope: Scope =
      found.scopeType === 'tenant' || !found.scopeId
        ? { type: 'tenant' }
        : { type: found.scopeType as Exclude<Scope['type'], 'tenant'>, id: found.scopeId };
    return {
      keyId: found.keyId,
      principal: {
        kind: 'service_account',
        tenantId: found.tenantId,
        serviceAccountId: found.serviceAccountId,
        status: 'active',
        keyScopes: found.scopes,
        grants: [
          {
            id: found.keyId,
            permissions: found.scopes,
            scope,
            expiresAt: found.expiresAt,
            revokedAt: found.revokedAt,
          },
        ],
      },
    };
  }

  async identity(tenantId: string, keyId: string): Promise<ApiKeyIdentity> {
    return withTenant(this.db, { tenantId }, async (tx) => {
      const [view] = await this.rows(tx, keyId);
      if (!view) throw new AppError('NOT_FOUND');
      return {
        id: view.id,
        name: view.name,
        tenantId: toPublicId('tenant', tenantId),
        permissions: view.permissions,
        scope: view.scope,
        expiresAt: view.expiresAt,
      };
    });
  }
}
