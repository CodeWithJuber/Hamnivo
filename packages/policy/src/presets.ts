import { expandPatterns, type Permission } from './catalog.js';

export interface RolePreset {
  key: string;
  name: string;
  description: string;
  patterns: readonly string[];
}

/** Built-in roles (A02). Tenants copy and adjust them as custom roles (A12). */
export const ROLE_PRESETS = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full control, including billing, security and support access',
    patterns: ['*'],
  },
  {
    key: 'admin',
    name: 'Administrator',
    description: 'Manages people, channels, AI and settings; no billing',
    patterns: [
      'conversations.*',
      'inbox.*',
      'visitors.*',
      'teams.*',
      'members.*',
      'roles.*',
      'grants.*',
      'audit.*',
      'brands.*',
      'widget.*',
      'agents.*',
      'automations.*',
      'knowledge.*',
      'tools.*',
      'decisions.*',
      'memory.*',
      'commerce.*',
      'analytics.*',
      'api_keys.*',
      'webhooks.*',
      'mcp.*',
      'integrations.*',
      'secrets.*',
      'extensions.*',
      'migration.*',
      'settings.*',
      'security.*',
      'network.*',
    ],
  },
  {
    key: 'supervisor',
    name: 'Supervisor',
    description: 'Leads a team: routing, takeovers, approvals and quality review',
    patterns: [
      'conversations.*',
      'inbox.manage',
      'visitors.block',
      'members.read',
      'grants.manage',
      'audit.read',
      'agents.read',
      'automations.read',
      'knowledge.read',
      'tools.read',
      'tools.approve',
      'decisions.read',
      'memory.read',
      'commerce.read',
      'commerce.carts.manage',
      'commerce.orders.manage',
      'commerce.refunds.request',
      'commerce.refunds.approve',
      'analytics.read',
    ],
  },
  {
    key: 'agent',
    name: 'Support agent',
    description: 'Handles conversations and approves customer actions',
    patterns: [
      'conversations.read',
      'conversations.reply',
      'conversations.note',
      'conversations.takeover',
      'conversations.status',
      'conversations.tag',
      'members.read',
      'knowledge.read',
      'tools.read',
      'tools.approve',
      'commerce.read',
      'commerce.carts.manage',
      'commerce.refunds.request',
    ],
  },
  {
    key: 'finance',
    name: 'Finance',
    description: 'Approves refunds and resolves payment exceptions',
    patterns: [
      'commerce.read',
      'commerce.refunds.approve',
      'commerce.exceptions.resolve',
      'members.read',
      'analytics.read',
    ],
  },
  {
    key: 'knowledge_editor',
    name: 'Knowledge editor',
    description: 'Maintains the knowledge the AI answers from',
    patterns: ['knowledge.*', 'agents.read', 'conversations.read'],
  },
  {
    key: 'developer',
    name: 'Developer',
    description: 'Installs the widget and connects systems',
    patterns: [
      'widget.configure',
      'api_keys.read',
      'api_keys.manage',
      'webhooks.read',
      'webhooks.manage',
      'integrations.manage',
      'agents.read',
      'members.read',
    ],
  },
  {
    key: 'analyst',
    name: 'Analyst',
    description: 'Read-only reporting',
    patterns: ['analytics.read', 'conversations.read', 'decisions.read'],
  },
  {
    key: 'billing',
    name: 'Billing manager',
    description: 'Plan, invoices and usage',
    patterns: ['billing.read', 'billing.manage', 'analytics.read'],
  },
] as const satisfies readonly RolePreset[];

export type RolePresetKey = (typeof ROLE_PRESETS)[number]['key'];

export function presetPermissions(key: RolePresetKey): Permission[] {
  const preset = ROLE_PRESETS.find((p) => p.key === key);
  if (!preset) throw new RangeError(`Unknown role preset: ${key}`);
  return expandPatterns(preset.patterns);
}

/**
 * The permission patterns a stored role grants. Built-in roles cannot be edited, so they follow
 * the product's current definition: a permission added to a preset later (for example resolving
 * conversations for agents) reaches workspaces created before the change too.
 */
export function rolePatterns(role: {
  key: string;
  isPreset: boolean;
  permissions: readonly string[];
}): string[] {
  const preset = role.isPreset ? ROLE_PRESETS.find((p) => p.key === role.key) : undefined;
  return [...(preset ? preset.patterns : role.permissions)];
}
