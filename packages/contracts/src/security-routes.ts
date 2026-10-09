import { z } from 'zod';
import type { RouteDef } from './routes.js';
import {
  AddSsoDomainRequest,
  ApproveSupportRequest,
  CreateSsoConnectionRequest,
  DecideSupportRequest,
  SsoConnection,
  SsoDomain,
  SsoSettings,
  SupportGrant,
  UpdateSsoConnectionRequest,
  WorkspaceNotices,
} from './security.js';

const idParam = (description: string) => z.object({ id: z.string().meta({ description }) });

/**
 * Enterprise sign-in (A13) and support access (A18). Every change needs a fresh sign-in, two-step
 * verification and the listed permission, and is recorded in the tenant's audit log.
 */
export const securityRoutes = {
  getSso: {
    method: 'get',
    path: '/v1/admin/sso',
    operationId: 'getSsoSettings',
    summary: 'Email domains and single sign-on connections of the tenant (security.manage)',
    tags: ['Security'],
    auth: 'staff_session',
    success: { status: 200, description: 'SSO settings', schema: SsoSettings },
  },
  addSsoDomain: {
    method: 'post',
    path: '/v1/admin/sso/domains',
    operationId: 'addSsoDomain',
    summary: 'Start proving an email domain: returns the DNS TXT record to publish',
    tags: ['Security'],
    auth: 'staff_session',
    body: AddSsoDomainRequest,
    success: { status: 201, description: 'Domain added, not yet verified', schema: SsoDomain },
  },
  verifySsoDomain: {
    method: 'post',
    path: '/v1/admin/sso/domains/{id}/verify',
    operationId: 'verifySsoDomain',
    summary:
      'Look up the DNS TXT record now; a domain another workspace already verified cannot be verified again',
    tags: ['Security'],
    auth: 'staff_session',
    params: idParam('Domain ID (sdom_…)'),
    success: { status: 200, description: 'Result of the check', schema: SsoDomain },
  },
  removeSsoDomain: {
    method: 'delete',
    path: '/v1/admin/sso/domains/{id}',
    operationId: 'removeSsoDomain',
    summary: 'Remove a domain that no SSO connection uses',
    tags: ['Security'],
    auth: 'staff_session',
    params: idParam('Domain ID (sdom_…)'),
    success: { status: 204, description: 'Removed' },
  },
  createSsoConnection: {
    method: 'post',
    path: '/v1/admin/sso/connections',
    operationId: 'createSsoConnection',
    summary:
      'Connect an OpenID Connect identity provider to a verified domain; its endpoints are discovered and checked, the client secret is stored encrypted and never returned',
    tags: ['Security'],
    auth: 'staff_session',
    body: CreateSsoConnectionRequest,
    success: { status: 201, description: 'Connection (a draft)', schema: SsoConnection },
  },
  updateSsoConnection: {
    method: 'patch',
    path: '/v1/admin/sso/connections/{id}',
    operationId: 'updateSsoConnection',
    summary:
      'Turn a connection on or off, require SSO for the domain, choose the role for just-in-time membership, or replace the client secret',
    tags: ['Security'],
    auth: 'staff_session',
    params: idParam('Connection ID (ssoc_…)'),
    body: UpdateSsoConnectionRequest,
    success: { status: 200, description: 'Connection', schema: SsoConnection },
  },
  deleteSsoConnection: {
    method: 'delete',
    path: '/v1/admin/sso/connections/{id}',
    operationId: 'deleteSsoConnection',
    summary: 'Remove a connection and its client secret; people sign in with their own passwords',
    tags: ['Security'],
    auth: 'staff_session',
    params: idParam('Connection ID (ssoc_…)'),
    success: { status: 204, description: 'Removed' },
  },
  listSupportGrants: {
    method: 'get',
    path: '/v1/admin/support-grants',
    operationId: 'listSupportGrants',
    summary: 'Support access requests and grants for this tenant (support.grant)',
    tags: ['Security'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Support access',
      schema: z.object({ items: z.array(SupportGrant) }),
    },
  },
  approveSupportGrant: {
    method: 'post',
    path: '/v1/admin/support-grants/{id}/approve',
    operationId: 'approveSupportGrant',
    summary:
      'Approve a support request, optionally narrower or shorter; access is read-only and ends at the time shown (support.grant)',
    tags: ['Security'],
    auth: 'staff_session',
    params: idParam('Support grant ID (sgr_…)'),
    body: ApproveSupportRequest,
    success: { status: 200, description: 'Approved', schema: SupportGrant },
  },
  declineSupportGrant: {
    method: 'post',
    path: '/v1/admin/support-grants/{id}/decline',
    operationId: 'declineSupportGrant',
    summary: 'Decline a support request (support.grant)',
    tags: ['Security'],
    auth: 'staff_session',
    params: idParam('Support grant ID (sgr_…)'),
    body: DecideSupportRequest,
    success: { status: 200, description: 'Declined', schema: SupportGrant },
  },
  revokeSupportGrant: {
    method: 'post',
    path: '/v1/admin/support-grants/{id}/revoke',
    operationId: 'revokeSupportGrant',
    summary: 'End support access now (support.grant)',
    tags: ['Security'],
    auth: 'staff_session',
    params: idParam('Support grant ID (sgr_…)'),
    body: DecideSupportRequest,
    success: { status: 200, description: 'Revoked', schema: SupportGrant },
  },
  workspaceNotices: {
    method: 'get',
    path: '/v1/workspace/notices',
    operationId: 'getWorkspaceNotices',
    summary:
      'Banners every member sees: active support access, platform incidents and, for people who manage integrations, channels that stopped working (any active member)',
    tags: ['Security'],
    auth: 'staff_session',
    success: { status: 200, description: 'Notices', schema: WorkspaceNotices },
  },
} as const satisfies Record<string, RouteDef>;
