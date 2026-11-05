import type { AiDraftSupersededReason } from '@hamnivo/contracts';
import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { SourceRef } from '../authority/views.js';

/** The longest draft kept (ai_drafts_text_ck); a staff reply has the same limit. */
export const AI_DRAFT_MAX_CHARS = 10_000;

/**
 * A draft that fits: an over-long one is cut at the last sentence (or else word) that fits, and
 * marked as cut, so it is never refused by the database after the model was paid for.
 */
export function fitDraftText(text: string, max = AI_DRAFT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const sentence = Math.max(
    room.lastIndexOf('. '),
    room.lastIndexOf('! '),
    room.lastIndexOf('? '),
    room.lastIndexOf('\n'),
  );
  const word = room.lastIndexOf(' ');
  const cut = sentence > max / 2 ? sentence + 1 : word > max / 2 ? word : room.length;
  let kept = room.slice(0, cut).trimEnd();
  // Never half an emoji: a lone high surrogate at the cut is dropped.
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return `${kept}…`;
}

/**
 * Whether the customer wrote, after the message `ledgerId`, another one that asks for an answer
 * (not a reaction). Messages are compared in Chatwoot's order (its message ids only grow): a
 * message retried after a failure is newer than one sent in the meantime, and one that reached
 * Chatwoot first stays older however late it was confirmed. Without Chatwoot ids, by commit time,
 * compared in SQL (timestamps read into JavaScript lose their microseconds).
 */
export async function newerCustomerMessage(
  tx: TenantTx,
  conversationId: string,
  ledgerId: string,
): Promise<boolean> {
  const l = schema.messageLedger;
  const [newer] = await tx
    .select({ id: l.id })
    .from(l)
    .where(
      and(
        eq(l.conversationId, conversationId),
        eq(l.senderKind, 'customer'),
        eq(l.state, 'committed'),
        eq(l.expectsReply, true),
        ne(l.id, ledgerId),
        sql`exists (select 1 from message_ledger t where t.id = ${ledgerId} and case
          when ${l.authorityMessageId} is not null and t.authority_message_id is not null
            then ${l.authorityMessageId} > t.authority_message_id
          else coalesce(${l.committedAt}, ${l.createdAt}) > coalesce(t.committed_at, t.created_at)
        end)`,
      ),
    )
    .limit(1);
  return newer !== undefined;
}

/**
 * AI drafts awaiting review (HNV-09-05): the writes the rest of the gateway makes on them, inside
 * its own transactions. A draft is written for one customer message and whoever handles the
 * conversation; anything that moves the conversation on makes it stale.
 */

/**
 * Marks the conversation's pending draft stale (at most one is pending), audited. `except` keeps
 * the draft a person is sending right now. Returns whether one was pending, so the caller can
 * refresh Studio after its commit.
 */
export async function supersedeAiDrafts(
  tx: TenantTx,
  conversationId: string,
  reason: AiDraftSupersededReason,
  now: Date,
  except?: string,
): Promise<boolean> {
  const d = schema.aiDrafts;
  const ended = await tx
    .update(d)
    .set({ state: 'superseded', supersededReason: reason, decidedAt: now, updatedAt: now })
    .where(
      and(
        eq(d.conversationId, conversationId),
        eq(d.state, 'pending'),
        except ? ne(d.id, except) : undefined,
      ),
    )
    .returning({ id: d.id });
  for (const draft of ended) {
    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'ai-drafts',
      action: 'ai.draft.superseded',
      targetType: 'conversation',
      targetId: toPublicId('conversation', conversationId),
      outcome: 'success',
      data: { draftId: toPublicId('aiDraft', draft.id), reason },
    });
  }
  return ended.length > 0;
}

export interface NewAiDraft {
  tenantId: string;
  conversationId: string;
  runId: string;
  agentId: string;
  agentVersionId: string;
  /** The customer message it answers. */
  triggerLedgerId: string;
  text: string;
  sources: SourceRef[];
  language: string | null;
  now: Date;
}

/**
 * Keeps a draft for people to review, under the conversation's lock, in place of the one pending.
 * Nothing is kept when it no longer fits: the AI answers the conversation itself, it was resolved,
 * a person already replied after the message, or the customer wrote again (that message gets its
 * own draft). A retry of the same run keeps the draft it already wrote.
 */
export async function storeAiDraft(
  tx: TenantTx,
  input: NewAiDraft,
): Promise<'stored' | 'duplicate' | 'not_needed'> {
  const [control] = await tx
    .select({
      ownerMode: schema.conversationControls.ownerMode,
      authorityStatus: schema.conversationControls.authorityStatus,
      ownershipEpoch: schema.conversationControls.ownershipEpoch,
    })
    .from(schema.conversationControls)
    .where(eq(schema.conversationControls.id, input.conversationId))
    .for('update');
  if (!control) return 'not_needed';
  const [existing] = await tx
    .select({ id: schema.aiDrafts.id })
    .from(schema.aiDrafts)
    .where(eq(schema.aiDrafts.runId, input.runId));
  if (existing) return 'duplicate';
  if (control.ownerMode === 'AI_ACTIVE' || control.authorityStatus === 'resolved') {
    return 'not_needed';
  }
  if (await newerCustomerMessage(tx, input.conversationId, input.triggerLedgerId)) {
    return 'not_needed';
  }
  // A person answered after the message (in Studio or in Chatwoot) while the draft was being
  // written: it would be a second answer. Chatwoot's message ids give the order, whatever the
  // clocks of either side say.
  const j = schema.conversationJournal;
  const [answered] = await tx
    .select({ seq: j.seq })
    .from(j)
    .where(
      and(
        eq(j.conversationId, input.conversationId),
        eq(j.lane, 'customer'),
        eq(j.eventType, 'message.created'),
        sql`${j.event}->'data'->'message'->'sender'->>'kind' = 'human_agent'`,
        sql`${j.authorityId} > (select m.authority_message_id from message_ledger m where m.id = ${input.triggerLedgerId})`,
      ),
    )
    .limit(1);
  if (answered) return 'not_needed';
  await supersedeAiDrafts(tx, input.conversationId, 'replaced', input.now);
  await tx.insert(schema.aiDrafts).values({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    runId: input.runId,
    agentId: input.agentId,
    agentVersionId: input.agentVersionId,
    triggerLedgerId: input.triggerLedgerId,
    ownerEpoch: control.ownershipEpoch,
    text: fitDraftText(input.text),
    sources: input.sources,
    language: input.language,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return 'stored';
}
