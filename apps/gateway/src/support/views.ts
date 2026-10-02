import type { SupportGrant, SupportScope } from '@hamnivo/contracts';
import { type schema, toPublicId } from '@hamnivo/db';
import { iso } from '../common/views.js';

type Row = typeof schema.supportGrants.$inferSelect;
type State = SupportGrant['state'];

/** Where a support grant stands now: approval does not last past its end time (A18). */
export function supportState(row: Row, now: Date): State {
  if (row.status === 'pending') return 'pending';
  if (row.status === 'declined') return 'declined';
  if (row.revokedAt) return 'revoked';
  if (row.endedAt) return 'ended';
  return row.expiresAt > now ? 'active' : 'expired';
}

export function isSupportActive(row: Row, now: Date): boolean {
  return supportState(row, now) === 'active';
}

export function supportGrantView(
  row: Row,
  tenant: { id: string; name: string },
  decidedBy: { id: string; displayName: string } | null,
  now: Date,
): SupportGrant {
  return {
    id: toPublicId('supportGrant', row.id),
    tenant: { id: toPublicId('tenant', tenant.id), name: tenant.name },
    operator: { id: toPublicId('operator', row.platformUserId), name: row.operatorName },
    state: supportState(row, now),
    scopes: row.scopes as SupportScope[],
    reason: row.reason,
    durationMinutes: row.durationMinutes,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: iso(row.decidedAt),
    decidedBy: decidedBy
      ? { id: toPublicId('staff', decidedBy.id), displayName: decidedBy.displayName }
      : null,
    decisionNote: row.decisionNote,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: iso(row.revokedAt),
    endedAt: iso(row.endedAt),
  };
}
