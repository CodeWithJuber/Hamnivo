import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { OwnerMode } from '@hamnivo/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { actionsInFlightNote, supersedeForOwnerChange } from '../actions/in-flight.js';
import { inFlightNote } from '../commerce/in-flight.js';
import { AppError } from '../common/app-error.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { CLOCK, type Clock } from '../tokens.js';
import { type JournalEntry, JournalService } from './journal.service.js';
import { uuidV5 } from './uuid.js';
import { customerView } from './views.js';

export type ControlRow = typeof schema.conversationControls.$inferSelect;

/** Who should own the conversation next. */
export type OwnerTarget =
  | { kind: 'ai'; botId: string }
  | { kind: 'staff'; staffMemberId: string }
  | { kind: 'external'; externalUserId: number; staffMemberId: string | null }
  | { kind: 'queue' };

export interface TransitionOptions {
  /** `hamnivo`: apply it in Chatwoot through the outbox. `authority`: Chatwoot already did it. */
  origin: 'hamnivo' | 'authority';
  reason:
    | 'staff_takeover'
    | 'staff_reply'
    | 'staff_assign'
    | 'staff_release'
    | 'return_to_ai'
    | 'customer_request'
    | 'authority_assignment'
    | 'authority_handoff'
    | 'human_reply'
    | 'no_agent'
    | 'assist_mode'
    | 'ai_stopped'
    | 'ai_unavailable'
    | 'ai_blocked'
    | 'ai_limit'
    | 'ai_escalated'
    | 'channel_ai_off';
  /** Audit actor (`stf_…`, `cus_…`, `authority`). */
  actor: { type: 'staff' | 'customer' | 'system'; id: string };
  /** The epoch the caller saw; a different current epoch fails with OWNERSHIP_CHANGED. */
  expectedEpoch?: number;
  /** Private note for the new owner (handoff packet). */
  handoffNote?: string;
  /** The staff member who made the change, so Chatwoot records it as theirs. */
  actorStaffMemberId?: string;
}

export interface TransitionResult {
  changed: boolean;
  control: ControlRow;
  journal: JournalEntry[];
}

function modeOf(target: OwnerTarget): OwnerMode {
  switch (target.kind) {
    case 'ai':
      return 'AI_ACTIVE';
    case 'queue':
      return 'WAITING_HUMAN';
    default:
      return 'HUMAN_ACTIVE';
  }
}

function sameOwner(control: ControlRow, target: OwnerTarget): boolean {
  if (control.ownerMode !== modeOf(target)) return false;
  switch (target.kind) {
    case 'ai':
      return control.ownerBotId === target.botId;
    case 'staff':
      return control.ownerStaffId === target.staffMemberId;
    case 'external':
      return (
        control.ownerExternalUserId === target.externalUserId ||
        (target.staffMemberId !== null && control.ownerStaffId === target.staffMemberId)
      );
    case 'queue':
      return true;
  }
}

/**
 * Ownership and fencing (ADR 0003). Every change of who may speak is one transaction on the
 * locked control row: the epoch increases, the customer-visible change is journaled and, for
 * changes Hamnivo starts, an outbox event applies it in Chatwoot. AI publications carry the epoch
 * they started under, so a takeover makes every older AI reply unpublishable.
 */
