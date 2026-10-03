import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { withReauth } from './reauth';
import type {
  Incident,
  Items,
  PlatformAuditPage,
  PlatformHealth,
  PlatformOperator,
  PlatformOverview,
  PlatformTenant,
  PlatformTenantDetail,
  SupportAudit,
  SupportConfiguration,
  SupportConversations,
  SupportGrant,
  SupportScope,
} from './types';

/**
 * The platform console's data (A17). Nothing here is tenant data: keys start with `platform`,
 * requests carry no tenant, and the gateway answers only platform operators.
 */
export const platformKeys = {
  me: ['platform', 'me'],
  overview: ['platform', 'overview'],
  tenants: (query: string) => ['platform', 'tenants', query],
  tenant: (id: string) => ['platform', 'tenant', id],
  health: ['platform', 'health'],
  grants: ['platform', 'support-grants'],
  incidents: ['platform', 'incidents'],
  audit: ['platform', 'audit'],
  read: (grantId: string, area: SupportScope) => ['platform', 'read', grantId, area],
} as const;

const meta = { studio: true } as const;

export function usePlatformMe() {
  return useQuery({
    queryKey: platformKeys.me,
    queryFn: ({ signal }) => api<PlatformOperator>('/v1/platform/me', { signal }),
    retry: false,
    meta,
  });
}

export function usePlatformOverview(enabled: boolean) {
  return useQuery({
    queryKey: platformKeys.overview,
    queryFn: ({ signal }) => api<PlatformOverview>('/v1/platform/overview', { signal }),
    enabled,
    refetchInterval: 60_000,
    meta,
  });
}

export function usePlatformTenants(query: string, enabled: boolean) {
  return useQuery({
    queryKey: platformKeys.tenants(query),
    queryFn: ({ signal }) =>
      api<Items<PlatformTenant>>(
        `/v1/platform/tenants${query ? `?query=${encodeURIComponent(query)}` : ''}`,
        { signal },
      ),
    enabled,
    meta,
  });
}

export function usePlatformTenant(id: string | undefined) {
  return useQuery({
    queryKey: platformKeys.tenant(id ?? 'none'),
    queryFn: ({ signal }) => api<PlatformTenantDetail>(`/v1/platform/tenants/${id}`, { signal }),
    enabled: Boolean(id),
    meta,
  });
}

export function usePlatformHealth(enabled: boolean) {
  return useQuery({
    queryKey: platformKeys.health,
    queryFn: ({ signal }) => api<PlatformHealth>('/v1/platform/health', { signal }),
    enabled,
    refetchInterval: 30_000,
    meta,
  });
}

export function useMySupportGrants(enabled: boolean) {
  return useQuery({
    queryKey: platformKeys.grants,
    queryFn: ({ signal }) => api<Items<SupportGrant>>('/v1/platform/support-grants', { signal }),
    enabled,
    refetchInterval: 20_000,
    meta,
  });
}

export function useIncidents(enabled: boolean) {
  return useQuery({
    queryKey: platformKeys.incidents,
    queryFn: ({ signal }) => api<Items<Incident>>('/v1/platform/incidents', { signal }),
    enabled,
    meta,
  });
}

export function usePlatformAudit(enabled: boolean, pageSize = 50) {
  return useInfiniteQuery({
    queryKey: [...platformKeys.audit, pageSize],
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ limit: String(pageSize) });
      if (pageParam) query.set('before', String(pageParam));
      return api<PlatformAuditPage>(`/v1/platform/audit?${query}`, { signal });
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled,
    meta,
  });
}

type ReadResult = SupportConfiguration | SupportConversations | SupportAudit;

/** A read through an approved support grant (recorded on both sides by the gateway). */
export function useSupportRead(grantId: string | undefined, area: SupportScope | undefined) {
  return useQuery({
    queryKey: platformKeys.read(grantId ?? 'none', area ?? 'configuration'),
    queryFn: ({ signal }) =>
      withReauth(() =>
        api<ReadResult>(`/v1/platform/support-grants/${grantId}/${area}`, { signal }),
      ),
    enabled: Boolean(grantId && area),
    retry: false,
    staleTime: 60_000,
    meta,
  });
}

/** A platform change; a request for a fresh sign-in opens the sign-in dialog and repeats it. */
export function usePlatformMutation<TVars, TResult>(
  run: (vars: TVars) => Promise<TResult>,
  invalidate: readonly (readonly unknown[])[] = [],
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => withReauth(() => run(vars)),
    onSettled: () =>
      Promise.all(invalidate.map((key) => client.invalidateQueries({ queryKey: key }))),
  });
}
