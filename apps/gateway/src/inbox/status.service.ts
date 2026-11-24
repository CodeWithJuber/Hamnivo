import type { InboxConversationDetail, StatusRequest } from '@hamnivo/contracts';
import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { type JournalEntry, JournalService } from '../authority/journal.service.js';
import { authorityUnavailable } from '../authority/outbound.service.js';
import { OwnershipService } from '../authority/ownership.service.js';
import { queueAutomationEvent } from '../automations/events.js';
import { AppError } from '../common/app-error.js';
import { ownedByOther } from '../conversations/staff-conversations.service.js';
import { enforce } from '../identity/staff.guard.js';
import { CLOCK, type Clock } from '../tokens.js';
import { InboxAccess } from './access.js';
import { supersedeAiDrafts } from './ai-drafts.js';
import { InboxService } from './inbox.service.js';
import { InboxMessagesService } from './messages.service.js';
import { settleOffer } from './offers.js';
import { InboxSignals } from './signals.service.js';
import { syncSla } from './sla.js';

/**
 * Records in Hamnivo a status Chatwoot already has (resolved, reopened or snoozed): the status,
 * the snooze, the reply-time clock (resolving ends it, H12), an open offer and AI drafts settled,
 * an audit event, the "chat closed" automation event, and what the customer's chat is told.
 * Staff (Inbox) and customers (End this chat in the widget) change a status through this one
 * path, so both mean the same. Returns the journal entries to announce once committed.
 */
export async function recordStatusIn(
  tx: TenantTx,
  ownership: OwnershipService,
  journal: JournalService,
  now: Date,
  input: {
    tenantId: string;
    conversationId: string;
    publicId: string;
    brandId: string | null;
    status: 'open' | 'resolved' | 'snoozed';
    snoozedUntil: Date | null;
    actor: { type: 'staff' | 'customer'; id: string };
    /** Who closed the chat, for automations: `staff:<id>` or `customer:<id>`. */
    automationRef: string;
  },
): Promise<JournalEntry[]> {
  const locked = await ownership.lock(tx, input.conversationId);
  const from = locked.authorityStatus;
  await tx
    .update(schema.conversationControls)
    .set({ authorityStatus: input.status, updatedAt: now })
    .where(eq(schema.conversationControls.id, input.conversationId));
  await tx
    .insert(schema.conversationInboxState)
    .values({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      snoozedUntil: input.snoozedUntil,
    })
    .onConflictDoUpdate({
      target: [
        schema.conversationInboxState.tenantId,
        schema.conversationInboxState.conversationId,
      ],
      set: { snoozedUntil: input.snoozedUntil, updatedAt: now },
    });
  // Snoozing pauses the reply-time clock; resolving ends it (H12) and any AI draft with it.
  await syncSla(tx, input.tenantId, input.conversationId, now);
  await settleOffer(tx, input.conversationId, now);
  if (input.status === 'resolved') {
    await supersedeAiDrafts(tx, input.conversationId, 'resolved', now);
  }
  await appendAudit(tx, {
    actorType: input.actor.type,
    actorId: input.actor.id,
    action: 'conversation.status_changed',
    targetType: 'conversation',
    targetId: input.publicId,
    outcome: 'success',
    data: {
      from,
      to: input.status,
      ...(input.snoozedUntil ? { snoozedUntil: input.snoozedUntil.toISOString() } : {}),
    },
  });
  if (from !== 'resolved' && input.status === 'resolved') {
    await queueAutomationEvent(tx, input.tenantId, input.brandId, {
      conversationId: input.conversationId,
      event: 'chat_closed',
      ref: input.automationRef,
    });
    return journal.append(tx, input.tenantId, input.conversationId, [
      { lane: 'customer', type: 'conversation.resolved', data: { canReopen: true } },
    ]);
  }
  if (from === 'resolved' && input.status !== 'resolved') {
    return journal.append(tx, input.tenantId, input.conversationId, [
      { lane: 'customer', type: 'conversation.reopened', data: {} },
    ]);
  }
  return [];
}

