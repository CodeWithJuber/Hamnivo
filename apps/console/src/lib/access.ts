import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from './api';
import { keys as studioKeys, useStudioQuery } from './queries';
import { useTenant } from './tenant';
import type {
  AuditPage,
  Invitation,
  Items,
  PermissionInfo,
  Role,
  SsoSettings,
  SupportGrant,
  Team,
  WorkspaceNotices,
} from './types';

/** Query keys for team and access, SSO and support access (under the tenant, as everywhere). */
export const accessKeys = {
  members: studioKeys.members,
  invitations: ['invitations'],
  roles: ['roles'],
  permissions: ['permissions'],
  teams: ['teams'],
  audit: ['audit'],
  sso: ['sso'],
  supportGrants: ['support-grants'],
  notices: ['notices'],
} as const;

export function useInvitations() {
  const { can } = useTenant();
  return useStudioQuery<Items<Invitation>>(accessKeys.invitations, '/v1/admin/invitations', {
    enabled: can('members.read'),
  });
}

export function useRoles() {
  const { can } = useTenant();
  return useStudioQuery<Items<Role>>(accessKeys.roles, '/v1/admin/roles', {
    enabled: can('members.read'),
  });
}

/** The permission catalog, with what the caller may put into a role (grantable). */
export function usePermissionCatalog() {
  return useStudioQuery<Items<PermissionInfo>>(accessKeys.permissions, '/v1/admin/permissions');
}

export function useTeams() {
  const { can } = useTenant();
  return useStudioQuery<Items<Team>>(accessKeys.teams, '/v1/admin/teams', {
    enabled: can('members.read'),
  });
}

export interface AuditQuery {
  action?: string | undefined;
  actorId?: string | undefined;
  targetId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export function auditSearch(filters: AuditQuery): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.action) query.set('action', filters.action);
  if (filters.actorId) query.set('actorId', filters.actorId);
  if (filters.targetId) query.set('targetId', filters.targetId);
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  return query;
}

/** The audit trail, newest first, page by page (A09). */
export function useAuditLog(filters: AuditQuery, pageSize = 50) {
  const { tenantId, can } = useTenant();
  return useInfiniteQuery({
    queryKey: [tenantId, ...accessKeys.audit, filters, pageSize],
    queryFn: ({ pageParam, signal }) => {
      const query = auditSearch(filters);
      query.set('limit', String(pageSize));
      if (pageParam) query.set('before', String(pageParam));
      return api<AuditPage>(`/v1/admin/audit?${query}`, { tenant: tenantId, signal });
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    meta: { studio: true },
    enabled: can('audit.read'),
  });
}

export function useSsoSettings() {
  const { can } = useTenant();
  return useStudioQuery<SsoSettings>(accessKeys.sso, '/v1/admin/sso', {
    enabled: can('security.manage'),
  });
}

export function useSupportGrants() {
  const { can } = useTenant();
  return useStudioQuery<Items<SupportGrant>>(accessKeys.supportGrants, '/v1/admin/support-grants', {
    enabled: can('support.grant'),
    refetchInterval: 30_000,
  });
}

/** Support access in use and platform incidents, for every member's banners. */
export function useWorkspaceNotices() {
  return useStudioQuery<WorkspaceNotices>(accessKeys.notices, '/v1/workspace/notices', {
    refetchInterval: 60_000,
  });
}

// ── Permissions ──────────────────────────────────────────────────────────────────────────────

/** Whether a stored pattern (exact key, `area.*` or `*`) covers a permission. */
export function matchesPattern(pattern: string, permission: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return permission.startsWith(pattern.slice(0, -1));
  return pattern === permission;
}

/** The catalog keys a role's patterns cover, in catalog order. */
export function expandPatterns(patterns: readonly string[], catalog: readonly string[]): string[] {
  return catalog.filter((key) => patterns.some((pattern) => matchesPattern(pattern, key)));
}

export const areaOf = (permission: string) => permission.split('.')[0] ?? permission;

/** The catalog grouped by area (conversations, members, …), in catalog order. */
export function groupByArea(catalog: readonly PermissionInfo[]): [string, PermissionInfo[]][] {
  const groups = new Map<string, PermissionInfo[]>();
  for (const permission of catalog) {
    const area = areaOf(permission.key);
    groups.set(area, [...(groups.get(area) ?? []), permission]);
  }
  return [...groups];
}

/** Roles the caller could hand out across the tenant: every permission within their reach. */
export function roleWithinReach(role: Role, catalog: readonly PermissionInfo[]): boolean {
  const grantable = new Set(catalog.filter((p) => p.grantable).map((p) => p.key));
  return expandPatterns(
    role.permissions,
    catalog.map((p) => p.key),
  ).every((key) => grantable.has(key));
}
