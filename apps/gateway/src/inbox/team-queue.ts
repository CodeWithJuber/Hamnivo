import { schema, type TenantTx } from '@hamnivo/db';
import { enqueueOutbox } from '../outbox/outbox.js';

/** Whether a team can take a brand's conversations (H02): active, and in its workspace or all. */
export function teamTakesBrand(
  team: { status: string; workspaceId: string | null } | undefined,
  workspaceId: string | null,
): boolean {
  return (
    team !== undefined &&
    team.status === 'active' &&
    (team.workspaceId === null || team.workspaceId === workspaceId)
  );
}

/**
 * Puts a conversation in a team's queue, or takes it out (`null`), the inbox's own way: the team is
 * kept with the conversation and `conversation.team_changed` sets it in Chatwoot (and offers it to
 * the team's people when the team offers chats). The caller checks the team and audits the change.
 * `actorStaffMemberId`: the person who chose it, so Chatwoot records it as theirs; null for
 * Hamnivo itself.
 */
export async function putInTeam(
  tx: TenantTx,
  tenantId: string,
  conversationId: string,
  teamId: string | null,
  now: Date,
  actorStaffMemberId: string | null = null,
): Promise<void> {
  await tx
    .insert(schema.conversationInboxState)
    .values({ tenantId, conversationId, teamId })
    .onConflictDoUpdate({
      target: [
        schema.conversationInboxState.tenantId,
        schema.conversationInboxState.conversationId,
      ],
      set: { teamId, updatedAt: now },
    });
  await enqueueOutbox(tx, tenantId, {
    topic: 'conversation.team_changed',
    aggregateType: 'conversation',
    aggregateId: conversationId,
    payload: { conversationId, teamId, actorStaffMemberId },
  });
}
