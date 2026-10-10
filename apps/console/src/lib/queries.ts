import {
  type Query,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from './api';
import { withReauth } from './reauth';
import { useTenant } from './tenant';
import type {
  Agent,
  AgentDetail,
  AgentVersion,
  AuthorityConnection,
  Brand,
  BrandInstall,
  Items,
  KillSwitch,
  KnowledgeDocument,
  KnowledgeSource,
  Me,
  Member,
  MemoryCustomerDetail,
  MemoryCustomerSummary,
  ModelConnection,
  Run,
  RunPage,
  WorkspaceSummary,
} from './types';

/** Who is signed in and their tenants; fails with AUTH_REQUIRED when nobody is. */
export const meQuery = () =>
  queryOptions({
    queryKey: ['me'],
    queryFn: ({ signal }) => api<Me>('/v1/me', { signal }),
    staleTime: 60_000,
  });

/** The same, with permissions in one tenant; refreshed so revoked access shows up promptly. */
export const meInTenantQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ['me', tenantId],
    queryFn: ({ signal }) => api<Me>('/v1/me', { tenant: tenantId, signal }),
    meta: { studio: true },
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
  });

type Interval<T> = number | false | ((data: T | undefined) => number | false);

interface StudioQueryOptions<T> {
  enabled?: boolean;
  refetchInterval?: Interval<T>;
}

/** Tenant data. Keys start with the tenant, so one tenant's data never shows in another. */
export function useStudioQuery<T>(
  key: readonly unknown[],
  path: string,
  options: StudioQueryOptions<T> = {},
) {
  const { tenantId } = useTenant();
  const interval = options.refetchInterval;
  return useQuery({
    queryKey: [tenantId, ...key],
    queryFn: ({ signal }) => api<T>(path, { tenant: tenantId, signal }),
    meta: { studio: true },
    enabled: options.enabled ?? true,
    refetchInterval:
      typeof interval === 'function'
        ? (query: Query<T, Error, T, readonly unknown[]>) => interval(query.state.data)
        : (interval ?? false),
  });
}

/**
 * A change to tenant data. A request for a fresh sign-in opens the sign-in dialog and repeats the
 * change afterwards; the listed queries reload when it settles.
 */
export function useStudioMutation<TVars, TResult>(
  run: (vars: TVars, tenantId: string) => Promise<TResult>,
  invalidate: readonly (readonly unknown[])[] = [],
) {
  const { tenantId } = useTenant();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => withReauth(() => run(vars, tenantId)),
    onSettled: () =>
      Promise.all(
        invalidate.map((key) => client.invalidateQueries({ queryKey: [tenantId, ...key] })),
      ),
  });
}

export const keys = {
  brands: ['brands'],
  /** Under `brands`, so a change to a brand's websites reloads it too. */
  brandInstalls: ['brands', 'installs'],
  workspaces: ['workspaces'],
  connections: ['connections'],
  agents: ['agents'],
  agent: (id: string) => ['agents', id],
  modelConnections: ['model-connections'],
  killSwitches: ['kill-switches'],
  runs: ['runs'],
  sources: ['knowledge', 'sources'],
  documents: (sourceId: string) => ['knowledge', 'sources', sourceId, 'documents'],
  members: ['members'],
  memoryCustomers: ['memory', 'customers'],
  memoryCustomer: (customerId: string) => ['memory', 'customers', customerId],
} as const;

export function useBrands() {
  const { can } = useTenant();
  return useStudioQuery<Items<Brand>>(keys.brands, '/v1/admin/brands', {
    enabled: can('brands.manage'),
  });
}

/** How often Studio looks again while it waits for a brand's chat to show up on its website. */
export const INSTALL_POLL_MS = 5_000;

/**
 * Where each brand's chat code was seen running (HNV-01-04). With `waitFor`, it looks again every
 * few seconds until that brand's chat has been seen, so the install step turns green by itself.
 */
export function useBrandInstalls(options: { waitFor?: string } = {}) {
  const { can } = useTenant();
  const { waitFor } = options;
  return useStudioQuery<Items<BrandInstall>>(keys.brandInstalls, '/v1/admin/brands/installs', {
    enabled: can('brands.manage'),
    ...(waitFor
      ? {
          refetchInterval: (data: Items<BrandInstall> | undefined) =>
            data?.items.some((item) => item.brandId === waitFor) ? false : INSTALL_POLL_MS,
        }
      : {}),
  });
}

export function useWorkspaces() {
  const { can } = useTenant();
  return useStudioQuery<Items<WorkspaceSummary>>(keys.workspaces, '/v1/admin/workspaces', {
    enabled: can('members.read'),
  });
}

export function useAuthorityConnections() {
  const { can } = useTenant();
  return useStudioQuery<Items<AuthorityConnection>>(
    keys.connections,
    '/v1/admin/authority/connections',
    { enabled: can('integrations.manage') },
  );
}

