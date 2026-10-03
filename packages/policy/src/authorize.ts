import {
  appliesAtScope,
  matchesPattern,
  PERMISSIONS,
  type Permission,
  type ScopeType,
} from './catalog.js';

export type Scope = { type: 'tenant' } | { type: Exclude<ScopeType, 'tenant'>; id: string };

/** Where a resource lives; a grant applies when its scope contains the resource. */
export interface ResourceScope {
  workspaceId?: string;
  brandId?: string;
  inboxId?: string;
  teamId?: string;
}

export interface Grant {
  id: string;
  /** Role permissions as stored: exact keys, `area.*` or `*`. */
  permissions: readonly string[];
  scope: Scope;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

interface PrincipalBase {
  tenantId: string;
  grants: readonly Grant[];
}

export interface StaffPrincipal extends PrincipalBase {
  kind: 'staff';
  staffMemberId: string;
  status: 'invited' | 'active' | 'suspended' | 'removed';
  /** The current session passed multi-factor authentication. */
  mfa: boolean;
  /** When the user last authenticated (used for step-up freshness). */
  authenticatedAt: Date;
  /**
   * The request only reads (GET). Step-up guards changes, so it does not apply, except for
   * permissions whose read is the sensitive act (`stepUpReads`: exports).
   */
  reading?: boolean;
}

export interface ServiceAccountPrincipal extends PrincipalBase {
  kind: 'service_account';
  serviceAccountId: string;
  status: 'active' | 'disabled';
  /** API-key scopes: a key can only narrow what the account's grants allow. */
  keyScopes: readonly string[];
}

export type Principal = StaffPrincipal | ServiceAccountPrincipal;

export type DenyReason =
  | 'inactive_principal'
  | 'no_grant'
  | 'outside_scope'
  | 'key_scope'
  | 'mfa_required'
  | 'step_up_required';

export type Decision =
  | { allowed: true; grantId: string }
  | { allowed: false; reason: DenyReason; permission: Permission };

export interface AuthorizeOptions {
  now?: Date;
  /** How recent the last authentication must be for step-up permissions (default 10 min). */
  stepUpMaxAgeMs?: number;
}

export const DEFAULT_STEP_UP_MAX_AGE_MS = 10 * 60 * 1000;

export function isGrantActive(grant: Grant, now: Date): boolean {
  return !grant.revokedAt && (!grant.expiresAt || grant.expiresAt > now);
}

/** Does a grant at `scope` cover a resource located at `resource`? */
export function scopeCovers(scope: Scope, resource: ResourceScope): boolean {
  switch (scope.type) {
    case 'tenant':
      return true;
    case 'workspace':
      return resource.workspaceId === scope.id;
    case 'brand':
      return resource.brandId === scope.id;
    case 'inbox':
      return resource.inboxId === scope.id;
    case 'team':
      return resource.teamId === scope.id;
  }
}

/** Does `outer` contain every resource that `inner` can reach? (Used for delegation.) */
export function scopeContains(outer: Scope, inner: Scope, hierarchy: ScopeHierarchy): boolean {
  if (outer.type === 'tenant') return true;
  if (inner.type === 'tenant') return false;
  if (outer.type === inner.type) return outer.id === inner.id;
  const parents = hierarchy(inner);
  return scopeCovers(outer, parents);
}

/** Resolves where a scope sits (e.g. a brand's workspace, an inbox's brand and workspace). */
export type ScopeHierarchy = (scope: Exclude<Scope, { type: 'tenant' }>) => ResourceScope;

/**
 * A grant gives a permission when one of its patterns matches and the permission applies at the
 * grant's scope level; e.g. `billing.manage` inside a team-scoped grant is inert.
 */
export function grantsPermission(grant: Grant, permission: Permission): boolean {
  return (
    appliesAtScope(permission, grant.scope.type) &&
    grant.permissions.some((pattern) => matchesPattern(pattern, permission))
  );
}

/**
 * Decides whether a principal may use a permission on a resource. Checks run in a fixed order so
 * the reason is stable: principal status, grant, scope, API-key scope, MFA, then freshness.
 */
export function authorize(
  principal: Principal,
  permission: Permission,
  resource: ResourceScope = {},
  options: AuthorizeOptions = {},
): Decision {
  const now = options.now ?? new Date();
  const deny = (reason: DenyReason): Decision => ({ allowed: false, reason, permission });

  if (principal.status !== 'active') return deny('inactive_principal');

  const active = principal.grants.filter((g) => isGrantActive(g, now));
  const holding = active.filter((g) => grantsPermission(g, permission));
  if (holding.length === 0) return deny('no_grant');

  const spec = PERMISSIONS[permission];
  // Reference data (knowledge, agents, colleagues) is readable from any scope that holds it.
  const reference = 'reference' in spec && spec.reference === true;
  const covering = reference ? holding[0] : holding.find((g) => scopeCovers(g.scope, resource));
  if (!covering) return deny('outside_scope');
  if (principal.kind === 'service_account') {
    if (!principal.keyScopes.some((pattern) => matchesPattern(pattern, permission))) {
      return deny('key_scope');
    }
    // Service accounts cannot satisfy MFA or step-up; such permissions stay with people.
    if (('mfa' in spec && spec.mfa) || ('stepUp' in spec && spec.stepUp))
      return deny('mfa_required');
    return { allowed: true, grantId: covering.id };
  }

  if ('mfa' in spec && spec.mfa && !principal.mfa) return deny('mfa_required');
  const readExempt = principal.reading === true && !('stepUpReads' in spec && spec.stepUpReads);
  if ('stepUp' in spec && spec.stepUp && !readExempt) {
    const maxAge = options.stepUpMaxAgeMs ?? DEFAULT_STEP_UP_MAX_AGE_MS;
    if (now.getTime() - principal.authenticatedAt.getTime() > maxAge)
      return deny('step_up_required');
  }
  return { allowed: true, grantId: covering.id };
}

/** The resource location a grant's own scope stands for. */
export function resourceOfScope(scope: Scope): ResourceScope {
  switch (scope.type) {
    case 'tenant':
      return {};
    case 'workspace':
      return { workspaceId: scope.id };
    case 'brand':
      return { brandId: scope.id };
    case 'inbox':
      return { inboxId: scope.id };
    case 'team':
      return { teamId: scope.id };
  }
}

/**
 * Whether the principal can use a permission somewhere (any of its scopes), with the same MFA,
 * freshness and key-scope rules. For list screens; actions on one resource use authorize().
 */
export function authorizeAny(
  principal: Principal,
  permission: Permission,
  options: AuthorizeOptions = {},
): Decision {
  const now = options.now ?? new Date();
  const holding = principal.grants.filter(
    (g) => isGrantActive(g, now) && grantsPermission(g, permission),
  );
  if (holding.length === 0) return authorize(principal, permission, {}, options);
  let last: Decision | undefined;
  for (const grant of holding) {
    last = authorize(principal, permission, resourceOfScope(grant.scope), options);
    if (last.allowed) return last;
  }
  return last ?? authorize(principal, permission, {}, options);
}

/** Every permission the principal can currently use somewhere (for menus and UI state). */
export function effectivePermissions(principal: Principal, now = new Date()): Set<Permission> {
  const result = new Set<Permission>();
  if (principal.status !== 'active') return result;
  for (const grant of principal.grants) {
    if (!isGrantActive(grant, now)) continue;
    for (const key of Object.keys(PERMISSIONS) as Permission[]) {
      if (grantsPermission(grant, key)) result.add(key);
    }
  }
  return result;
}
