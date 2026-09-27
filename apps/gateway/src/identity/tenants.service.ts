import { createHash } from 'node:crypto';
import type { CreateTenantRequest, Membership } from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  newId,
  resolveStaffMemberships,
  schema,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { ROLE_PRESETS } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation } from '../common/pg-error.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { APP_DB } from '../tokens.js';
import type { AuthSession } from './auth.factory.js';

type MembershipView = z.infer<typeof Membership>;

/** UUID (version 8, RFC 9562) derived from a name, so a retried creation reuses the same ID. */
export function deterministicUuid(name: string): string {
  const bytes = createHash('sha256').update(name).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

@Injectable()
export class TenantsService {
  constructor(@Inject(APP_DB) private readonly db: Db) {}

  async membership(authUserId: string, tenantId: string): Promise<MembershipView | null> {
    const found = (await resolveStaffMemberships(this.db, authUserId)).find(
      (m) => m.tenantId === tenantId,
    );
    return found
      ? {
          tenant: {
            id: toPublicId('tenant', found.tenantId),
            slug: found.tenantSlug,
            name: found.tenantName,
            status: found.tenantStatus as MembershipView['tenant']['status'],
          },
          staffMemberId: toPublicId('staff', found.staffMemberId),
          status: found.staffStatus as MembershipView['status'],
        }
      : null;
  }

  /**
   * Creates a tenant with a default workspace, the preset roles and the caller as owner (board 01).
   * With an Idempotency-Key the tenant ID is derived from the person and key, so a retry after a
   * lost response returns the tenant created the first time instead of a duplicate.
   */
  async create(
    session: AuthSession,
    input: z.output<typeof CreateTenantRequest>,
    idempotencyKey: string | undefined,
  ): Promise<{ membership: MembershipView; replayed: boolean }> {
    const tenantId = idempotencyKey
      ? deterministicUuid(`tenant:${session.user.id}:${idempotencyKey}`)
      : newId();
    try {
      await withTenant(this.db, { tenantId, actorId: session.user.id }, async (tx) => {
        await tx.insert(schema.tenants).values({
          id: tenantId,
          slug: input.slug,
          name: input.name,
          defaultLocale: input.defaultLocale,
        });
        await tx.insert(schema.workspaces).values({ tenantId, name: 'Main', slug: 'main' });
        const roleIds = new Map<string, string>();
        for (const preset of ROLE_PRESETS) {
          const id = newId();
          roleIds.set(preset.key, id);
          await tx.insert(schema.roleDefinitions).values({
            id,
            tenantId,
            key: preset.key,
            name: preset.name,
            description: preset.description,
            permissions: [...preset.patterns],
            isPreset: true,
          });
        }
        const staffMemberId = newId();
        await tx.insert(schema.staffMembers).values({
          id: staffMemberId,
          tenantId,
          authUserId: session.user.id,
          displayName: session.user.name,
          email: session.user.email,
          status: 'active',
        });
        await tx.insert(schema.grants).values({
          tenantId,
          staffMemberId,
          roleId: roleIds.get('owner') as string,
          scopeType: 'tenant',
          reason: 'Created the tenant',
        });
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', staffMemberId),
          action: 'tenant.created',
          targetType: 'tenant',
          targetId: toPublicId('tenant', tenantId),
          outcome: 'success',
          data: { slug: input.slug, name: input.name },
        });
        await enqueueOutbox(tx, tenantId, {
          topic: 'tenant.created',
          aggregateType: 'tenant',
          aggregateId: tenantId,
          payload: { tenantId, slug: input.slug, ownerStaffMemberId: staffMemberId },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'tenants_pkey')) {
        const existing = await this.membership(session.user.id, tenantId);
        if (existing) return { membership: existing, replayed: true };
        throw new AppError('IDEMPOTENCY_CONFLICT');
      }
      if (isUniqueViolation(error, 'tenants_slug_key')) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'slug', message: 'This handle is already taken' }],
        });
      }
      throw error;
    }
    const membership = await this.membership(session.user.id, tenantId);
    if (!membership) throw new Error('tenant created without membership');
    return { membership, replayed: false };
  }
}
