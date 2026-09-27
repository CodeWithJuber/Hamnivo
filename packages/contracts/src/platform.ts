import { z } from 'zod';
import { AuditEventView, TenantStatus } from './admin.js';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';
import { IncidentSeverity, SupportGrant, SupportScope } from './security.js';

/**
 * Platform operations console (A17, board 26). Operators see service health and tenant metadata,
 * never tenant content; content is readable only through a support grant the tenant approved.
 */

export const PlatformOperator = z
  .object({
    id: typeId('operator'),
    name: z.string(),
    email: z.string(),
    role: z.enum(['platform_admin', 'support_operator', 'platform_viewer']),
    permissions: z.array(z.string()),
    /** The operator's account has two-step verification on (needed for support access). */
    mfa: z.boolean(),
  })
  .meta({ id: 'PlatformOperator' });
export type PlatformOperator = z.infer<typeof PlatformOperator>;

export const PlatformTenant = z
  .object({
    id: typeId('tenant'),
    name: z.string(),
    slug: z.string(),
    status: TenantStatus,
    region: z.string(),
    createdAt: Timestamp,
    workspaces: z.number().int(),
    brands: z.number().int(),
    connectors: z.object({ total: z.number().int(), unhealthy: z.number().int() }),
    /** Active AI stops (kill switches) in the tenant. */
    aiStops: z.number().int(),
    /** Model provider connections that are switched off. */
    providersOff: z.number().int(),
    activeSupportGrants: z.number().int(),
  })
  .meta({ id: 'PlatformTenant' });
export type PlatformTenant = z.infer<typeof PlatformTenant>;

export const PlatformTenantDetail = PlatformTenant.extend({
  defaultLocale: z.string(),
  workspaceList: z.array(
    z.object({ id: typeId('workspace'), name: z.string(), status: z.string() }),
  ),
  brandList: z.array(
    z.object({ id: typeId('brand'), name: z.string(), status: z.enum(['active', 'disabled']) }),
  ),
  connectorList: z.array(
    z.object({
      id: typeId('connection'),
      kind: z.string(),
      status: z.string(),
      lastHealthAt: Timestamp.nullable(),
    }),
  ),
  aiStopList: z.array(
    z.object({
      id: typeId('killSwitch'),
      scope: z.enum(['tenant', 'brand', 'agent']),
      since: Timestamp,
    }),
  ),
  providerList: z.array(z.object({ provider: z.string(), status: z.enum(['active', 'disabled']) })),
  supportGrants: z.array(SupportGrant),
}).meta({ id: 'PlatformTenantDetail' });
export type PlatformTenantDetail = z.infer<typeof PlatformTenantDetail>;

export const ServiceState = z.enum(['healthy', 'degraded', 'down']);

export const PlatformHealth = z
  .object({
    checkedAt: Timestamp,
    services: z.array(
      z.object({
        key: z.enum(['api', 'database', 'valkey', 'queue', 'connectors']),
        state: ServiceState,
      }),
    ),
    queue: z.object({
      pending: z.number().int(),
      /** Age of the oldest event still waiting, in seconds. */
      oldestSeconds: z.number().int().nullable(),
      /** Events retried at least three times without success. */
      failing: z.number().int(),
    }),
    connectors: z.object({
      total: z.number().int(),
      degraded: z.number().int(),
      disabled: z.number().int(),
    }),
    /** Platform model keys set on this server (never the keys themselves). */
    providers: z.array(z.object({ provider: z.string(), configured: z.boolean() })),
  })
  .meta({ id: 'PlatformHealth' });
export type PlatformHealth = z.infer<typeof PlatformHealth>;

export const Incident = z
  .object({
    id: typeId('incident'),
    title: z.string(),
    message: z.string(),
    severity: IncidentSeverity,
    status: z.enum(['active', 'resolved']),
    startedAt: Timestamp,
    resolvedAt: Timestamp.nullable(),
  })
  .meta({ id: 'Incident' });
export type Incident = z.infer<typeof Incident>;

export const PlatformOverview = z
  .object({
    tenants: z.object({
      total: z.number().int(),
      active: z.number().int(),
      suspended: z.number().int(),
    }),
    activeSupportGrants: z.number().int(),
    pendingSupportRequests: z.number().int(),
    aiStops: z.number().int(),
    providersOff: z.number().int(),
    incidents: z.array(Incident),
  })
  .meta({ id: 'PlatformOverview' });
export type PlatformOverview = z.infer<typeof PlatformOverview>;

export const CreateIncidentRequest = z
  .object({
    title: z.string().trim().min(3).max(120),
    /** Shown to every workspace; say what is affected and what still works. */
    message: z.string().trim().min(3).max(600),
    severity: IncidentSeverity,
  })
  .meta({ id: 'CreateIncidentRequest' });

export const RequestSupportAccessRequest = z
  .object({
    tenantId: typeId('tenant'),
    reason: z.string().trim().min(10).max(400),
    scopes: z.array(SupportScope).min(1).max(3).default(['configuration']),
    durationMinutes: z.number().int().min(5).max(1440).default(30),
  })
  .meta({ id: 'RequestSupportAccessRequest' });

/** Read-only configuration of a tenant, through an approved support grant. */
export const SupportConfiguration = z
  .object({
    members: z.array(
      z.object({
        displayName: z.string(),
        email: z.string(),
        status: z.string(),
        roles: z.array(z.string()),
      }),
    ),
    roles: z.array(
      z.object({ name: z.string(), isPreset: z.boolean(), permissions: z.array(z.string()) }),
    ),
    brands: z.array(
      z.object({ name: z.string(), status: z.string(), allowedOrigins: z.array(z.string()) }),
    ),
    agents: z.array(z.object({ name: z.string(), status: z.string(), live: z.boolean() })),
  })
  .meta({ id: 'SupportConfiguration' });
export type SupportConfiguration = z.infer<typeof SupportConfiguration>;

export const SupportConversations = z
  .object({
    items: z.array(
      z.object({
        id: typeId('conversation'),
        status: z.string(),
        ownerMode: z.string(),
        lastActivityAt: Timestamp,
      }),
    ),
  })
  .meta({ id: 'SupportConversations' });
export type SupportConversations = z.infer<typeof SupportConversations>;

export const SupportAudit = z
  .object({ items: z.array(AuditEventView) })
  .meta({ id: 'SupportAudit' });
export type SupportAudit = z.infer<typeof SupportAudit>;

export const PlatformAuditEvent = z
  .object({
    seq: z.number().int(),
    occurredAt: Timestamp,
    operator: z.object({ id: typeId('operator'), name: z.string() }).nullable(),
    action: z.string(),
    tenant: z.object({ id: typeId('tenant'), name: z.string() }).nullable(),
    target: z.object({ type: z.string(), id: z.string().nullable() }).nullable(),
    outcome: z.enum(['success', 'denied', 'failed']),
    reason: z.string().nullable(),
    data: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'PlatformAuditEvent' });
export type PlatformAuditEvent = z.infer<typeof PlatformAuditEvent>;

export const PlatformAuditPage = z
  .object({ items: z.array(PlatformAuditEvent), nextBefore: z.number().int().nullable() })
  .meta({ id: 'PlatformAuditPage' });
export type PlatformAuditPage = z.infer<typeof PlatformAuditPage>;
