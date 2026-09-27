import { schema, type TenantTx } from '@hamnivo/db';
import type { AuthorityConversationState } from '@hamnivo/domain';
import { and, eq } from 'drizzle-orm';

/** The Valkey channel that tells staff streams a conversation of the tenant changed. */
export const inboxChannel = (tenantId: string) => `hamnivo:inbox:${tenantId}`;

/**
 * Keeps the queue projection (tags, snooze time, team) in step with a newer authority state. Tags
 * and snooze times come from Chatwoot as they are; a team is adopted only when it is one Hamnivo
 * knows, because Hamnivo assigns teams and Chatwoot may still show the previous one.
 */
export async function projectInboxState(
  tx: TenantTx,
  tenantId: string,
  conversationId: string,
  connectionId: string,
  state: Pick<AuthorityConversationState, 'labels' | 'snoozedUntil' | 'teamRef'>,
): Promise<void> {
  let teamId: string | undefined;
  if (state.teamRef !== null && Number.isInteger(Number(state.teamRef))) {
    const [link] = await tx
      .select({ teamId: schema.teamAuthorityLinks.teamId })
      .from(schema.teamAuthorityLinks)
      .where(
        and(
          eq(schema.teamAuthorityLinks.connectionId, connectionId),
          eq(schema.teamAuthorityLinks.externalTeamId, Number(state.teamRef)),
        ),
      );
    teamId = link?.teamId;
  }
  const values = {
    labels: state.labels,
    snoozedUntil: state.snoozedUntil ?? null,
    ...(teamId ? { teamId } : {}),
  };
  await tx
    .insert(schema.conversationInboxState)
    .values({ tenantId, conversationId, ...values })
    .onConflictDoUpdate({
      target: [
        schema.conversationInboxState.tenantId,
        schema.conversationInboxState.conversationId,
      ],
      set: { ...values, updatedAt: new Date() },
    });
}
