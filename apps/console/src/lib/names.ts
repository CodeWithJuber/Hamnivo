import type { TFunction } from 'i18next';
import { useMemo } from 'react';
import { useTools } from './actions';
import { useAgents, useBrands, useMembers, useWorkspaces } from './queries';
import { useTenant } from './tenant';
import type { KillSwitch } from './types';

export interface BrandRef {
  id: string;
  name: string;
  status: 'active' | 'disabled';
}

/**
 * The tenant's brands from whichever list this person may read: the brand list needs
 * brands.manage, the workspace list only members.read.
 */
export function useBrandRefs() {
  const { can } = useTenant();
  const brands = useBrands();
  const workspaces = useWorkspaces();
  const items = useMemo<BrandRef[] | undefined>(() => {
    if (brands.data) {
      return brands.data.items.map((b) => ({ id: b.id, name: b.name, status: b.status }));
    }
    if (workspaces.data) return workspaces.data.items.flatMap((w) => w.brands);
    return undefined;
  }, [brands.data, workspaces.data]);
  const source = can('brands.manage') ? brands : workspaces;
  return {
    items,
    pending: source.isPending && items === undefined,
    error: items === undefined ? source.error : null,
    /** The last refresh failed while older names are still shown (HNV-03-04). */
    refreshError: items === undefined ? null : source.error,
    dataUpdatedAt: source.dataUpdatedAt,
    refetch: () => source.refetch(),
    isRefetching: source.isRefetching,
    permitted: can('brands.manage') || can('members.read'),
  };
}

/** Readable names for IDs shown in lists (brands, agents, teammates, tools). */
export function useNames() {
  const brands = useBrandRefs();
  const agents = useAgents();
  const members = useMembers();
  const tools = useTools();
  return useMemo(() => {
    const brand = new Map((brands.items ?? []).map((b) => [b.id, b.name]));
    const agent = new Map((agents.data?.items ?? []).map((a) => [a.id, a.name]));
    const member = new Map((members.data?.items ?? []).map((m) => [m.id, m.displayName]));
    const tool = new Map((tools.data?.items ?? []).map((x) => [x.id, x.title]));
    return {
      brand: (id: string | null | undefined) => (id ? brand.get(id) : undefined),
      agent: (id: string | null | undefined) => (id ? agent.get(id) : undefined),
      member: (id: string | null | undefined) => (id ? member.get(id) : undefined),
      tool: (id: string | null | undefined) => (id ? tool.get(id) : undefined),
    };
  }, [brands.items, agents.data, members.data, tools.data]);
}

export type Names = ReturnType<typeof useNames>;

/** "Everywhere in this workspace", "Brand: Noor Books", "Agent: Noor Books assistant". */
export function killSwitchScope(
  t: TFunction,
  names: Names,
  item: Pick<KillSwitch, 'scope' | 'targetId'>,
): string {
  if (item.scope === 'tenant') return t('shell.scope.tenant');
  const fallback = t('stopAi.unknownTarget', { id: item.targetId ?? '' });
  if (item.scope === 'brand') {
    return t('shell.scope.brand', { name: names.brand(item.targetId) ?? fallback });
  }
  if (item.scope === 'tool') {
    return t('tools.killScope', { name: names.tool(item.targetId) ?? fallback });
  }
  return t('shell.scope.agent', { name: names.agent(item.targetId) ?? fallback });
}
