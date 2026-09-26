/**
 * The permission catalog. Every backend interface checks one of these through authorize();
 * the Studio renders the same catalog, so what a role shows is exactly what it can do.
 */

export const SCOPE_TYPES = ['tenant', 'workspace', 'brand', 'team', 'inbox'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export interface PermissionSpec {
  /** Plain-language description shown in role editors (English source; translated in i18n). */
  description: string;
  /** The narrowest scope types a grant of this permission can carry. */
  scopes: readonly ScopeType[];
  /** Requires a recent authentication (fresh session) before use. */
  stepUp?: true;
  /** Requires a session that passed multi-factor authentication. */
  mfa?: true;
}

const ALL: readonly ScopeType[] = SCOPE_TYPES;
const TENANT: readonly ScopeType[] = ['tenant'];
const WORKSPACE: readonly ScopeType[] = ['tenant', 'workspace'];
const BRAND: readonly ScopeType[] = ['tenant', 'workspace', 'brand'];

export const PERMISSIONS = {
  'conversations.read': { description: 'Read conversations and customer history', scopes: ALL },
  'conversations.reply': { description: 'Reply to customers', scopes: ALL },
  'conversations.note': { description: 'Write internal notes', scopes: ALL },
  'conversations.assign': { description: 'Assign and transfer conversations', scopes: ALL },
  'conversations.takeover': {
    description: 'Take over a conversation from the AI or another person',
    scopes: ALL,
  },
  'conversations.export': {
    description: 'Export conversation transcripts',
    scopes: BRAND,
    stepUp: true,
  },
  'inbox.manage': { description: 'Configure inboxes, routing and business hours', scopes: BRAND },
  'teams.manage': { description: 'Create teams and manage membership', scopes: WORKSPACE },
  'members.read': { description: 'See team members and their roles', scopes: ALL },
  'members.invite': { description: 'Invite members', scopes: WORKSPACE },
  'members.remove': { description: 'Suspend or remove members', scopes: WORKSPACE, stepUp: true },
  'roles.manage': { description: 'Create and edit custom roles', scopes: TENANT, stepUp: true },
  'grants.manage': {
    description: 'Grant and revoke roles within your own scope',
    scopes: ALL,
    stepUp: true,
  },
  'audit.read': { description: 'Read the audit log', scopes: WORKSPACE },
  'audit.export': { description: 'Export the audit log', scopes: TENANT, stepUp: true },
  'brands.manage': { description: 'Create brands and set allowed websites', scopes: WORKSPACE },
  'widget.configure': { description: 'Configure the chat widget', scopes: BRAND },
  'agents.read': { description: 'View AI agents and their versions', scopes: BRAND },
  'agents.manage': { description: 'Edit AI agent drafts', scopes: BRAND },
  'agents.publish': { description: 'Publish or roll back AI agents', scopes: BRAND, stepUp: true },
  'knowledge.read': { description: 'Read knowledge sources', scopes: BRAND },
  'knowledge.manage': { description: 'Add, edit and retire knowledge', scopes: BRAND },
  'tools.manage': {
    description: 'Configure tools and action policies',
    scopes: BRAND,
    stepUp: true,
  },
  'tools.approve': { description: 'Approve actions proposed by AI agents', scopes: ALL },
  'decisions.read': { description: 'Review routing and quality decisions', scopes: BRAND },
  'decisions.manage': {
    description: 'Edit decision rubrics and thresholds',
    scopes: BRAND,
    stepUp: true,
  },
  'memory.read': { description: 'Read customer memory records', scopes: BRAND },
  'memory.manage': { description: 'Correct or restrict memory records', scopes: BRAND },
  'memory.delete': { description: 'Delete memory records', scopes: BRAND, stepUp: true },
  'commerce.read': { description: 'See carts, quotes and orders', scopes: BRAND },
  'commerce.manage': {
    description: 'Configure merchants and catalog sync',
    scopes: BRAND,
    stepUp: true,
  },
  'commerce.refund': { description: 'Issue refunds', scopes: BRAND, stepUp: true, mfa: true },
  'analytics.read': { description: 'View analytics and reports', scopes: ALL },
  'billing.manage': {
    description: 'Manage plan, invoices and payment',
    scopes: TENANT,
    stepUp: true,
  },
  'api_keys.manage': {
    description: 'Create and revoke API keys',
    scopes: WORKSPACE,
    stepUp: true,
    mfa: true,
  },
  'webhooks.manage': {
    description: 'Configure outgoing webhooks',
    scopes: WORKSPACE,
    stepUp: true,
  },
  'integrations.manage': {
    description: 'Connect channels and third-party services',
    scopes: WORKSPACE,
    stepUp: true,
  },
  'secrets.manage': {
    description: 'Store and rotate credentials',
    scopes: WORKSPACE,
    stepUp: true,
    mfa: true,
  },
  'extensions.manage': {
    description: 'Install and remove extensions',
    scopes: TENANT,
    stepUp: true,
  },
  'migration.manage': {
    description: 'Import data from other platforms',
    scopes: TENANT,
    stepUp: true,
  },
  'settings.manage': { description: 'Edit workspace settings', scopes: WORKSPACE },
  'security.manage': {
    description: 'Configure sign-in, SSO, MFA and session policies',
    scopes: TENANT,
    stepUp: true,
    mfa: true,
  },
  'support.grant': {
    description: 'Allow platform support to access this workspace',
    scopes: TENANT,
    stepUp: true,
    mfa: true,
  },
} as const satisfies Record<string, PermissionSpec>;

export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}

export function permissionSpec(permission: Permission): PermissionSpec {
  return PERMISSIONS[permission];
}

/**
 * A role entry: an exact permission, `area.*` (every permission in an area) or `*` (all).
 * Expanding patterns against the catalog keeps grants explicit when the catalog grows.
 */
export type PermissionPattern = Permission | `${string}.*` | '*';

export function matchesPattern(pattern: string, permission: Permission): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return permission.startsWith(pattern.slice(0, -1));
  return pattern === permission;
}

export function expandPatterns(patterns: readonly string[]): Permission[] {
  return PERMISSION_KEYS.filter((permission) =>
    patterns.some((p) => matchesPattern(p, permission)),
  );
}

export function validatePatterns(patterns: readonly string[]): string[] {
  return patterns.filter(
    (p) =>
      p !== '*' &&
      !(p.endsWith('.*') && PERMISSION_KEYS.some((k) => k.startsWith(p.slice(0, -1)))) &&
      !isPermission(p),
  );
}
