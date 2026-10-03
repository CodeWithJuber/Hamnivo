import { type AuthorizeOptions, DEFAULT_STEP_UP_MAX_AGE_MS, type DenyReason } from './authorize.js';

/**
 * Platform operations permissions (A17). They belong to Hamnivo's own operators and are separate
 * from tenant roles: no tenant grant can hold one, and none of them reaches a tenant's content.
 * Content is readable only through a support grant that the tenant approved (A18).
 */
export interface PlatformPermissionSpec {
  /** Plain-language description (English source; translated in the platform console). */
  description: string;
  /** Needs a session that passed multi-factor authentication. */
  mfa?: true;
  /** Needs a recent sign-in. */
  stepUp?: true;
}

export const PLATFORM_PERMISSIONS = {
  'platform.tenants.read': {
    description: 'See workspaces, their state and service metadata, never their content',
  },
  'platform.health.read': { description: 'See service health, queues and connector status' },
  'platform.audit.read': { description: 'Read the platform audit log' },
  'platform.support.request': {
    description: 'Ask a workspace for temporary, read-only support access',
    mfa: true,
  },
  'platform.support.use': {
    description: 'Read a workspace through support access its owner approved',
    mfa: true,
    stepUp: true,
  },
  'platform.incidents.manage': {
    description: 'Declare and resolve incidents that every workspace sees',
    mfa: true,
    stepUp: true,
  },
  'platform.tenants.manage': {
    description: 'Suspend or reactivate workspaces and change their plan',
    mfa: true,
    stepUp: true,
  },
  'platform.settings.manage': {
    description: 'Turn public sign-up on or off and manage operator API keys',
    mfa: true,
    stepUp: true,
  },
} as const satisfies Record<string, PlatformPermissionSpec>;

export type PlatformPermission = keyof typeof PLATFORM_PERMISSIONS;
export const PLATFORM_PERMISSION_KEYS = Object.keys(PLATFORM_PERMISSIONS) as PlatformPermission[];

export function isPlatformPermission(value: string): value is PlatformPermission {
  return Object.hasOwn(PLATFORM_PERMISSIONS, value);
}

/** Platform roles. Operators are named in the database by a server administrator. */
export const PLATFORM_ROLES = {
  platform_admin: {
    name: 'Platform administrator',
    permissions: PLATFORM_PERMISSION_KEYS,
  },
  support_operator: {
    name: 'Support operator',
    permissions: [
      'platform.tenants.read',
      'platform.health.read',
      'platform.support.request',
      'platform.support.use',
    ],
  },
  platform_viewer: {
    name: 'Platform viewer',
    permissions: ['platform.tenants.read', 'platform.health.read'],
  },
} as const satisfies Record<string, { name: string; permissions: readonly PlatformPermission[] }>;

export type PlatformRole = keyof typeof PLATFORM_ROLES;
export const PLATFORM_ROLE_KEYS = Object.keys(PLATFORM_ROLES) as PlatformRole[];

export function isPlatformRole(value: string): value is PlatformRole {
  return Object.hasOwn(PLATFORM_ROLES, value);
}

/** A platform operator acting in the platform console. */
export interface PlatformPrincipal {
  kind: 'platform';
  operatorId: string;
  role: PlatformRole;
  status: 'active' | 'disabled';
  /** The account has two-factor authentication turned on. */
  mfa: boolean;
  /** When the operator last signed in (step-up freshness). */
  authenticatedAt: Date;
}

export type PlatformDecision =
  | { allowed: true }
  | { allowed: false; reason: DenyReason; permission: PlatformPermission };

/** Permissions the operator's role gives (none while the operator is disabled). */
export function platformPermissions(principal: PlatformPrincipal): PlatformPermission[] {
  if (principal.status !== 'active') return [];
  return [...PLATFORM_ROLES[principal.role].permissions];
}

/**
 * Decides whether an operator may use a platform permission, in the same order as authorize():
 * status, role, MFA, then freshness.
 */
export function authorizePlatform(
  principal: PlatformPrincipal,
  permission: PlatformPermission,
  options: AuthorizeOptions = {},
): PlatformDecision {
  const deny = (reason: DenyReason): PlatformDecision => ({ allowed: false, reason, permission });
  if (principal.status !== 'active') return deny('inactive_principal');
  if (!platformPermissions(principal).includes(permission)) return deny('no_grant');
  const spec: PlatformPermissionSpec = PLATFORM_PERMISSIONS[permission];
  if (spec.mfa && !principal.mfa) return deny('mfa_required');
  if (spec.stepUp) {
    const now = options.now ?? new Date();
    const maxAge = options.stepUpMaxAgeMs ?? DEFAULT_STEP_UP_MAX_AGE_MS;
    if (now.getTime() - principal.authenticatedAt.getTime() > maxAge) {
      return deny('step_up_required');
    }
  }
  return { allowed: true };
}
