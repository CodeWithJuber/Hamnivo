import { schema, type TenantTx } from '@hamnivo/db';
import { and, eq, gt, inArray, type SQL, sql } from 'drizzle-orm';
import { InboxAccess, type VisibleScope } from './access.js';

const c = schema.conversationControls;
const j = schema.conversationJournal;
const r = schema.staffConversationReads;

/** The part of a chat that makes it a person's concern: it is theirs, or waiting for a person. */
export function concernsStaff(
  chat: { ownerMode: string; ownerStaffId: string | null },
  staffMemberId: string,
): boolean {
  return (
    chat.ownerMode === 'WAITING_HUMAN' ||
    chat.ownerMode === 'PAUSED' ||
    (chat.ownerMode === 'HUMAN_ACTIVE' && chat.ownerStaffId === staffMemberId)
  );
}

/** SQL for {@link concernsStaff} over conversation_controls. */
function concerns(staffMemberId: string): SQL {
  return sql`(${c.ownerMode} in ('WAITING_HUMAN', 'PAUSED') or (${c.ownerMode} = 'HUMAN_ACTIVE' and ${c.ownerStaffId} = ${staffMemberId}))`;
}

/** The customer's own messages on the customer lane (not replies, notes or status lines). */
const customerMessage = sql`${j.lane} = 'customer' and ${j.eventType} = 'message.created' and ${j.event}->'data'->'message'->'sender'->>'kind' = 'customer'`;

/**
 * Customer messages after the person's read marker, per conversation. Only chats that concern
 * them are counted, so an AI chat or a colleague's chat is never "unread" for them.
 */
export async function unreadCounts(
  tx: TenantTx,
  staffMemberId: string,
  chats: { id: string; ownerMode: string; ownerStaffId: string | null }[],
): Promise<Map<string, number>> {
  const ids = chats.filter((chat) => concernsStaff(chat, staffMemberId)).map((chat) => chat.id);
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ conversationId: j.conversationId, count: sql<number>`count(*)::int` })
    .from(j)
    .leftJoin(r, and(eq(r.conversationId, j.conversationId), eq(r.staffMemberId, staffMemberId)))
    .where(
      and(
        inArray(j.conversationId, ids),
        customerMessage,
        gt(j.seq, sql`coalesce(${r.readSeq}, 0)`),
      ),
    )
    .groupBy(j.conversationId);
  return new Map(rows.map((row) => [row.conversationId, Number(row.count)]));
}

/** How many active chats that concern the person have customer messages they have not read. */
export async function unreadChats(
  tx: TenantTx,
  staffMemberId: string,
  scope: VisibleScope,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(c)
    .leftJoin(schema.brands, eq(schema.brands.id, c.brandId))
    .leftJoin(schema.conversationInboxState, eq(schema.conversationInboxState.conversationId, c.id))
    .where(
      and(
        InboxAccess.condition(scope),
        inArray(c.authorityStatus, ['open', 'pending']),
        concerns(staffMemberId),
        sql`exists (
          select 1 from ${j}
          left join ${r} on ${r.conversationId} = ${j.conversationId} and ${r.staffMemberId} = ${staffMemberId}
          where ${j.conversationId} = ${c.id}
            and ${customerMessage}
            and ${j.seq} > coalesce(${r.readSeq}, 0)
        )`,
      ),
    );
  return Number(row?.n ?? 0);
}

/** Marks the customer lane read up to `throughSeq`; the marker only moves forward. */
export async function markRead(
  tx: TenantTx,
  tenantId: string,
  staffMemberId: string,
  conversationId: string,
  throughSeq: number,
  now: Date,
): Promise<void> {
  await tx
    .insert(r)
    .values({ tenantId, staffMemberId, conversationId, readSeq: throughSeq, readAt: now })
    .onConflictDoUpdate({
      target: [r.tenantId, r.staffMemberId, r.conversationId],
      set: { readSeq: sql`greatest(${r.readSeq}, ${throughSeq})`, readAt: now },
    });
}
