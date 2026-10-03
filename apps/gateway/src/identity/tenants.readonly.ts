import { expandPatterns, type Grant, type StaffPrincipal } from '@hamnivo/policy';
import { AppError } from '../common/app-error.js';

/**
 * A suspended workspace (platform console or billing system) stays readable for its staff, and
 * nothing in it can change: grants keep only what reads (and billing, so an owner can pay), and
 * every request that writes is refused, whatever permission the route asks for.
 */

const suspended = new WeakSet<StaffPrincipal>();

/** Writes a suspended workspace still accepts: paying, from Plan & billing. */
const ALLOWED_WRITES = new Set(['/v1/admin/billing/checkout', '/v1/admin/billing/portal']);

const readable = (permission: string) =>
  permission.endsWith('.read') || permission.startsWith('billing.');

/** The grants of someone in a suspended workspace: reads and billing only. */
export function readOnlyGrants(grants: readonly Grant[]): Grant[] {
  return grants.map((grant) => ({
    ...grant,
    permissions: expandPatterns(grant.permissions).filter(readable),
  }));
}

/** Marks a principal as acting in a suspended workspace. */
export function markSuspended<T extends StaffPrincipal>(principal: T): T {
  suspended.add(principal);
  return principal;
}

export function isSuspended(principal: StaffPrincipal): boolean {
  return suspended.has(principal);
}

/** Refuses a request that writes in a suspended workspace. */
export function assertWritable(
  principal: StaffPrincipal,
  request: { method: string; url: string },
): void {
  if (!suspended.has(principal)) return;
  if (request.method === 'GET' || request.method === 'HEAD') return;
  if (ALLOWED_WRITES.has(request.url.split('?')[0] ?? '')) return;
  throw new AppError('FEATURE_DISABLED', {
    reason: 'workspace_suspended',
    detail:
      'This workspace is suspended, so it is read-only. Contact your provider to reactivate it.',
  });
}

/** Workspaces whose widget still loads (a suspended one shows offline inside it). */
export const widgetLoads = (tenantStatus: string) =>
  tenantStatus === 'active' || tenantStatus === 'suspended';

/**
 * Refuses a chat session in a workspace that is not active: suspended reads as "offline" (the
 * widget says so, and the chat comes back with the workspace); closed reads as not available.
 */
export function assertWidgetOnline(tenantStatus: string): void {
  if (tenantStatus === 'active') return;
  if (tenantStatus === 'suspended') {
    throw new AppError('FEATURE_DISABLED', {
      reason: 'workspace_suspended',
      detail: 'This chat is offline right now. Please try again later.',
    });
  }
  throw new AppError('NOT_FOUND', { detail: 'This chat is not available.' });
}
