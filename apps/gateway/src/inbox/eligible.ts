import { schema, type TenantTx } from '@hamnivo/db';
import {
  authorize,
  type Grant,
  type Permission,
  type ResourceScope,
  rolePatterns,
} from '@hamnivo/policy';
import { and, eq, isNull } from 'drizzle-orm';
import { scopeFromRow } from '../identity/principal.service.js';

interface StaffGrants {
  staffMemberId: string;
  displayName: string;
  email: string;
  grants: Grant[];
}

/** Active staff with their live grants; `patterns`: the permissions a role's grant carries. */
async function activeStaffGrants(
  tx: TenantTx,
  patterns: (role: typeof schema.roleDefinitions.$inferSelect) => string[],
): Promise<StaffGrants[]> {
  const rows = await tx
    .select({ member: schema.staffMembers, grant: schema.grants, role: schema.roleDefinitions })
    .from(schema.staffMembers)
    .innerJoin(
      schema.grants,
      and(eq(schema.grants.staffMemberId, schema.staffMembers.id), isNull(schema.grants.revokedAt)),
    )
    .innerJoin(schema.roleDefinitions, eq(schema.roleDefinitions.id, schema.grants.roleId))
    .where(eq(schema.staffMembers.status, 'active'));
  const byStaff = new Map<string, StaffGrants>();
  for (const { member, grant, role } of rows) {
    const entry = byStaff.get(member.id) ?? {
      staffMemberId: member.id,
      displayName: member.displayName,
      email: member.email,
      grants: [],
    };
    entry.grants.push({
      id: grant.id,
      permissions: patterns(role),
      scope: scopeFromRow(grant.scopeType, grant.scopeId),
      expiresAt: grant.expiresAt,
      revokedAt: null,
    });
    byStaff.set(member.id, entry);
  }
  return [...byStaff.values()];
}

function allowedAll(
  staff: StaffGrants,
  permissions: readonly Permission[],
  resource: ResourceScope,
  now: Date,
): boolean {
  return permissions.every(
    (permission) =>
      authorize(
        {
          kind: 'staff',
          tenantId: '',
          staffMemberId: staff.staffMemberId,
          status: 'active',
          mfa: true,
          authenticatedAt: now,
          grants: staff.grants,
        },
        permission,
        resource,
        { now },
      ).allowed,
  );
}

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
  const staff = await activeStaffGrants(tx, (role) => role.permissions);
  return staff
    .filter((s) => allowedAll(s, ['conversations.reply', ...also], resource, now))
    .map(({ staffMemberId, displayName }) => ({ staffMemberId, displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * The leads of a conversation at `resource` (ADR 0016): active staff who may see it and assign it
 * to someone, as their role allows today (owners, administrators and supervisors), by name.
 */
export async function leadsAt(
  tx: TenantTx,
  resource: ResourceScope,
  now: Date,
): Promise<{ staffMemberId: string; displayName: string; email: string }[]> {
  const staff = await activeStaffGrants(tx, rolePatterns);
  return staff
    .filter((s) => allowedAll(s, ['conversations.read', 'conversations.assign'], resource, now))
    .map(({ staffMemberId, displayName, email }) => ({ staffMemberId, displayName, email }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