/**
 * Resolve, reopen and snooze (H10) as the staff member, in Chatwoot first and then in Hamnivo,
 * with an audit event for every change. Reopening makes you the owner, as it does in Chatwoot.
 */
@Injectable()
export class StatusService {
  constructor(
    private readonly access: InboxAccess,
    private readonly ownership: OwnershipService,
    private readonly journal: JournalService,
    private readonly inbox: InboxService,
    private readonly messages: InboxMessagesService,
    private readonly signals: InboxSignals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async set(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof StatusRequest>,
  ): Promise<InboxConversationDetail> {
    const until = input.snoozedUntil ? new Date(input.snoozedUntil) : null;
    if (input.status === 'snoozed' && until && until.getTime() <= this.clock().getTime()) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'snoozedUntil', message: 'Choose a time in the future.' }],
      });
    }
    const me = principal.staffMemberId;
    const before = await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.status');
      const control = found.control;
      if (input.expectedEpoch !== undefined && input.expectedEpoch !== control.ownershipEpoch) {
        throw new AppError('OWNERSHIP_CHANGED', {
          detail: 'Someone else changed who handles this conversation. Nothing was changed.',
        });
      }
      const reopening =
        input.status === 'open' &&
        (control.authorityStatus === 'resolved' || control.authorityStatus === 'snoozed');
      const takeOver =
        reopening && !(control.ownerMode === 'HUMAN_ACTIVE' && control.ownerStaffId === me);
      if (takeOver) {
        enforce(this.access.decide(principal, 'conversations.takeover', found.resource));
        if (
          ownedByOther(control, me) &&
          !this.access.can(principal, 'conversations.assign', found.resource)
        ) {
          throw new AppError('OWNERSHIP_CHANGED', {
            detail: 'A colleague is handling this conversation. Ask them to reopen it.',
          });
        }
      }
      return { control, reopening, takeOver };
    });
    const control = before.control;
    if (input.status === 'open' && !before.reopening) return this.inbox.detail(principal, publicId);

    let entries: JournalEntry[] = [];
    if (before.takeOver) {
      // Chatwoot assigns whoever reopens; Hamnivo records the same owner first, with its fence.
      const result = await this.access.tx(principal, (tx) =>
        this.ownership.transition(
          tx,
          principal.tenantId,
          control.id,
          { kind: 'staff', staffMemberId: me },
          {
            origin: 'hamnivo',
            reason: 'staff_takeover',
            actor: { type: 'staff', id: toPublicId('staff', me) },
            actorStaffMemberId: me,
            expectedEpoch: control.ownershipEpoch,
          },
        ),
      );
      entries = result.journal;
    }

    const { runtime, actor } = await this.messages.actor(principal, control);
    const ref = String(control.externalConversationId);
    try {
      if (input.status === 'snoozed') await runtime.authority.snooze(ref, until, actor);
      else await runtime.authority.setStatus(ref, input.status, actor);
    } catch (error) {
      await this.journal.notify(principal.tenantId, control.id, entries);
      throw authorityUnavailable(error, 'The status could not be changed. Please try again.');
    }

    entries.push(
      ...(await this.access.tx(principal, (tx) =>
        recordStatusIn(tx, this.ownership, this.journal, this.clock(), {
          tenantId: principal.tenantId,
          conversationId: control.id,
          publicId,
          brandId: control.brandId,
          status: input.status,
          snoozedUntil: input.status === 'snoozed' ? until : null,
          actor: { type: 'staff', id: toPublicId('staff', me) },
          automationRef: `staff:${principal.staffMemberId}`,
        }),
      )),
    );
    await this.journal.notify(principal.tenantId, control.id, entries);
    await this.signals.changed(principal.tenantId, [control.id]);
    return this.inbox.detail(principal, publicId);
  }
}
