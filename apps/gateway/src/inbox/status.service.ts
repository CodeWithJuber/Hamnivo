import type { InboxConversationDetail, StatusRequest } from '@hamnivo/contracts';
import { appendAudit, schema, toPublicId } from '@hamnivo/db';
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
import { InboxService } from './inbox.service.js';
import { InboxMessagesService } from './messages.service.js';
import { InboxSignals } from './signals.service.js';
import { syncSla } from './sla.js';

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
      ...(await this.access.tx(principal, async (tx) => {
        const locked = await this.ownership.lock(tx, control.id);
        const from = locked.authorityStatus;
        await tx
          .update(schema.conversationControls)
          .set({ authorityStatus: input.status, updatedAt: this.clock() })
          .where(eq(schema.conversationControls.id, control.id));
        const snoozedUntil = input.status === 'snoozed' ? until : null;
        await tx
          .insert(schema.conversationInboxState)
          .values({ tenantId: principal.tenantId, conversationId: control.id, snoozedUntil })
          .onConflictDoUpdate({
            target: [
              schema.conversationInboxState.tenantId,
              schema.conversationInboxState.conversationId,
            ],
            set: { snoozedUntil, updatedAt: this.clock() },
          });
        // Snoozing pauses the reply-time clock; resolving ends it (H12).
        await syncSla(tx, principal.tenantId, control.id, this.clock());
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', me),
          action: 'conversation.status_changed',
          targetType: 'conversation',
          targetId: publicId,
          outcome: 'success',
          data: {
            from,
            to: input.status,
            ...(snoozedUntil ? { snoozedUntil: snoozedUntil.toISOString() } : {}),
          },
        });
        if (from !== 'resolved' && input.status === 'resolved') {
          await queueAutomationEvent(tx, principal.tenantId, control.brandId, {
            conversationId: control.id,
            event: 'chat_closed',
            ref: `staff:${principal.staffMemberId}`,
          });
          return this.journal.append(tx, principal.tenantId, control.id, [
            { lane: 'customer', type: 'conversation.resolved', data: { canReopen: true } },
          ]);
        }
        if (from === 'resolved' && input.status !== 'resolved') {
          return this.journal.append(tx, principal.tenantId, control.id, [
            { lane: 'customer', type: 'conversation.reopened', data: {} },
          ]);
        }
        return [];
      })),
    );
    await this.journal.notify(principal.tenantId, control.id, entries);
    await this.signals.changed(principal.tenantId, [control.id]);
    return this.inbox.detail(principal, publicId);
  }
}
