import {
  authorize,
  type Grant,
  isGrantActive,
  type Scope,
  type ScopeHierarchy,
  type StaffPrincipal,
  scopeContains,
} from './authorize.js';
import { appliesAtScope, expandPatterns, type Permission } from './catalog.js';

export interface ProposedGrant {
  granteeStaffMemberId: string;
  permissions: readonly string[];
  scope: Scope;
  expiresAt: Date | null;
}

export type DelegationProblem =
  | { code: 'not_allowed'; detail: string }
  | { code: 'self_grant' }
  | { code: 'exceeds_own_permissions'; permissions: Permission[] }
  | { code: 'outside_own_scope' }
  | { code: 'expiry_beyond_own'; latest: Date };

/**
 * Delegation ceiling (A03): a grantor may only hand out permissions they hold themselves, within
 * a scope they cover, expiring no later than their own access. Checked on the server for every
 * interface (Studio, API, SCIM), so a sub-admin can never escalate.
 */
export function checkDelegation(
  grantor: StaffPrincipal,
  proposed: ProposedGrant,
  hierarchy: ScopeHierarchy,
  now = new Date(),
  /** The permission that allows this kind of hand-out (`members.invite` for invitations). */
  managePermission: Permission = 'grants.manage',
): DelegationProblem[] {
  const problems: DelegationProblem[] = [];
  const resource =
    proposed.scope.type === 'tenant' ? {} : hierarchyResource(proposed.scope, hierarchy);

  const canManage = authorize(grantor, managePermission, resource, { now });
  if (!canManage.allowed) problems.push({ code: 'not_allowed', detail: canManage.reason });
  if (proposed.granteeStaffMemberId === grantor.staffMemberId)
    problems.push({ code: 'self_grant' });

  // Only permissions that take effect at the proposed level count; the rest are inert there.
  const requested = expandPatterns(proposed.permissions).filter((p) =>
    appliesAtScope(p, proposed.scope.type),
  );

  // Grants of the grantor whose scope contains the proposed scope.
  const containing = grantor.grants.filter(
    (g) => isGrantActive(g, now) && scopeContains(g.scope, proposed.scope, hierarchy),
  );
  if (containing.length === 0) problems.push({ code: 'outside_own_scope' });

  const held = new Set(
    containing.flatMap((g) =>
      expandPatterns(g.permissions).filter((p) => appliesAtScope(p, g.scope.type)),
    ),
  );
  const missing = requested.filter((p) => !held.has(p));
  if (missing.length > 0) problems.push({ code: 'exceeds_own_permissions', permissions: missing });

  const latest = latestExpiry(containing, requested);
  if (latest && (!proposed.expiresAt || proposed.expiresAt > latest)) {
    problems.push({ code: 'expiry_beyond_own', latest });
  }
  return problems;
}

/** Access someone already holds: a role's permission patterns at one scope. */
export interface HeldGrant {
  permissions: readonly string[];
  scope: Scope;
}

/**
 * The same ceiling for taking access away or changing it (A02, A03): a person may only revoke,
 * replace, suspend or remove access that they could have granted themselves, meaning permissions
 * they hold in a scope that contains the target's. Otherwise a sub-admin could suspend an owner or
 * strip a colleague who has more access than they do. Freshness is checked by the route itself.
 */
export function checkRevocation(
  actor: StaffPrincipal,
  target: { staffMemberId: string; grants: readonly HeldGrant[] },
  hierarchy: ScopeHierarchy,
  now = new Date(),
  managePermission: Permission = 'grants.manage',
): DelegationProblem[] {
  const problems: DelegationProblem[] = [];
  const add = (problem: DelegationProblem) => {
    if (!problems.some((p) => p.code === problem.code)) problems.push(problem);
  };
  if (target.staffMemberId === actor.staffMemberId) add({ code: 'self_grant' });
  const missing = new Set<Permission>();
  for (const grant of target.grants) {
    const resource = grant.scope.type === 'tenant' ? {} : hierarchyResource(grant.scope, hierarchy);
    const canManage = authorize(actor, managePermission, resource, {
      now,
      stepUpMaxAgeMs: Number.POSITIVE_INFINITY,
    });
    if (!canManage.allowed) add({ code: 'not_allowed', detail: canManage.reason });
    const containing = actor.grants.filter(
      (g) => isGrantActive(g, now) && scopeContains(g.scope, grant.scope, hierarchy),
    );
    if (containing.length === 0) add({ code: 'outside_own_scope' });
    const held = new Set(
      containing.flatMap((g) =>
        expandPatterns(g.permissions).filter((p) => appliesAtScope(p, g.scope.type)),
      ),
    );
    for (const permission of expandPatterns(grant.permissions)) {
      if (appliesAtScope(permission, grant.scope.type) && !held.has(permission)) {
        missing.add(permission);
      }
    }
  }
  if (missing.size > 0) {
    problems.push({ code: 'exceeds_own_permissions', permissions: [...missing] });
  }
  return problems;
}

/**
 * Permissions the principal does not hold across the whole tenant, so cannot put into a role
 * (A12): a role can be granted anywhere, so building one needs tenant-wide reach.
 */
export function unreachablePermissions(
  principal: StaffPrincipal,
  permissions: readonly Permission[],
  now = new Date(),
): Permission[] {
  return permissions.filter((permission) => {
    const decision = authorize(
      principal,
      permission,
      {},
      { now, stepUpMaxAgeMs: Number.POSITIVE_INFINITY },
    );
    // Holding a permission whose use needs two-step verification still counts as holding it.
    return !decision.allowed && decision.reason !== 'mfa_required';
  });
}

function hierarchyResource(scope: Exclude<Scope, { type: 'tenant' }>, hierarchy: ScopeHierarchy) {
  const parents = hierarchy(scope);
  switch (scope.type) {
    case 'workspace':
      return { ...parents, workspaceId: scope.id };
    case 'brand':
      return { ...parents, brandId: scope.id };
    case 'inbox':
      return { ...parents, inboxId: scope.id };
    case 'team':
      return { ...parents, teamId: scope.id };
  }
}

/**
 * The latest moment the grantor holds all requested permissions through containing grants.
 * Null means at least one covering grant per permission never expires.
 */
function latestExpiry(grants: readonly Grant[], permissions: readonly Permission[]): Date | null {
  let bound: Date | null = null;
  for (const permission of permissions) {
    const holders = grants.filter(
      (g) =>
        appliesAtScope(permission, g.scope.type) &&
        expandPatterns(g.permissions).includes(permission),
    );
    if (holders.length === 0) continue;
    if (holders.some((g) => g.expiresAt === null)) continue;
    const best = new Date(Math.max(...holders.map((g) => g.expiresAt?.getTime() ?? 0)));
    if (!bound || best < bound) bound = best;
  }
  return bound;
}
