import {
  authorize,
  type Grant,
  isGrantActive,
  type Scope,
  type ScopeHierarchy,
  type StaffPrincipal,
  scopeContains,
} from './authorize.js';
import { expandPatterns, PERMISSIONS, type Permission } from './catalog.js';

export interface ProposedGrant {
  granteeStaffMemberId: string;
  permissions: readonly string[];
  scope: Scope;
  expiresAt: Date | null;
}

export type DelegationProblem =
  | { code: 'not_allowed'; detail: string }
  | { code: 'self_grant' }
  | { code: 'scope_type_not_allowed'; permission: Permission }
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
): DelegationProblem[] {
  const problems: DelegationProblem[] = [];
  const resource =
    proposed.scope.type === 'tenant' ? {} : hierarchyResource(proposed.scope, hierarchy);

  const canManage = authorize(grantor, 'grants.manage', resource, { now });
  if (!canManage.allowed) problems.push({ code: 'not_allowed', detail: canManage.reason });
  if (proposed.granteeStaffMemberId === grantor.staffMemberId)
    problems.push({ code: 'self_grant' });

  const requested = expandPatterns(proposed.permissions);
  for (const permission of requested) {
    if (!(PERMISSIONS[permission].scopes as readonly string[]).includes(proposed.scope.type)) {
      problems.push({ code: 'scope_type_not_allowed', permission });
    }
  }

  // Grants of the grantor whose scope contains the proposed scope.
  const containing = grantor.grants.filter(
    (g) => isGrantActive(g, now) && scopeContains(g.scope, proposed.scope, hierarchy),
  );
  if (containing.length === 0) problems.push({ code: 'outside_own_scope' });

  const held = new Set(expandPatterns(containing.flatMap((g) => g.permissions)));
  const missing = requested.filter((p) => !held.has(p));
  if (missing.length > 0) problems.push({ code: 'exceeds_own_permissions', permissions: missing });

  const latest = latestExpiry(containing, requested);
  if (latest && (!proposed.expiresAt || proposed.expiresAt > latest)) {
    problems.push({ code: 'expiry_beyond_own', latest });
  }
  return problems;
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
    const holders = grants.filter((g) => expandPatterns(g.permissions).includes(permission));
    if (holders.length === 0) continue;
    if (holders.some((g) => g.expiresAt === null)) continue;
    const best = new Date(Math.max(...holders.map((g) => g.expiresAt?.getTime() ?? 0)));
    if (!bound || best < bound) bound = best;
  }
  return bound;
}
