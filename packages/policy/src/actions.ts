import {
  type AuthorizeOptions,
  authorize,
  DEFAULT_STEP_UP_MAX_AGE_MS,
  type Decision,
  type ResourceScope,
  type StaffPrincipal,
} from './authorize.js';
import { isPermission } from './catalog.js';

/** Risk classes of AI actions (mirrors @hamnivo/domain/actions). */
export type ActionRisk = 'read' | 'write' | 'money' | 'irreversible';

export interface ActionApprovalRequirement {
  risk: ActionRisk;
  /**
   * A permission the approver needs as well as `tools.approve`, chosen per tool (for example
   * `commerce.refunds.approve` for a credit). Unknown permissions deny.
   */
  requiredPermission: string | null;
}

/**
 * Whether a staff member may approve or decline an AI action on this resource (G13): they need
 * `tools.approve` and the tool's own required permission where the conversation lives, and for a
 * money or irreversible action a sign-in within the step-up window, whatever the permission
 * itself says. Customers never pass through here: their approvals are checked against the action.
 */
export function authorizeActionApproval(
  principal: StaffPrincipal,
  requirement: ActionApprovalRequirement,
  resource: ResourceScope,
  options: AuthorizeOptions = {},
): Decision {
  const base = authorize(principal, 'tools.approve', resource, options);
  if (!base.allowed) return base;
  if (requirement.requiredPermission !== null) {
    if (!isPermission(requirement.requiredPermission)) {
      return { allowed: false, reason: 'no_grant', permission: 'tools.approve' };
    }
    const extra = authorize(principal, requirement.requiredPermission, resource, options);
    if (!extra.allowed) return extra;
  }
  if (requirement.risk === 'money' || requirement.risk === 'irreversible') {
    const now = options.now ?? new Date();
    const maxAge = options.stepUpMaxAgeMs ?? DEFAULT_STEP_UP_MAX_AGE_MS;
    if (now.getTime() - principal.authenticatedAt.getTime() > maxAge) {
      return { allowed: false, reason: 'step_up_required', permission: 'tools.approve' };
    }
  }
  return base;
}
