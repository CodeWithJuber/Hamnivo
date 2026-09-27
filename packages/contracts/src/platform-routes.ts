import { z } from 'zod';
import {
  CreateIncidentRequest,
  Incident,
  PlatformAuditPage,
  PlatformHealth,
  PlatformOperator,
  PlatformOverview,
  PlatformTenant,
  PlatformTenantDetail,
  RequestSupportAccessRequest,
  SupportAudit,
  SupportConfiguration,
  SupportConversations,
} from './platform.js';
import type { RouteDef } from './routes.js';
import { SupportGrant } from './security.js';

const idParam = (description: string) => z.object({ id: z.string().meta({ description }) });

/**
 * Platform operations console (A17). Callers are platform operators (named by the server
 * administrator) with platform permissions; tenant roles give no access here. Reads use the
 * hamnivo_platform database role, which sees metadata only.
 */
export const platformRoutes = {
  platformMe: {
    method: 'get',
    path: '/v1/platform/me',
    operationId: 'getPlatformOperator',
    summary: 'The signed-in platform operator and their platform permissions',
    tags: ['Platform'],
    auth: 'staff_session',
    success: { status: 200, description: 'Operator', schema: PlatformOperator },
  },
  platformOverview: {
    method: 'get',
    path: '/v1/platform/overview',
    operationId: 'getPlatformOverview',
    summary: 'Tenant counts, support access, AI stops, switched-off providers and incidents',
    tags: ['Platform'],
    auth: 'staff_session',
    success: { status: 200, description: 'Overview', schema: PlatformOverview },
  },
  platformTenants: {
    method: 'get',
    path: '/v1/platform/tenants',
    operationId: 'listPlatformTenants',
    summary: 'Tenant directory: state, region and service metadata, never content',
    tags: ['Platform'],
    auth: 'staff_session',
    query: z.object({ query: z.string().trim().max(120).optional() }),
    success: {
      status: 200,
      description: 'Tenants',
      schema: z.object({ items: z.array(PlatformTenant) }),
    },
  },
  platformTenant: {
    method: 'get',
    path: '/v1/platform/tenants/{id}',
    operationId: 'getPlatformTenant',
    summary: 'Operational metadata of one tenant (platform.tenants.read)',
    tags: ['Platform'],
    auth: 'staff_session',
    params: idParam('Tenant ID (tnt_…)'),
    success: { status: 200, description: 'Tenant', schema: PlatformTenantDetail },
  },
  platformHealth: {
    method: 'get',
    path: '/v1/platform/health',
    operationId: 'getPlatformHealth',
    summary: 'Service health: database, Valkey, the event queue and connectors',
    tags: ['Platform'],
    auth: 'staff_session',
    success: { status: 200, description: 'Health', schema: PlatformHealth },
  },
  listPlatformSupportGrants: {
    method: 'get',
    path: '/v1/platform/support-grants',
    operationId: 'listPlatformSupportGrants',
    summary: 'Support access you asked for, with its state',
    tags: ['Platform'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Support access',
      schema: z.object({ items: z.array(SupportGrant) }),
    },
  },
  requestSupportAccess: {
    method: 'post',
    path: '/v1/platform/support-grants',
    operationId: 'requestSupportAccess',
    summary:
      'Ask a tenant for temporary, read-only support access; its owners decide (platform.support.request)',
    tags: ['Platform'],
    auth: 'staff_session',
    body: RequestSupportAccessRequest,
    success: { status: 201, description: 'Request sent', schema: SupportGrant },
  },
  endSupportGrant: {
    method: 'post',
    path: '/v1/platform/support-grants/{id}/end',
    operationId: 'endSupportGrant',
    summary: 'End your support session early',
    tags: ['Platform'],
    auth: 'staff_session',
    params: idParam('Support grant ID (sgr_…)'),
    success: { status: 200, description: 'Ended', schema: SupportGrant },
  },
  supportConfiguration: {
    method: 'get',
    path: '/v1/platform/support-grants/{id}/configuration',
    operationId: 'readSupportConfiguration',
    summary:
      'Read the tenant’s members, roles, brands and agents through an active grant with the configuration scope (audited on both sides)',
    tags: ['Platform'],
    auth: 'staff_session',
    params: idParam('Support grant ID (sgr_…)'),
    success: { status: 200, description: 'Configuration', schema: SupportConfiguration },
  },
  supportConversations: {
    method: 'get',
    path: '/v1/platform/support-grants/{id}/conversations',
    operationId: 'readSupportConversations',
    summary:
      'List the tenant’s recent conversations (state only) through an active grant with the conversations scope (audited on both sides)',
    tags: ['Platform'],
    auth: 'staff_session',
    params: idParam('Support grant ID (sgr_…)'),
    success: { status: 200, description: 'Conversations', schema: SupportConversations },
  },
  supportAudit: {
    method: 'get',
    path: '/v1/platform/support-grants/{id}/audit',
    operationId: 'readSupportAudit',
    summary:
      'Read the tenant’s latest audit events through an active grant with the audit scope (audited on both sides)',
    tags: ['Platform'],
    auth: 'staff_session',
    params: idParam('Support grant ID (sgr_…)'),
    success: { status: 200, description: 'Audit events', schema: SupportAudit },
  },
  listIncidents: {
    method: 'get',
    path: '/v1/platform/incidents',
    operationId: 'listIncidents',
    summary: 'Active and recent incidents',
    tags: ['Platform'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Incidents',
      schema: z.object({ items: z.array(Incident) }),
    },
  },
  createIncident: {
    method: 'post',
    path: '/v1/platform/incidents',
    operationId: 'createIncident',
    summary:
      'Declare an incident; every workspace sees its banner until it is resolved (platform.incidents.manage)',
    tags: ['Platform'],
    auth: 'staff_session',
    body: CreateIncidentRequest,
    success: { status: 201, description: 'Declared', schema: Incident },
  },
  resolveIncident: {
    method: 'post',
    path: '/v1/platform/incidents/{id}/resolve',
    operationId: 'resolveIncident',
    summary: 'Resolve an incident and lift its banner (platform.incidents.manage)',
    tags: ['Platform'],
    auth: 'staff_session',
    params: idParam('Incident ID (inc_…)'),
    success: { status: 200, description: 'Resolved', schema: Incident },
  },
  platformAudit: {
    method: 'get',
    path: '/v1/platform/audit',
    operationId: 'listPlatformAudit',
    summary: 'Platform audit log, newest first (platform.audit.read)',
    tags: ['Platform'],
    auth: 'staff_session',
    query: z.object({
      before: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
    success: { status: 200, description: 'Events', schema: PlatformAuditPage },
  },
} as const satisfies Record<string, RouteDef>;
