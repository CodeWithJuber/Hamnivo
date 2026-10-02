import i18next, { type TFunction } from 'i18next';
import { useMemo } from 'react';
import { useTeams } from './access';
import { useBrandRefs } from './names';
import { useWorkspaces } from './queries';
import type { GrantScope, PermissionInfo } from './types';

type Loose = (key: string, options?: Record<string, unknown>) => string;

/** A translation whose key is only known at run time (a permission, an audit action). */
export function textOr(
  t: TFunction,
  key: string,
  fallback: string,
  options?: Record<string, unknown>,
): string {
  return i18next.exists(key) ? (t as unknown as Loose)(key, options) : fallback;
}

/** "Reply to customers", in the interface language (the catalog's English otherwise). */
export const permissionLabel = (
  t: TFunction,
  permission: Pick<PermissionInfo, 'key' | 'description'>,
) => textOr(t, `permissions.${permission.key}`, permission.description);

export const areaLabel = (t: TFunction, area: string) => textOr(t, `permissionAreas.${area}`, area);

/** "Member removed" for `member.removed`; unknown actions show their key. */
export const auditActionLabel = (t: TFunction, action: string) =>
  textOr(t, `access.auditActions.${action}`, action);

/** Names of the places a role can apply to: workspace areas, teams and brands. */
export function useScopeNames() {
  const workspaces = useWorkspaces();
  const teams = useTeams();
  const brands = useBrandRefs();
  return useMemo(() => {
    const workspace = new Map((workspaces.data?.items ?? []).map((w) => [w.id, w.name]));
    const team = new Map((teams.data?.items ?? []).map((item) => [item.id, item.name]));
    const brand = new Map((brands.items ?? []).map((b) => [b.id, b.name]));
    return {
      workspaces: workspaces.data?.items ?? [],
      teams: (teams.data?.items ?? []).filter((item) => item.status === 'active'),
      brands: brands.items ?? [],
      name(scope: GrantScope): string | undefined {
        if (scope.type === 'workspace') return workspace.get(scope.id);
        if (scope.type === 'team') return team.get(scope.id);
        if (scope.type === 'brand') return brand.get(scope.id);
        return undefined;
      },
    };
  }, [workspaces.data, teams.data, brands.items]);
}

export type ScopeNames = ReturnType<typeof useScopeNames>;

/** "Whole workspace", "Team: Billing", … */
export function scopeLabel(t: TFunction, scope: GrantScope, names: ScopeNames): string {
  if (scope.type === 'tenant') return t('access.scope.tenant');
  if (scope.type === 'inbox') return t('access.scope.inbox');
  const name = names.name(scope);
  if (!name) return t('access.scope.unknown');
  return t(`access.scope.${scope.type}`, { name });
}