export function useAgents() {
  const { can } = useTenant();
  return useStudioQuery<Items<Agent>>(keys.agents, '/v1/admin/agents', {
    enabled: can('agents.read'),
  });
}

export function useAgent(agentId: string) {
  return useStudioQuery<AgentDetail>(keys.agent(agentId), `/v1/admin/agents/${agentId}`);
}

/** Details (with the configuration) for several agents at once, for the agent list. */
export function useAgentDetails(agentIds: readonly string[]) {
  const { tenantId } = useTenant();
  return useQueries({
    queries: agentIds.map((id) => ({
      queryKey: [tenantId, ...keys.agent(id)],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<AgentDetail>(`/v1/admin/agents/${id}`, { tenant: tenantId, signal }),
      meta: { studio: true },
    })),
  });
}

export function useAgentVersions(agentId: string) {
  return useStudioQuery<Items<AgentVersion>>(
    [...keys.agent(agentId), 'versions'],
    `/v1/admin/agents/${agentId}/versions`,
  );
}

export function useModelConnections() {
  const { can } = useTenant();
  return useStudioQuery<Items<ModelConnection>>(
    keys.modelConnections,
    '/v1/admin/model-connections',
    { enabled: can('integrations.manage') },
  );
}

export function useKillSwitches() {
  const { can } = useTenant();
  return useStudioQuery<Items<KillSwitch>>(keys.killSwitches, '/v1/admin/kill-switches', {
    enabled: can('agents.read'),
    refetchInterval: 60_000,
  });
}

export function useMembers() {
  const { can } = useTenant();
  return useStudioQuery<Items<Member>>(keys.members, '/v1/admin/members', {
    enabled: can('members.read'),
    refetchInterval: false,
  });
}

export function useSources() {
  const { can } = useTenant();
  return useStudioQuery<Items<KnowledgeSource>>(keys.sources, '/v1/admin/knowledge/sources', {
    enabled: can('knowledge.read'),
  });
}

const settling = (documents: KnowledgeDocument[] | undefined) =>
  (documents ?? []).some((d) =>
    [d.current?.state, d.latest?.state].some((s) => s === 'queued' || s === 'processing'),
  );

/** A source's documents; checked again every 2 s while any is still being processed. */
export function useDocuments(sourceId: string | undefined) {
  const { can } = useTenant();
  return useStudioQuery<Items<KnowledgeDocument>>(
    keys.documents(sourceId ?? 'none'),
    `/v1/admin/knowledge/sources/${sourceId}/documents`,
    {
      enabled: Boolean(sourceId) && can('knowledge.read'),
      refetchInterval: (data) => (settling(data?.items) ? 2000 : false),
    },
  );
}

export interface RunFilters {
  agentId?: string | undefined;
  conversationId?: string | undefined;
}

export function useRuns(filters: RunFilters, pageSize = 25) {
  const { tenantId, can } = useTenant();
  return useInfiniteQuery({
    queryKey: [tenantId, ...keys.runs, filters, pageSize],
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ limit: String(pageSize) });
      if (filters.agentId) query.set('agentId', filters.agentId);
      if (filters.conversationId) query.set('conversationId', filters.conversationId);
      if (pageParam) query.set('cursor', pageParam);
      return api<RunPage>(`/v1/admin/runs?${query}`, { tenant: tenantId, signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    meta: { studio: true },
    enabled: can('analytics.read'),
  });
}

export function useRun(runId: string | undefined) {
  const { can } = useTenant();
  return useStudioQuery<Run>([...keys.runs, 'detail', runId], `/v1/admin/runs/${runId}`, {
    enabled: Boolean(runId) && can('analytics.read'),
  });
}

export interface MemoryFilters {
  query?: string | undefined;
  brandId?: string | undefined;
}

/** Customers with memory or a memory choice, newest change first (memory.read). */
export function useMemoryCustomers(filters: MemoryFilters) {
  const { can } = useTenant();
  const query = new URLSearchParams({ limit: '100' });
  if (filters.query) query.set('query', filters.query);
  if (filters.brandId) query.set('brandId', filters.brandId);
  return useStudioQuery<Items<MemoryCustomerSummary>>(
    [...keys.memoryCustomers, filters],
    `/v1/admin/memory/customers?${query}`,
    { enabled: can('memory.read') },
  );
}

/** One customer's memory; checked again every 2 s while a deletion is still finishing. */
export function useCustomerMemory(customerId: string) {
  const { can } = useTenant();
  return useStudioQuery<MemoryCustomerDetail>(
    keys.memoryCustomer(customerId),
    `/v1/admin/memory/customers/${customerId}`,
    {
      enabled: can('memory.read'),
      refetchInterval: (data) =>
        data?.deletions.some((deletion) => deletion.status === 'pending') ? 2000 : false,
    },
  );
}
