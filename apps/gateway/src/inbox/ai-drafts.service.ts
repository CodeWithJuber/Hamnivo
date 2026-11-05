import { createHash } from 'node:crypto';
import type {
  AiDraft,
  AiDraftDecisionResult,
  AiDraftList,
  ApproveAiDraftRequest,
  RejectAiDraftRequest,
} from '@hamnivo/contracts';
import { appendAudit, fromPublicId, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { type AiDraftRefusal, checkAiDraftDecision, draftOutcome } from '@hamnivo/domain';
import type { ResourceScope, StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { assertReplyWindow } from '../authority/channel-window.js';
import { JournalService } from '../authority/journal.service.js';
import { type ControlRow, currentOwnerOf } from '../authority/ownership.service.js';
import type { SourceRef } from '../authority/views.js';
import { AppError } from '../common/app-error.js';
import { StaffConversationsService } from '../conversations/staff-conversations.service.js';
import { enforce } from '../identity/staff.guard.js';
import { CLOCK, type Clock } from '../tokens.js';
import { InboxAccess } from './access.js';
import { DraftsService } from './drafts.service.js';

type DraftRow = typeof schema.aiDrafts.$inferSelect;

const sha256 = (text: string) => createHash('sha256').update(text).digest();

/**
 * Reviewing AI drafts (HNV-09-05): the pending draft of a conversation and how the last one ended;
 * approving (as written or edited) sends it as the reviewer through the normal staff send, with
 * the same rules about who may reply; rejecting records why and sends nothing. A decision is taken
 * once, under the conversation's lock: a second reviewer is told who decided first. Everything the
 * send would refuse is checked before the decision is kept, and the reply is kept with the
 * reviewer's outgoing messages in the same transaction, so a send that fails after it stays to be
 * retried rather than lost.
 */
@Injectable()
export class AiDraftsService {
  constructor(
    private readonly access: InboxAccess,
    private readonly staff: StaffConversationsService,
    private readonly drafts: DraftsService,
    private readonly journal: JournalService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(principal: StaffPrincipal, conversationId: string): Promise<AiDraftList> {
    return this.access.tx(principal, async (tx) => {
      const { control } = await this.access.authorized(
        tx,
        principal,
        conversationId,
        'conversations.read',
      );
      const ids = await tx
        .select({ id: schema.aiDrafts.id, state: schema.aiDrafts.state })
        .from(schema.aiDrafts)
        .where(eq(schema.aiDrafts.conversationId, control.id))
        .orderBy(desc(schema.aiDrafts.createdAt))
        .limit(2);
      const pending = ids.find((d) => d.state === 'pending');
      const latest = ids.find((d) => d.state !== 'pending');
      return {
        pending: pending ? await this.view(tx, pending.id) : null,
        latest: latest ? await this.view(tx, latest.id) : null,
      };
    });
  }

  async approve(
    principal: StaffPrincipal,
    conversationId: string,
    draftPublicId: string,
    input: z.output<typeof ApproveAiDraftRequest>,
  ): Promise<AiDraftDecisionResult> {
    const me = principal.staffMemberId;
    const decided = await this.access.tx(principal, async (tx) => {
      const { control, draft, resource } = await this.lockDraft(
        tx,
        principal,
        conversationId,
        draftPublicId,
      );
      const prior = await this.priorDecision(tx, input.clientRequestId, draft.id, me);
      if (prior) {
        // The same request again: its text must be the one decided, and it sends once.
        const sent = input.text ?? draft.text;
        if (prior.textHash && !sha256(sent).equals(prior.textHash)) {
          throw new AppError('IDEMPOTENCY_CONFLICT', {
            detail: 'This request was already used to send a different text.',
          });
        }
        return { draft, text: sent, replay: true, conversation: control.id };
      }
      await this.refuseUnlessOpen(tx, control, draft, me);
      if (input.expectedEpoch !== control.ownershipEpoch) {
        throw new AppError('OWNERSHIP_CHANGED', {
          detail: 'Someone else changed who handles this conversation. Nothing was sent.',
          currentOwner: await currentOwnerOf(tx, control),
        });
      }
      await assertReplyWindow(tx, control, this.clock());
      // A reply from someone who does not have the conversation yet takes it over, as any reply.
      if (!(control.ownerMode === 'HUMAN_ACTIVE' && control.ownerStaffId === me)) {
        enforce(this.access.decide(principal, 'conversations.takeover', resource));
      }
      const outcome = draftOutcome(draft.text, input.text);
      const text = outcome === 'edited' && input.text ? input.text : draft.text;
      await this.record(tx, principal, control, draft, {
        decision: outcome,
        textHash: outcome === 'edited' ? sha256(text) : null,
        clientMessageId: input.clientRequestId,
        clientRequestId: input.clientRequestId,
      });
      // Kept with the reviewer's outgoing messages now: whatever happens to the send, the reply
      // is never lost.
      await this.drafts.startOutgoing(tx, {
        tenantId: principal.tenantId,
        conversationId: control.id,
        staffMemberId: me,
        lane: 'public',
        clientMessageId: input.clientRequestId,
        text,
        clearDraft: false,
      });
      return { draft, text, replay: false, conversation: control.id };
    });
    // Sent as the reviewer, the way any reply is: a public reply takes the conversation over, and
    // the request id is the message's, so a retry sends nothing twice. Any failure after this point
    // stays in the reviewer's failed sends, with Retry, like any send that did not go through.
    let message: Awaited<ReturnType<StaffConversationsService['send']>>;
    try {
      message = await this.staff.send(
        principal,
        conversationId,
        {
          clientMessageId: input.clientRequestId,
          text: decided.text,
          visibility: 'public',
          clearDraft: false,
          suggestionId: toPublicId('run', decided.draft.runId),
          // A retry comes after the first attempt took the conversation over: the epoch moved on.
          ...(decided.replay ? {} : { expectedEpoch: input.expectedEpoch }),
        },
        { keepFailed: true },
      );
    } catch (error) {
      // Also when the send refused before it started (a colleague took the conversation).
      await this.drafts
        .failOutgoing(
          principal,
          decided.conversation,
          input.clientRequestId,
          error instanceof AppError ? error.code : 'INTERNAL',
        )
        .catch(() => undefined);
      await this.journal.signalInbox(principal.tenantId, decided.draft.conversationId);
      throw error;
    }
    await this.journal.signalInbox(principal.tenantId, decided.draft.conversationId);
    return {
      draft: await this.access.tx(principal, (tx) => this.view(tx, decided.draft.id)),
      message,
    };
  }

  async reject(
    principal: StaffPrincipal,
    conversationId: string,
    draftPublicId: string,
    input: z.output<typeof RejectAiDraftRequest>,
  ): Promise<AiDraftDecisionResult> {
    const me = principal.staffMemberId;
    const result = await this.access.tx(principal, async (tx) => {
      const { control, draft } = await this.lockDraft(tx, principal, conversationId, draftPublicId);
      const prior = await this.priorDecision(tx, input.clientRequestId, draft.id, me);
      if (!prior) {
        await this.refuseUnlessOpen(tx, control, draft, me);
        await this.record(tx, principal, control, draft, {
          decision: 'rejected',
          reason: input.reason,
          note: input.note?.length ? input.note : null,
          clientRequestId: input.clientRequestId,
        });
      }
      return { draft: await this.view(tx, draft.id), conversationId: control.id };
    });
    await this.journal.signalInbox(principal.tenantId, result.conversationId);
    return { draft: result.draft };
  }

  /** The conversation (locked) and its draft (locked), for a reviewer who may reply in it. */
  private async lockDraft(
    tx: TenantTx,
    principal: StaffPrincipal,
    conversationId: string,
    draftPublicId: string,
  ): Promise<{ control: ControlRow; draft: DraftRow; resource: ResourceScope }> {
    const { control, resource } = await this.access.authorized(
      tx,
      principal,
      conversationId,
      'conversations.reply',
      true,
    );
    const [draft] = await tx
      .select()
      .from(schema.aiDrafts)
      .where(
        and(
          eq(schema.aiDrafts.id, fromPublicId('aiDraft', draftPublicId)),
          eq(schema.aiDrafts.conversationId, control.id),
        ),
      )
      .for('update');
    if (!draft) throw new AppError('NOT_FOUND', { detail: 'Draft not found.' });
    return { control, draft, resource };
  }

  /** The decision a request already made, when it is repeated; another draft's is a conflict. */
  private async priorDecision(tx: TenantTx, clientRequestId: string, draftId: string, me: string) {
    const [prior] = await tx
      .select()
      .from(schema.aiDraftDecisions)
      .where(eq(schema.aiDraftDecisions.clientRequestId, clientRequestId));
    if (!prior) return null;
    if (prior.draftId !== draftId || prior.staffMemberId !== me) {
      throw new AppError('IDEMPOTENCY_CONFLICT', {
        detail: 'This request id was already used for another decision.',
      });
    }
    return prior;
  }

  /** Refuses, with why, when the draft is no longer this reviewer's to decide. */
  private async refuseUnlessOpen(
    tx: TenantTx,
    control: ControlRow,
    draft: DraftRow,
    me: string,
  ): Promise<void> {
    const refusal: AiDraftRefusal | null = checkAiDraftDecision(
      draft,
      {
        ownerMode: control.ownerMode,
        ownerStaffId: control.ownerStaffId,
        status: control.authorityStatus,
      },
      me,
    );
    switch (refusal) {
      case null:
        return;
      case 'not_pending': {
        const [decider] = draft.decidedBy
          ? await tx
              .select({ name: schema.staffMembers.displayName })
              .from(schema.staffMembers)
              .where(eq(schema.staffMembers.id, draft.decidedBy))
          : [];
        throw new AppError('AI_DRAFT_CLOSED', {
          detail: decider
            ? `${decider.name} already decided on this draft.`
            : 'This draft no longer fits the conversation.',
          aiDraft: { state: draft.state, decidedBy: decider?.name ?? null },
        });
      }
      case 'resolved':
        throw new AppError('CONVERSATION_CLOSED', {
          detail: 'This conversation is resolved. Reopen it to reply.',
        });
      case 'ai_owns':
      case 'colleague_owns':
        throw new AppError('OWNERSHIP_CHANGED', {
          detail:
            refusal === 'ai_owns'
              ? 'The AI is answering this conversation now.'
              : 'A colleague is handling this conversation. Take it over first.',
          currentOwner: await currentOwnerOf(tx, control),
        });
    }
  }

  /** Records the decision, moves the draft on (once) and audits it. */
  private async record(
    tx: TenantTx,
    principal: StaffPrincipal,
    control: ControlRow,
    draft: DraftRow,
    decision: {
      decision: 'approved' | 'edited' | 'rejected';
      clientRequestId: string;
      textHash?: Buffer | null;
      clientMessageId?: string;
      reason?: z.output<typeof RejectAiDraftRequest>['reason'];
      note?: string | null;
    },
  ): Promise<void> {
    const now = this.clock();
    await tx.insert(schema.aiDraftDecisions).values({
      tenantId: principal.tenantId,
      draftId: draft.id,
      staffMemberId: principal.staffMemberId,
      clientRequestId: decision.clientRequestId,
      decision: decision.decision,
      textHash: decision.textHash ?? null,
      ownerEpoch: control.ownershipEpoch,
      reason: decision.reason ?? null,
      note: decision.note ?? null,
      clientMessageId: decision.clientMessageId ?? null,
    });
    await tx
      .update(schema.aiDrafts)
      .set({
        state: decision.decision,
        decidedBy: principal.staffMemberId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.aiDrafts.id, draft.id));
    await appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action: `ai.draft.${decision.decision}`,
      targetType: 'conversation',
      targetId: toPublicId('conversation', control.id),
      outcome: 'success',
      data: {
        draftId: toPublicId('aiDraft', draft.id),
        runId: toPublicId('run', draft.runId),
        ...(decision.reason ? { reason: decision.reason } : {}),
      },
    });
  }

  /** A draft as Studio shows it: who wrote it, how it ended and who decided. */
  private async view(tx: TenantTx, id: string): Promise<AiDraft> {
    const [row] = await tx
      .select({
        draft: schema.aiDrafts,
        agentName: schema.agentProfiles.name,
        deciderName: schema.staffMembers.displayName,
        rejectReason: schema.aiDraftDecisions.reason,
      })
      .from(schema.aiDrafts)
      .leftJoin(schema.agentProfiles, eq(schema.agentProfiles.id, schema.aiDrafts.agentId))
      .leftJoin(schema.staffMembers, eq(schema.staffMembers.id, schema.aiDrafts.decidedBy))
      .leftJoin(schema.aiDraftDecisions, eq(schema.aiDraftDecisions.draftId, schema.aiDrafts.id))
      .where(eq(schema.aiDrafts.id, id));
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Draft not found.' });
    const { draft } = row;
    return {
      id: toPublicId('aiDraft', draft.id),
      runId: toPublicId('run', draft.runId),
      state: draft.state,
      supersededReason: draft.supersededReason,
      text: draft.text,
      sources: draft.sources as SourceRef[],
      language: draft.language,
      agentName: row.agentName ?? 'AI assistant',
      createdAt: draft.createdAt.toISOString(),
      decidedAt: draft.decidedAt?.toISOString() ?? null,
      decidedBy:
        draft.decidedBy && row.deciderName
          ? { staffMemberId: toPublicId('staff', draft.decidedBy), displayName: row.deciderName }
          : null,
      rejectReason: row.rejectReason ?? null,
    };
  }
}
