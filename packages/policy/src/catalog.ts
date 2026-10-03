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
  /**
   * Shared reference data (not customer data): any grant holding the permission applies wherever
   * the resource lives, e.g. an agent scoped to a team may read the brand's knowledge base.
   */
  reference?: true;
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
  'conversations.status': {
    description: 'Resolve, reopen and snooze conversations',
    scopes: ALL,
  },
  'conversations.tag': {
    description: 'Tag conversations and fill in their custom fields',
    scopes: ALL,
  },
  'conversations.bulk': {
    description: 'Change many conversations at once',
    scopes: ALL,
  },
  'conversations.review': {
    description: 'Review and coach other people’s conversations',
    scopes: ALL,
  },
  'conversations.export': {
    description: 'Export conversation transcripts',
    scopes: BRAND,
    stepUp: true,
  },
  'inbox.manage': {
    description: 'Configure inboxes, routing and business hours',
    scopes: ['tenant', 'workspace', 'brand', 'inbox'],
  },
  'teams.manage': { description: 'Create teams and manage membership', scopes: WORKSPACE },
  'members.read': { description: 'See team members and their roles', scopes: ALL, reference: true },
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
  'widget.proactive': {
    description: 'Choose when the chat invites website visitors to talk',
    scopes: BRAND,
  },
  'widget.identity_keys': {
    description: 'Register the keys that verify customer identity',
    scopes: BRAND,
    stepUp: true,
    mfa: true,
  },
  'agents.read': { description: 'View AI agents and their versions', scopes: ALL, reference: true },
  'agents.manage': { description: 'Edit AI agent drafts', scopes: BRAND },
  'agents.publish': { description: 'Publish or roll back AI agents', scopes: BRAND, stepUp: true },
  'knowledge.read': { description: 'Read knowledge sources', scopes: ALL, reference: true },
  'knowledge.manage': { description: 'Add, edit and retire knowledge', scopes: BRAND },
  'tools.read': {
    description: 'See tools, action policies, AI actions and simulation results',
    scopes: ALL,
    reference: true,
  },
  'tools.manage': {
    description: 'Configure tools and action policies',
    scopes: BRAND,
    stepUp: true,
  },
  'tools.approve': { description: 'Approve actions proposed by AI agents', scopes: ALL },
  'decisions.read': { description: 'Review routing and quality decisions', scopes: ALL },
  'decisions.manage': {
    description: 'Edit decision rubrics and thresholds',
    scopes: BRAND,
    stepUp: true,
  },
  'memory.read': { description: 'Read customer memory records', scopes: ALL },
  'memory.manage': { description: 'Correct or restrict memory records', scopes: BRAND },
  'memory.delete': { description: 'Delete memory records', scopes: BRAND, stepUp: true },
  'memory.erase': {
    description: 'Erase everything remembered about a customer',
    scopes: BRAND,
    stepUp: true,
  },
  'memory.export': {
    description: 'Export everything remembered about a customer',
    scopes: BRAND,
    stepUp: true,
  },
  'commerce.read': {
    description: 'See carts, quotes, orders, payments and refunds',
    scopes: ALL,
  },
  'commerce.carts.manage': {
    description: 'Share products and prepare quotes in conversations',
    scopes: ALL,
  },
  'commerce.orders.manage': { description: 'Record fulfilment updates on orders', scopes: ALL },
  'commerce.refunds.request': { description: 'Ask for a refund for a customer', scopes: ALL },
  'commerce.refunds.approve': {
    description: 'Approve or reject refunds',
    scopes: BRAND,
    stepUp: true,
    mfa: true,
  },
  'commerce.exceptions.resolve': {
    description: 'Resolve payment and refund exceptions after checking with the provider',
    scopes: BRAND,
    stepUp: true,
  },
  'commerce.merchants.manage': {
    description: 'Connect merchants and set their credentials and refund rules',
    scopes: BRAND,
    stepUp: true,
    mfa: true,
  },
  'analytics.read': { description: 'View analytics and reports', scopes: ALL },
  'billing.read': {
    description: 'See the plan, usage against its limits, and invoices',
    scopes: TENANT,
  },
  'billing.manage': {
    description: 'Set usage budgets and the alerts before a limit',
    scopes: TENANT,
    stepUp: true,
  },
  'api_keys.read': {
    description: 'See API keys, their scopes and when they were last used',
    scopes: TENANT,
  },
  'api_keys.manage': {
    description: 'Create, rotate and revoke API keys',
    scopes: TENANT,
    stepUp: true,
    mfa: true,
  },
  'webhooks.read': {
    description: 'See webhook endpoints and their delivery log',
    scopes: TENANT,
  },
  'webhooks.manage': {
    description:
      'Add and change webhook endpoints, rotate their signing secrets and replay deliveries',
    scopes: TENANT,
    stepUp: true,
  },
  'network.manage': {
    description: 'Choose which outside hosts Hamnivo may call for this workspace',
    scopes: TENANT,
    stepUp: true,
  },
  'mcp.read': {
    description:
      'Let AI assistants such as Claude read conversations, knowledge and customer memory through Hamnivo’s MCP server',
    scopes: BRAND,
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
  'migration.review': {
    description: 'See imports, their reports and sample conversations',
    scopes: BRAND,
  },
  'migration.run': {
    description: 'Upload exports, and run, pause, resume or cancel imports',
    scopes: BRAND,
    stepUp: true,
  },
  'migration.manage': {
    description: 'Approve an import for cutover or roll it back',
    scopes: BRAND,
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

/**
 * What an API key can be given. Service accounts cannot sign in again or pass two-step
 * verification, so permissions that need either stay with people; and a key only gets what an
 * API route actually accepts keys for, so every scope a key shows is one it can use.
 */
export const API_KEY_PERMISSIONS = [
  'analytics.read',
  'billing.read',
  'webhooks.read',
  'mcp.read',
] as const satisfies readonly Permission[];
export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number];

export function isApiKeyPermission(value: string): value is ApiKeyPermission {
  return (API_KEY_PERMISSIONS as readonly string[]).includes(value);
}

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}

export function permissionSpec(permission: Permission): PermissionSpec {
  return PERMISSIONS[permission];
}

/** Whether a permission has an effect in a grant at this scope level. */
export function appliesAtScope(permission: Permission, scopeType: ScopeType): boolean {
  return (PERMISSIONS[permission].scopes as readonly ScopeType[]).includes(scopeType);
}

/** Permissions of a role that would be inactive if granted at this scope level (shown in the UI). */
export function inapplicablePermissions(
  patterns: readonly string[],
  scopeType: ScopeType,
): Permission[] {
  return expandPatterns(patterns).filter((p) => !appliesAtScope(p, scopeType));
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
