import { z } from 'zod';
import { CreateTenantRequest, TenantSummary } from './admin.js';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';
import type { RouteDef } from './routes.js';

export const AgencyBranding = z.object({
  displayName: z.string().trim().min(1).max(120).nullable(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
});

export const AgencySettings = z
  .object({
    enabled: z.boolean(),
    branding: AgencyBranding,
    clientLimit: z.number().int().min(1).max(1000).nullable(),
  })
  .meta({ id: 'AgencySettings' });

export const UpdateAgencySettingsRequest = z
  .object({
    enabled: z.boolean().optional(),
    branding: AgencyBranding.partial().optional(),
    clientLimit: z.number().int().min(1).max(1000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Supply at least one setting')
  .meta({ id: 'UpdateAgencySettingsRequest' });

export const AgencyClient = z
  .object({
    tenant: TenantSummary,
    linkedAt: Timestamp,
    /** True only when the signed-in person has an active membership in this client tenant. */
    canAccess: z.boolean(),
  })
  .meta({ id: 'AgencyClient' });

export const LinkAgencyClientRequest = z
  .object({ tenantId: typeId('tenant') })
  .meta({ id: 'LinkAgencyClientRequest' });

export const CreateAgencyClientRequest = CreateTenantRequest.meta({
  id: 'CreateAgencyClientRequest',
});

const clientParams = z.object({ tenantId: typeId('tenant') });

export const agencyRoutes = {
  getAgency: {
    method: 'get',
    path: '/v1/admin/agency',
    operationId: 'getAgencySettings',
    summary: 'Agency mode and defaults (agency.read)',
    tags: ['Agency'],
    auth: 'staff_session',
    success: { status: 200, description: 'Agency settings', schema: AgencySettings },
  },
  updateAgency: {
    method: 'patch',
    path: '/v1/admin/agency',
    operationId: 'updateAgencySettings',
    summary: 'Enable agency mode or update its defaults (agency.manage, fresh sign-in)',
    tags: ['Agency'],
    auth: 'staff_session',
    body: UpdateAgencySettingsRequest,
    success: { status: 200, description: 'Updated settings', schema: AgencySettings },
  },
  listAgencyClients: {
    method: 'get',
    path: '/v1/admin/agency/clients',
    operationId: 'listAgencyClients',
    summary: 'Linked client tenant metadata and current user access (agency.read)',
    tags: ['Agency'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Client directory',
      schema: z.object({ items: z.array(AgencyClient) }),
    },
  },
  getAgencyClient: {
    method: 'get',
    path: '/v1/admin/agency/clients/{tenantId}',
    operationId: 'getAgencyClient',
    summary: 'Linked client metadata (agency.read)',
    tags: ['Agency'],
    auth: 'staff_session',
    params: clientParams,
    success: { status: 200, description: 'Client', schema: AgencyClient },
  },
  createAgencyClient: {
    method: 'post',
    path: '/v1/admin/agency/clients',
    operationId: 'createAgencyClient',
    summary: 'Create an independent client tenant and link it (agency.manage)',
    tags: ['Agency'],
    auth: 'staff_session',
    body: CreateAgencyClientRequest,
    idempotent: true,
    success: { status: 201, description: 'Client created and linked', schema: AgencyClient },
  },
  linkAgencyClient: {
    method: 'post',
    path: '/v1/admin/agency/clients/link',
    operationId: 'linkAgencyClient',
    summary:
      'Link an existing tenant the caller also administers (agency.manage and child grants.manage)',
    tags: ['Agency'],
    auth: 'staff_session',
    body: LinkAgencyClientRequest,
    success: { status: 201, description: 'Client linked', schema: AgencyClient },
  },
  unlinkAgencyClient: {
    method: 'delete',
    path: '/v1/admin/agency/clients/{tenantId}',
    operationId: 'unlinkAgencyClient',
    summary: 'Remove a directory link; client tenant and memberships remain (agency.manage)',
    tags: ['Agency'],
    auth: 'staff_session',
    params: clientParams,
    success: { status: 204, description: 'Client unlinked' },
  },
} as const satisfies Record<string, RouteDef>;
