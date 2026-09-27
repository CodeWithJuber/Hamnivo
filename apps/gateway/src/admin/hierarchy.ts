import { schema, type TenantTx } from '@hamnivo/db';
import type { ResourceScope, ScopeHierarchy } from '@hamnivo/policy';
import { eq } from 'drizzle-orm';

/**
 * Where every team, brand and inbox of the tenant sits, loaded once, for checks over many grants
 * (the member list, removals). A scope that no longer exists has no parents: only tenant-level
 * access contains it.
 */
export async function loadHierarchy(tx: TenantTx): Promise<ScopeHierarchy> {
  const teams = await tx
    .select({ id: schema.teams.id, workspaceId: schema.teams.workspaceId })
    .from(schema.teams);
  const brands = await tx
    .select({ id: schema.brands.id, workspaceId: schema.brands.workspaceId })
    .from(schema.brands);
  const inboxes = await tx
    .select({
      id: schema.authorityInboxes.id,
      brandId: schema.authorityInboxes.brandId,
      workspaceId: schema.brands.workspaceId,
    })
    .from(schema.authorityInboxes)
    .leftJoin(schema.brands, eq(schema.brands.id, schema.authorityInboxes.brandId));
  const teamParents = new Map(teams.map((t) => [t.id, t.workspaceId]));
  const brandParents = new Map(brands.map((b) => [b.id, b.workspaceId]));
  const inboxParents = new Map(inboxes.map((i) => [i.id, i]));
  return (scope): ResourceScope => {
    switch (scope.type) {
      case 'workspace':
        return {};
      case 'team': {
        const workspaceId = teamParents.get(scope.id);
        return workspaceId ? { workspaceId } : {};
      }
      case 'brand': {
        const workspaceId = brandParents.get(scope.id);
        return workspaceId ? { workspaceId } : {};
      }
      case 'inbox': {
        const inbox = inboxParents.get(scope.id);
        return {
          ...(inbox?.brandId ? { brandId: inbox.brandId } : {}),
          ...(inbox?.workspaceId ? { workspaceId: inbox.workspaceId } : {}),
        };
      }
    }
  };
}
