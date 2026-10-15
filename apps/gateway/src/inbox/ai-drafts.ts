import type { AiDraftSupersededReason } from '@hamnivo/contracts';
import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { SourceRef } from '../authority/views.js';

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
 * or the customer wrote again (that message gets its own draft). A retry of the same run keeps the
 * draft it already wrote.
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
  const l = schema.messageLedger;
  // Compared in SQL: timestamps read into JavaScript lose their microseconds.
  const [newer] = await tx
    .select({ id: l.id })
    .from(l)
    .where(
      and(
        eq(l.conversationId, input.conversationId),
        eq(l.senderKind, 'customer'),
        eq(l.state, 'committed'),
        ne(l.id, input.triggerLedgerId),
        sql`${l.createdAt} > (select m.created_at from message_ledger m where m.id = ${input.triggerLedgerId})`,
      ),
    )
    .limit(1);
  if (newer) return 'not_needed';
  await supersedeAiDrafts(tx, input.conversationId, 'replaced', input.now);
  await tx.insert(schema.aiDrafts).values({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    runId: input.runId,
    agentId: input.agentId,
    agentVersionId: input.agentVersionId,
    triggerLedgerId: input.triggerLedgerId,
    ownerEpoch: control.ownershipEpoch,
    text: input.text,
    sources: input.sources,
    language: input.language,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return 'stored';
}
