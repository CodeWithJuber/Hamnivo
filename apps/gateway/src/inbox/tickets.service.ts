import type {
  InboxConversationDetail,
  MakeTicketRequest,
  PriorityRequest,
} from '@hamnivo/contracts';
import { ticketReference } from '@hamnivo/contracts';
import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { authorityUnavailable } from '../authority/outbound.service.js';
import { AppError } from '../common/app-error.js';
import { makeTicket } from '../tickets/tickets.js';
import { CLOCK, type Clock } from '../tokens.js';
import { InboxAccess } from './access.js';
import { InboxService } from './inbox.service.js';
import { InboxMessagesService } from './messages.service.js';
import { InboxSignals } from './signals.service.js';
import { syncSla } from './sla.js';

type ControlRow = typeof schema.conversationControls.$inferSelect;

/**
 * Tickets and priority in the inbox (H19), with `conversations.status`. Making a conversation a
 * ticket gives it the tenant's next number; the priority is Chatwoot's own, set there first as the
 * staff member and then in Hamnivo's queue. Every change is audited.
 */
/**
 * Locks the conversation first, as every change to it is ordered, so changes that cross cannot
 * end its reply-time clock twice (H12).
 */
async function lockConversation(tx: TenantTx, conversationId: string): Promise<void> {
  await tx
    .select({ id: schema.conversationControls.id })
    .from(schema.conversationControls)
    .where(eq(schema.conversationControls.id, conversationId))
    .for('update');
}

@Injectable()
export class TicketsService {
  constructor(
    private readonly access: InboxAccess,
    private readonly inbox: InboxService,
    private readonly messages: InboxMessagesService,
    private readonly signals: InboxSignals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The conversation, when the caller may change its status and saw its current owner. */
  private async load(
    principal: StaffPrincipal,
    publicId: string,
    expectedEpoch: number | undefined,
  ): Promise<ControlRow> {
    return this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.status');
      if (expectedEpoch !== undefined && expectedEpoch !== found.control.ownershipEpoch) {
        throw new AppError('OWNERSHIP_CHANGED', {
          detail: 'Someone else changed who handles this conversation. Nothing was changed.',
        });
      }
      return found.control;
    });
  }

  async make(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof MakeTicketRequest>,
  ): Promise<InboxConversationDetail> {
    const control = await this.load(principal, publicId, input.expectedEpoch);
    if (input.priority) await this.inChatwoot(principal, control, input.priority);
    await this.access.tx(principal, async (tx) => {
      await lockConversation(tx, control.id);
      const { number, created } = await makeTicket(
        tx,
        principal.tenantId,
        control.id,
        'staff',
        this.clock(),
      );
      if (input.priority) await this.store(tx, principal, control, publicId, input.priority);
      if (created) {
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', principal.staffMemberId),
          action: 'conversation.ticket_made',
          targetType: 'conversation',
          targetId: publicId,
          outcome: 'success',
          data: { reference: ticketReference(number), source: 'staff' },
        });
      }
    });
    await this.signals.changed(principal.tenantId, [control.id]);
    return this.inbox.detail(principal, publicId);
  }

  async setPriority(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof PriorityRequest>,
  ): Promise<InboxConversationDetail> {
    const control = await this.load(principal, publicId, input.expectedEpoch);
    await this.inChatwoot(principal, control, input.priority);
    await this.access.tx(principal, async (tx) => {
      await lockConversation(tx, control.id);
      await this.store(tx, principal, control, publicId, input.priority);
    });
    await this.signals.changed(principal.tenantId, [control.id]);
    return this.inbox.detail(principal, publicId);
  }

  private async inChatwoot(
    principal: StaffPrincipal,
    control: ControlRow,
    priority: z.output<typeof PriorityRequest>['priority'],
  ): Promise<void> {
    const { runtime, actor } = await this.messages.actor(principal, control);
    try {
      await runtime.authority.setPriority(String(control.externalConversationId), priority, actor);
    } catch (error) {
      throw authorityUnavailable(error, 'The priority could not be changed. Please try again.');
    }
  }

  private async store(
    tx: TenantTx,
    principal: StaffPrincipal,
    control: ControlRow,
    publicId: string,
    priority: z.output<typeof PriorityRequest>['priority'],
  ): Promise<void> {
    const s = schema.conversationInboxState;
    const [before] = await tx
      .select({ priority: s.priority })
      .from(s)
      .where(eq(s.conversationId, control.id));
    await tx
      .insert(s)
      .values({ tenantId: principal.tenantId, conversationId: control.id, priority })
      .onConflictDoUpdate({
        target: [s.tenantId, s.conversationId],
        set: { priority, updatedAt: this.clock() },
      });
    if ((before?.priority ?? null) === priority) return;
    // Another priority has other reply-time targets (H12).
    await syncSla(tx, principal.tenantId, control.id, this.clock());
    await appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action: 'conversation.priority_changed',
      targetType: 'conversation',
      targetId: publicId,
      outcome: 'success',
      data: { from: before?.priority ?? null, to: priority },
    });
  }
}
