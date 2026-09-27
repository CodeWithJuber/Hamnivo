import { schema, type TenantTx } from '@hamnivo/db';
import type { ResourceScope, Scope } from '@hamnivo/policy';
import { eq } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';

/**
 * Where a scope sits in the tenant (a brand's workspace, an inbox's brand and workspace), checked
 * inside the tenant so a scope from another tenant is simply not found.
 */
export async function scopeParents(tx: TenantTx, scope: Scope): Promise<ResourceScope> {
  const notFound = () =>
    new AppError('NOT_FOUND', { detail: 'The selected scope does not exist.' });
  switch (scope.type) {
    case 'tenant':
      return {};
    case 'team': {
      const [row] = await tx
        .select({ workspaceId: schema.teams.workspaceId })
        .from(schema.teams)
        .where(eq(schema.teams.id, scope.id));
      if (!row) throw notFound();
      return row.workspaceId ? { workspaceId: row.workspaceId } : {};
    }
    case 'workspace': {
      const [row] = await tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, scope.id));
      if (!row) throw notFound();
      return {};
    }
    case 'brand': {
      const [row] = await tx
        .select({ workspaceId: schema.brands.workspaceId })
        .from(schema.brands)
        .where(eq(schema.brands.id, scope.id));
      if (!row) throw notFound();
      return { workspaceId: row.workspaceId };
    }
    case 'inbox': {
      const [row] = await tx
        .select({
          brandId: schema.authorityInboxes.brandId,
          workspaceId: schema.brands.workspaceId,
        })
        .from(schema.authorityInboxes)
        .leftJoin(schema.brands, eq(schema.brands.id, schema.authorityInboxes.brandId))
        .where(eq(schema.authorityInboxes.id, scope.id));
      if (!row) throw notFound();
      return {
        ...(row.brandId ? { brandId: row.brandId } : {}),
        ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
      };
    }
  }
}

export function resourceFor(scope: Scope, parents: ResourceScope): ResourceScope {
  switch (scope.type) {
    case 'tenant':
      return {};
    case 'workspace':
      return { ...parents, workspaceId: scope.id };
    case 'brand':
      return { ...parents, brandId: scope.id };
    case 'inbox':
      return { ...parents, inboxId: scope.id };
    case 'team':
      return { ...parents, teamId: scope.id };
  }
}
