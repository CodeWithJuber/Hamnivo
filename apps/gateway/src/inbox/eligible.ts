import { schema, type TenantTx } from '@hamnivo/db';
import { authorize, type Grant, type Permission, type ResourceScope } from '@hamnivo/policy';
import { and, eq, isNull } from 'drizzle-orm';
import { scopeFromRow } from '../identity/principal.service.js';

/**
 * Active staff whose grants let them reply in a conversation at `resource` (and do whatever else
 * `also` names there), by name.
 */
export async function eligibleStaffAt(
  tx: TenantTx,
  resource: ResourceScope,
  now: Date,
  also: readonly Permission[] = [],
): Promise<{ staffMemberId: string; displayName: string }[]> {
  const rows = await tx
    .select({
      staffMemberId: schema.staffMembers.id,
      displayName: schema.staffMembers.displayName,
      grantId: schema.grants.id,
      scopeType: schema.grants.scopeType,
      scopeId: schema.grants.scopeId,
      expiresAt: schema.grants.expiresAt,
      permissions: schema.roleDefinitions.permissions,
    })
    .from(schema.staffMembers)
    .innerJoin(
      schema.grants,
      and(eq(schema.grants.staffMemberId, schema.staffMembers.id), isNull(schema.grants.revokedAt)),
    )
    .innerJoin(schema.roleDefinitions, eq(schema.roleDefinitions.id, schema.grants.roleId))
    .where(eq(schema.staffMembers.status, 'active'));
  const byStaff = new Map<string, { displayName: string; grants: Grant[] }>();
  for (const row of rows) {
    const entry = byStaff.get(row.staffMemberId) ?? { displayName: row.displayName, grants: [] };
    entry.grants.push({
      id: row.grantId,
      permissions: row.permissions,
      scope: scopeFromRow(row.scopeType, row.scopeId),
      expiresAt: row.expiresAt,
      revokedAt: null,
    });
    byStaff.set(row.staffMemberId, entry);
  }
  return [...byStaff.entries()]
    .filter(([staffMemberId, entry]) =>
      (['conversations.reply', ...also] as Permission[]).every(
        (permission) =>
          authorize(
            {
              kind: 'staff',
              tenantId: '',
              staffMemberId,
              status: 'active',
              mfa: true,
              authenticatedAt: now,
              grants: entry.grants,
            },
            permission,
            resource,
            { now },
          ).allowed,
      ),
    )
    .map(([staffMemberId, entry]) => ({ staffMemberId, displayName: entry.displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
