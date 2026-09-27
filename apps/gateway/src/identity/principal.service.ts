import { type Db, resolveStaffMemberships, schema, withTenant } from '@hamnivo/db';
import { type Grant, rolePatterns, type Scope, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { APP_DB, AUTH } from '../tokens.js';
import type { Auth, AuthSession } from './auth.factory.js';

export function scopeFromRow(type: string, id: string | null): Scope {
  if (type === 'tenant' || !id) return { type: 'tenant' };
  return { type: type as Exclude<Scope['type'], 'tenant'>, id };
}

/** Builds the authorization principal for a signed-in person acting in one tenant. */
@Injectable()
export class PrincipalService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  async session(request: FastifyRequest): Promise<AuthSession | null> {
    return this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  }

  /**
   * Loads the staff member and their grants on every request (no cache), so a revoked grant or a
   * suspension takes effect on the very next request.
   */
  async principal(session: AuthSession, tenantId: string): Promise<StaffPrincipal | null> {
    const memberships = await resolveStaffMemberships(this.db, session.user.id);
    const membership = memberships.find((m) => m.tenantId === tenantId);
    if (membership?.tenantStatus !== 'active') return null;

    const rows = await withTenant(this.db, { tenantId, actorId: membership.staffMemberId }, (tx) =>
      tx
        .select({
          id: schema.grants.id,
          scopeType: schema.grants.scopeType,
          scopeId: schema.grants.scopeId,
          expiresAt: schema.grants.expiresAt,
          revokedAt: schema.grants.revokedAt,
          permissions: schema.roleDefinitions.permissions,
          roleKey: schema.roleDefinitions.key,
          isPreset: schema.roleDefinitions.isPreset,
        })
        .from(schema.grants)
        .innerJoin(
          schema.roleDefinitions,
          and(
            eq(schema.roleDefinitions.tenantId, schema.grants.tenantId),
            eq(schema.roleDefinitions.id, schema.grants.roleId),
          ),
        )
        .where(
          and(
            eq(schema.grants.staffMemberId, membership.staffMemberId),
            isNull(schema.grants.revokedAt),
          ),
        ),
    );
    const grants: Grant[] = rows.map((row) => ({
      id: row.id,
      permissions: rolePatterns({
        key: row.roleKey,
        isPreset: row.isPreset,
        permissions: row.permissions,
      }),
      scope: scopeFromRow(row.scopeType, row.scopeId),
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    }));
    return {
      kind: 'staff',
      tenantId,
      staffMemberId: membership.staffMemberId,
      status: membership.staffStatus as StaffPrincipal['status'],
      mfa: Boolean((session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled),
      authenticatedAt: new Date(session.session.createdAt),
      grants,
    };
  }
}