@Injectable()
export class OwnershipService {
  constructor(
    private readonly journal: JournalService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async lock(tx: TenantTx, conversationId: string): Promise<ControlRow> {
    const [control] = await tx
      .select()
      .from(schema.conversationControls)
      .where(eq(schema.conversationControls.id, conversationId))
      .for('update');
    if (!control) throw new AppError('NOT_FOUND', { detail: 'Conversation not found.' });
    return control;
  }

  async transition(
    tx: TenantTx,
    tenantId: string,
    conversationId: string,
    target: OwnerTarget,
    options: TransitionOptions,
  ): Promise<TransitionResult> {
    const control = await this.lock(tx, conversationId);
    if (options.expectedEpoch !== undefined && options.expectedEpoch !== control.ownershipEpoch) {
      throw new AppError('OWNERSHIP_CHANGED', {
        detail: 'Someone else changed who handles this conversation. Reload and try again.',
      });
    }
    if (sameOwner(control, target)) return { changed: false, control, journal: [] };

    const epoch = control.ownershipEpoch + 1;
    const mode = modeOf(target);
    const [updated] = await tx
      .update(schema.conversationControls)
      .set({
        ownerMode: mode,
        ownershipEpoch: epoch,
        ownerSyncedEpoch: options.origin === 'authority' ? epoch : control.ownerSyncedEpoch,
        ownerStaffId:
          target.kind === 'staff'
            ? target.staffMemberId
            : target.kind === 'external'
              ? target.staffMemberId
              : null,
        ownerExternalUserId: target.kind === 'external' ? target.externalUserId : null,
        ownerBotId: target.kind === 'ai' ? target.botId : null,
        ownerReason: options.reason,
        ownerChangedAt: this.clock(),
        leaseHolder: null,
        leaseExpiresAt: null,
        updatedAt: this.clock(),
      })
      .where(eq(schema.conversationControls.id, conversationId))
      .returning();
    if (!updated) throw new Error('control update returned nothing');

    const before = customerView(control.ownerMode, control.authorityStatus);
    const after = customerView(mode, control.authorityStatus);
    // AI actions are approved for one epoch (G13): pending approvals end here; anything already
    // sent stays open and is reconciled under the new owner (listed in the note below).
    const superseded = await supersedeForOwnerChange(tx, conversationId, epoch, this.clock());
    const updates = [
      ...(before.status !== after.status || before.responder !== after.responder
        ? [{ lane: 'customer' as const, type: 'conversation.updated' as const, data: after }]
        : []),
      ...superseded.map((s) => ({
        lane: (s.approver === 'customer' ? 'customer' : 'staff') as 'customer' | 'staff',
        type: 'approval.updated' as const,
        data: { approvalId: s.actionId, status: 'superseded' },
      })),
    ];
    const journal = updates.length
      ? await this.journal.append(tx, tenantId, conversationId, updates)
      : [];

    // A conversation that now waits for people is routed to a team (J02). Routing runs after this
    // transaction and only picks the team; the handoff itself is already done here.
    if (mode === 'WAITING_HUMAN') {
      await enqueueOutbox(tx, tenantId, {
        topic: 'conversation.route',
        aggregateType: 'conversation',
        aggregateId: conversationId,
        payload: { conversationId, trigger: 'handoff', ref: `handoff:${epoch}` },
      });
    }
    if (options.origin === 'hamnivo') {
      await enqueueOutbox(tx, tenantId, {
        topic: 'conversation.owner_changed',
        aggregateType: 'conversation',
        aggregateId: conversationId,
        payload: {
          conversationId,
          epoch,
          previousMode: control.ownerMode,
          target,
          reason: options.reason,
          ...(options.handoffNote ? { handoffNote: options.handoffNote } : {}),
          ...(options.actorStaffMemberId ? { actorStaffMemberId: options.actorStaffMemberId } : {}),
        },
      });
    }
    await appendAudit(tx, {
      actorType: options.actor.type,
      actorId: options.actor.id,
      action: 'conversation.owner_changed',
      targetType: 'conversation',
      targetId: toPublicId('conversation', conversationId),
      outcome: 'success',
      data: {
        from: control.ownerMode,
        to: mode,
        epoch,
        reason: options.reason,
        origin: options.origin,
      },
    });
    // Whoever takes over sees the money and AI actions still in flight here (R07): on every path
    // by which a person becomes the owner (takeover, inbox claim, assignment by a supervisor, a
    // Chatwoot assignment or reply). A move to the queue waits for the person who picks it up.
    if (mode === 'HUMAN_ACTIVE') {
      const notes = [
        await inFlightNote(tx, conversationId),
        await actionsInFlightNote(tx, conversationId),
      ].filter((n): n is string => n !== null);
      const note = notes.length ? notes.join('\n\n') : null;
      if (note) {
        await enqueueOutbox(tx, tenantId, {
          topic: 'conversation.note',
          aggregateType: 'conversation',
          aggregateId: conversationId,
          payload: {
            conversationId,
            key: `hv1:n:${uuidV5(conversationId, `in-flight:${epoch}`)}`,
            text: note,
          },
        });
      }
    }
    return { changed: true, control: updated, journal };
  }
}
