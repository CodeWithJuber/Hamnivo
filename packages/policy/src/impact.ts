import type { Scope } from './authorize.js';
import { appliesAtScope, expandPatterns, PERMISSION_KEYS, type Permission } from './catalog.js';

/** One active grant of a member, with the role it names. */
export interface MemberGrant {
  roleId: string;
  /** The role's permission patterns as they are now. */
  permissions: readonly string[];
  scope: Scope;
}

export interface MemberAccess {
  staffMemberId: string;
  grants: readonly MemberGrant[];
}

export interface MemberImpact {
  staffMemberId: string;
  /** Permissions the member will be able to use somewhere that they cannot use now. */
  gains: Permission[];
  /** Permissions the member will no longer be able to use anywhere. */
  loses: Permission[];
}

/** Every permission a set of grants gives somewhere (inert ones at their level excluded). */
export function permissionsAnywhere(
  grants: readonly { permissions: readonly string[]; scope: Scope }[],
): Set<Permission> {
  const result = new Set<Permission>();
  for (const grant of grants) {
    for (const permission of expandPatterns(grant.permissions)) {
      if (appliesAtScope(permission, grant.scope.type)) result.add(permission);
    }
  }
  return result;
}

/**
 * Who gains or loses what when role `roleId` changes to `after` (A12 impact preview). Only people
 * holding the role are listed, and a permission another of their grants still gives is not a loss.
 */
export function roleChangeImpact(
  members: readonly MemberAccess[],
  roleId: string,
  after: readonly string[],
): MemberImpact[] {
  const impacts: MemberImpact[] = [];
  for (const member of members) {
    if (!member.grants.some((g) => g.roleId === roleId)) continue;
    const before = permissionsAnywhere(member.grants);
    const next = permissionsAnywhere(
      member.grants.map((g) => (g.roleId === roleId ? { ...g, permissions: after } : g)),
    );
    const order = (set: Set<Permission>) => PERMISSION_KEYS.filter((p) => set.has(p));
    impacts.push({
      staffMemberId: member.staffMemberId,
      gains: order(new Set([...next].filter((p) => !before.has(p)))),
      loses: order(new Set([...before].filter((p) => !next.has(p)))),
    });
  }
  return impacts;
}
