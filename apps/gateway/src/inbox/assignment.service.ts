import { createHash } from 'node:crypto';
import type {
  AssigneeOptions,
  AssignRequest,
  InboxConversationDetail,
  TransferRequest,
} from '@hamnivo/contracts';
import { appendAudit, fromPublicId, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { type Permission, type ResourceScope, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import canonicalize from 'canonicalize';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { JournalService } from '../authority/journal.service.js';
import { OutboundMessagesService } from '../authority/outbound.service.js';
import {
  type ControlRow,
  currentOwnerOf,
  OwnershipService,
  type OwnerTarget,
  type TransitionOptions,
} from '../authority/ownership.service.js';
import { AppError } from '../common/app-error.js';
import { ownedByOther } from '../conversations/staff-conversations.service.js';
import { enforce } from '../identity/staff.guard.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { AgentsService } from '../runtime/agents.service.js';
import { HANDOFF_NOTES } from '../runtime/handoff-notes.js';
import { CLOCK, type Clock } from '../tokens.js';
import { type ConversationAccess, InboxAccess } from './access.js';
import { AvailabilityService } from './availability.service.js';
import { eligibleStaffAt } from './eligible.js';
import { InboxService } from './inbox.service.js';
import { InboxMessagesService } from './messages.service.js';
import { InboxSignals } from './signals.service.js';

type Target = z.output<typeof AssignRequest>['to'];

/**
 * Who handles a conversation (H02, H08): claim it, give it to a colleague or a team, put it back
 * in the queue or hand it back to the AI. Every change is the ownership-epoch transaction, so an
 * AI reply started before it is fenced out, and an `expectedEpoch` from a stale view is refused.
 */
@Injectable()
export class AssignmentService {
  constructor(
    private readonly access: InboxAccess,
    private readonly ownership: OwnershipService,
    private readonly journal: JournalService,
    private readonly agents: AgentsService,
    private readonly inbox: InboxService,
    private readonly signals: InboxSignals,
    private readonly outbound: OutboundMessagesService,
    private readonly messages: InboxMessagesService,
    private readonly availability: AvailabilityService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Active staff whose grants let them reply in a conversation at `resource`. */
  eligibleStaff(
    tx: TenantTx,
    resource: ResourceScope,
  ): Promise<{ staffMemberId: string; displayName: string }[]> {
    return eligibleStaffAt(tx, resource, this.clock());
  }

  private async primaryBot(tx: TenantTx, control: ControlRow) {
    const [bot] = await tx
      .select({ id: schema.authorityBots.id, name: schema.authorityBots.name })
      .from(schema.authorityBots)
      .where(
        and(
          eq(schema.authorityBots.connectionId, control.connectionId),
          eq(schema.authorityBots.role, 'primary'),
          eq(schema.authorityBots.status, 'active'),
        ),
      );
    return bot ?? null;
  }

  async assignees(
    principal: StaffPrincipal,
    publicId: string,
  ): Promise<z.infer<typeof AssigneeOptions>> {
    return this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.read');
      const staff = await this.eligibleStaff(tx, found.resource);
      const ids = staff.map((s) => s.staffMemberId);
      const statuses = await this.availability.statuses(tx, principal.tenantId, ids);
      // How busy each person is, and their limit (HNV-10-03): "3 of 5 chats".
      const c = schema.conversationControls;
      const open = ids.length
        ? await tx
            .select({ staffMemberId: c.ownerStaffId, count: sql<number>`count(*)::int` })
            .from(c)
            .where(
              and(
                eq(c.ownerMode, 'HUMAN_ACTIVE'),
                inArray(c.ownerStaffId, ids),
                inArray(c.authorityStatus, ['open', 'pending']),
              ),
            )
            .groupBy(c.ownerStaffId)
        : [];
      const limits = ids.length
        ? await tx
            .select({
              staffMemberId: schema.staffRoutingProfiles.staffMemberId,
              maxOpenChats: schema.staffRoutingProfiles.maxOpenChats,
            })
            .from(schema.staffRoutingProfiles)
            .where(inArray(schema.staffRoutingProfiles.staffMemberId, ids))
        : [];
      const teams = await tx
        .select({ id: schema.teams.id, name: schema.teams.name })
        .from(schema.teams)
        .where(
          and(
            eq(schema.teams.status, 'active'),
            found.workspaceId
              ? or(
                  isNull(schema.teams.workspaceId),
                  eq(schema.teams.workspaceId, found.workspaceId),
                )
              : isNull(schema.teams.workspaceId),
          ),
        )
        .orderBy(schema.teams.name);
      const bot = await this.primaryBot(tx, found.control);
      const answering = found.control.brandId
        ? await this.agents.answering(tx, found.control.brandId)
        : { answering: false as const };
      return {
        staff: staff.map((s) => ({
          staffMemberId: toPublicId('staff', s.staffMemberId),
          displayName: s.displayName,
          current:
            found.control.ownerMode === 'HUMAN_ACTIVE' &&
            found.control.ownerStaffId === s.staffMemberId,
          status: statuses.get(s.staffMemberId) ?? 'offline',
          openChats: Number(open.find((row) => row.staffMemberId === s.staffMemberId)?.count ?? 0),
          maxOpenChats:
            limits.find((row) => row.staffMemberId === s.staffMemberId)?.maxOpenChats ?? null,
        })),
        teams: teams.map((t) => ({ id: toPublicId('team', t.id), name: t.name })),
        ai: { available: Boolean(bot) && answering.answering, displayName: bot?.name ?? null },
      };
    });
  }

  async assign(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof AssignRequest>,
  ): Promise<InboxConversationDetail> {
    const outcome = await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.read');
      const plan = await this.plan(tx, principal, found, input.to);
      enforce(this.access.decide(principal, plan.permission, found.resource));
      const result = await this.ownership.transition(
        tx,
        principal.tenantId,
        found.control.id,
        plan.target,
        {
          origin: 'hamnivo',
          reason: plan.reason,
          actor: { type: 'staff', id: toPublicId('staff', principal.staffMemberId) },
          actorStaffMemberId: principal.staffMemberId,
          ...(input.expectedEpoch !== undefined ? { expectedEpoch: input.expectedEpoch } : {}),
        },
      );
      return result;
    });
    // A change the customer sees is journaled (which signals staff inboxes too); others only signal.
    if (outcome.journal.length > 0) {
      await this.journal.notify(principal.tenantId, outcome.control.id, outcome.journal);
    } else {
      await this.signals.changed(principal.tenantId, [outcome.control.id]);
    }
    return this.inbox.detail(principal, publicId);
  }

  /** What an assignment means: the new owner, why, and the permission it needs. */
  private async plan(
    tx: TenantTx,
    principal: StaffPrincipal,
    found: ConversationAccess,
    to: Target,
  ): Promise<{
    target: OwnerTarget;
    reason: TransitionOptions['reason'];
    permission: Permission;
  }> {
    const me = principal.staffMemberId;
    const control = found.control;
    const mine = control.ownerMode === 'HUMAN_ACTIVE' && control.ownerStaffId === me;
    const staffId = to.kind === 'staff' ? fromPublicId('staff', to.staffMemberId) : null;
    if (to.kind === 'me' || staffId === me) {
      if (ownedByOther(control, me)) {
        // Taking a conversation from a colleague is for supervisors; others request a transfer.
        if (!this.access.can(principal, 'conversations.assign', found.resource)) {
          throw new AppError('OWNERSHIP_CHANGED', {
            detail: 'A colleague is handling this conversation. Ask them to hand it over.',
            currentOwner: await currentOwnerOf(tx, control),
          });
        }
      }
      return {
        target: { kind: 'staff', staffMemberId: me },
        reason: 'staff_takeover',
        permission: 'conversations.takeover',
      };
    }
    if (to.kind === 'staff' && staffId) {
      const eligible = await this.eligibleStaff(tx, found.resource);
      if (!eligible.some((s) => s.staffMemberId === staffId)) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [
            {
              path: 'to.staffMemberId',
              message: 'This person cannot answer conversations here.',
            },
          ],
        });
      }
      return {
        target: { kind: 'staff', staffMemberId: staffId },
        reason: 'staff_assign',
        permission: 'conversations.assign',
      };
    }
    if (to.kind === 'queue') {
      return {
        target: { kind: 'queue' },
        reason: 'staff_release',
        permission: mine ? 'conversations.takeover' : 'conversations.assign',
      };
    }
    const bot = await this.primaryBot(tx, control);
    if (!bot) {
      throw new AppError('FEATURE_DISABLED', {
        detail: 'No AI assistant is attached to this inbox.',
      });
    }
    if (control.brandId) {
      const answering = await this.agents.answering(tx, control.brandId);
      if (!answering.answering) {
        throw new AppError('FEATURE_DISABLED', { detail: HANDOFF_NOTES[answering.reason] });
      }
    }
    return {
      target: { kind: 'ai', botId: bot.id },
      reason: 'return_to_ai',
      permission: mine ? 'conversations.takeover' : 'conversations.assign',
    };
  }

  /** Puts the conversation in a team's queue, or takes it out (H02). */
  async setTeam(
    principal: StaffPrincipal,
    publicId: string,
    teamPublicId: string | null,
  ): Promise<InboxConversationDetail> {
    const conversationId = await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.assign');
      let teamId: string | null = null;
      if (teamPublicId) {
        teamId = fromPublicId('team', teamPublicId);
        const [team] = await tx.select().from(schema.teams).where(eq(schema.teams.id, teamId));
        const fits =
          team?.status === 'active' &&
          (team.workspaceId === null || team.workspaceId === found.workspaceId);
        if (!fits) {
          throw new AppError('VALIDATION_FAILED', {
            fields: [{ path: 'teamId', message: 'This team cannot take conversations here.' }],
          });
        }
      }
      if ((found.teamId ?? null) === teamId) return found.control.id;
      await tx
        .insert(schema.conversationInboxState)
        .values({ tenantId: principal.tenantId, conversationId: found.control.id, teamId })
        .onConflictDoUpdate({
          target: [
            schema.conversationInboxState.tenantId,
            schema.conversationInboxState.conversationId,
          ],
          set: { teamId, updatedAt: this.clock() },
        });
      await enqueueOutbox(tx, principal.tenantId, {
        topic: 'conversation.team_changed',
        aggregateType: 'conversation',
        aggregateId: found.control.id,
        payload: {
          conversationId: found.control.id,
          teamId,
          actorStaffMemberId: principal.staffMemberId,
        },
      });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'conversation.team_changed',
        targetType: 'conversation',
        targetId: publicId,
        outcome: 'success',
        data: {
          from: found.teamId ? toPublicId('team', found.teamId) : null,
          to: teamPublicId,
        },
      });
      return found.control.id;
    });
    await this.signals.changed(principal.tenantId, [conversationId]);
    return this.inbox.detail(principal, publicId);
  }

  /**
   * Asks the colleague who owns the conversation to hand it over (HNV-08-05), as an internal note
   * from the person asking. Nothing changes owner until the owner or a supervisor acts.
   */
  async requestTransfer(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof TransferRequest>,
  ): Promise<void> {
    const { control, name } = await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'conversations.note');
      if (!ownedByOther(found.control, principal.staffMemberId)) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Nobody else is handling this conversation; you can take it directly.',
        });
      }
      const [me] = await tx
        .select({ name: schema.staffMembers.displayName })
        .from(schema.staffMembers)
        .where(eq(schema.staffMembers.id, principal.staffMemberId));
      return { control: found.control, name: me?.name ?? 'A colleague' };
    });
    const text = `${name} asked to take over this conversation.${input.note ? ` Note: “${input.note}”` : ''}`;
    const { userRef } = await this.messages.actor(principal, control);
    await this.outbound.send({
      tenantId: principal.tenantId,
      actorId: toPublicId('staff', principal.staffMemberId),
      conversationId: control.id,
      sender: { kind: 'staff', id: principal.staffMemberId },
      clientMessageId: input.clientRequestId,
      requestHash: createHash('sha256')
        .update(canonicalize({ transfer: true, note: input.note ?? null }) ?? '')
        .digest(),
      author: { kind: 'staff', userRef },
      visibility: 'private',
      text,
      load: async (tx) =>
        (await this.access.authorized(tx, principal, publicId, 'conversations.note')).control,
      onCommitted: async (tx) => {
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', principal.staffMemberId),
          action: 'conversation.transfer_requested',
          targetType: 'conversation',
          targetId: publicId,
          outcome: 'success',
          data: {
            owner: control.ownerStaffId ? toPublicId('staff', control.ownerStaffId) : null,
          },
        });
      },
    });
    await this.signals.changed(principal.tenantId, [control.id]);
  }
}
