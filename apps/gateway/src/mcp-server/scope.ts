import {
  authorize,
  grantsPermission,
  isGrantActive,
  type ResourceScope,
  type ServiceAccountPrincipal,
} from '@hamnivo/policy';
import type { VisibleScope } from '../inbox/access.js';

/** Who is calling Hamnivo's MCP server: an API key, acting as its service account. */
export interface McpCaller {
  tenantId: string;
  /** The key's own id (internal form). */
  keyId: string;
  principal: ServiceAccountPrincipal;
}

/** The permission every tool of the MCP server needs. */
export const MCP_PERMISSION = 'mcp.read' as const;

/**
 * Where the key's `mcp.read` reaches: everything in the workspace, or the brands and workspaces
 * its grant names. A key has one grant (its own scope), so this is that scope; the same shape the
 * inbox uses, so conversations are filtered by the same condition as for staff.
 */
export function visibleScope(principal: ServiceAccountPrincipal, now: Date): VisibleScope | null {
  if (principal.status !== 'active') return null;
  const scope: VisibleScope = {
    all: false,
    workspaceIds: [],
    brandIds: [],
    inboxIds: [],
    teamIds: [],
  };
  for (const grant of principal.grants) {
    if (!isGrantActive(grant, now) || !grantsPermission(grant, MCP_PERMISSION)) continue;
    if (grant.scope.type === 'tenant') scope.all = true;
    else if (grant.scope.type === 'workspace') scope.workspaceIds.push(grant.scope.id);
    else if (grant.scope.type === 'brand') scope.brandIds.push(grant.scope.id);
  }
  return scope.all || scope.workspaceIds.length > 0 || scope.brandIds.length > 0 ? scope : null;
}

/** Whether the key may read what belongs to this brand. */
export function mayRead(principal: ServiceAccountPrincipal, resource: ResourceScope, now: Date) {
  return authorize(principal, MCP_PERMISSION, resource, { now }).allowed;
}
