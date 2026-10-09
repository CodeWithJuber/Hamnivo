import { createHash } from 'node:crypto';
import { newId, schema, type TenantTx } from '@hamnivo/db';
import {
  type AuthorityConversationState,
  type AuthorityMessage,
  MESSAGE_KEY_PREFIX,
} from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { queueAutomationEvent } from '../automations/events.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { AgentsService } from '../runtime/agents.service.js';
import { HANDOFF_NOTES } from '../runtime/handoff-notes.js';
import { makeTicket } from '../tickets/tickets.js';
import { CLOCK, type Clock } from '../tokens.js';
import { reactionOf } from './extended-parts.js';
import type { JournalEntry } from './journal.service.js';
import { type ControlRow, OwnershipService } from './ownership.service.js';
import { RECONCILE_MIN_SECONDS } from './reconcile-policy.js';
import { uuidV5 } from './uuid.js';

type InboxRow = typeof schema.authorityInboxes.$inferSelect;
export type ChannelKind = 'email' | 'whatsapp' | 'telegram' | 'other';

/** Chatwoot's channel type, as Hamnivo names the channel. */
export function channelKindOf(channelType: string): ChannelKind {
  switch (channelType) {
    case 'Channel::Email':
      return 'email';
    case 'Channel::Whatsapp':
      return 'whatsapp';
    case 'Channel::Telegram':
      return 'telegram';
    default:
      return 'other';
  }
}

/**
 * Senders that never read replies: delivery reports and newsletters. Their mail reaches people,
 * but nothing automatic answers it (an auto-reply to an auto-reply never ends).
 */
export function automatedSender(address: string | null | undefined): boolean {
  if (!address) return false;
  const local = address.split('@')[0]?.toLowerCase() ?? '';
  return /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)([+._-].*)?$/.test(local);
}

/**
 * Takes over the conversations Chatwoot creates on a brand's channel inboxes (ADR 0013): email,
 * WhatsApp and Telegram. Each gets the control row a widget conversation gets, so the inbox,
 * routing, automations and the AI follow it like any other. Web chat conversations are never
 * adopted: the widget records its own, possibly after Chatwoot's webhook arrives.
 */
@Injectable()
export class ChannelAdoption {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ownership: OwnershipService,
    private readonly agents: AgentsService,
  ) {}

  /**
   * Records a conversation from a channel inbox. Returns what the hand-over to people wrote to the
   * journal, or null when the conversation is not one to adopt (or another path just did).
   */
  async adopt(
    tx: TenantTx,
    tenantId: string,
    connectionId: string,
    state: AuthorityConversationState,
  ): Promise<JournalEntry[] | null> {
    if (state.attributes.hv_conversation !== undefined) return null;
    // A closed conversation found late (by the inbox poll) stays in Chatwoot's history only.
    if (state.status === 'resolved') return null;
    const external = Number(state.ref);
    const inboxRef = Number(state.inboxRef);
    if (!Number.isInteger(external) || !Number.isInteger(inboxRef)) return null;
    const [inbox] = await tx
      .select()
      .from(schema.authorityInboxes)
      .where(
        and(
          eq(schema.authorityInboxes.connectionId, connectionId),
          eq(schema.authorityInboxes.externalInboxId, inboxRef),
          eq(schema.authorityInboxes.purpose, 'channel'),
          eq(schema.authorityInboxes.status, 'active'),
        ),
      );
    if (!inbox?.brandId || inbox.pausedAt) return null;
    const brandId = inbox.brandId;
    const now = this.clock();
    const { id: principalId, handle } = await this.customer(tx, tenantId, inbox, brandId, state);
    const [bot] =
      state.owner.kind === 'bot'
        ? await tx
            .select({ id: schema.authorityBots.id })
            .from(schema.authorityBots)
            .where(
              and(
                eq(schema.authorityBots.connectionId, connectionId),
                eq(schema.authorityBots.externalBotId, Number(state.owner.botRef)),
                eq(schema.authorityBots.status, 'active'),
              ),
            )
        : [];
    const conversationId = newId();
    const [created] = await tx
      .insert(schema.conversationControls)
      .values({
        id: conversationId,
        tenantId,
        connectionId,
        inboxId: inbox.id,
        brandId,
        principalId,
        externalConversationId: external,
        ownerMode: bot ? 'AI_ACTIVE' : 'WAITING_HUMAN',
        ownerBotId: bot?.id ?? null,
        authorityStatus: state.status,
        // Left unset, so the state that adopted it is then applied like any later one.
        authorityUpdatedAt: null,
      })
      .onConflictDoNothing()
      .returning({ id: schema.conversationControls.id });
    if (!created) return null;
    // Messages that came before the adoption are read once too (lastExternalId 0), so a
    // conversation found by the inbox poll still reaches people and the AI.
    await tx
      .insert(schema.reconcileCursors)
      .values({
        tenantId,
        connectionId,
        scope: 'conversation',
        scopeRef: String(external),
        lastExternalId: 0,
        intervalSeconds: RECONCILE_MIN_SECONDS,
        nextPollAt: new Date(now.getTime() + RECONCILE_MIN_SECONDS * 1000),
      })
      .onConflictDoNothing();
    await tx
      .update(schema.authorityInboxes)
      .set({ lastEventAt: now })
      .where(eq(schema.authorityInboxes.id, inbox.id));
    // An email is a ticket from the start (ADR 0010): it has a number and waits for an answer.
    if (channelKindOf(inbox.channelType) === 'email') {
      await makeTicket(tx, tenantId, conversationId, 'email', now);
    }
    if (inbox.defaultTeamId) await this.toTeam(tx, tenantId, conversationId, inbox.defaultTeamId);
    if (!bot) return [];
    // Chatwoot gave it to Hamnivo's bot. The AI keeps it only where the owner let it answer.
    // Mail from an address that never reads replies goes to people as well.
    const aiAllowed = inbox.aiAnswers && !automatedSender(handle);
    const decision = await this.agents.answering(tx, brandId);
    if (aiAllowed && decision.answering) return [];
    const reason = aiAllowed && !decision.answering ? decision.reason : 'channel_ai_off';
    const result = await this.ownership.transition(
      tx,
      tenantId,
      conversationId,
      { kind: 'queue' },
      {
        origin: 'hamnivo',
        reason,
        actor: { type: 'system', id: 'ai' },
        handoffNote: HANDOFF_NOTES[reason],
      },
    );
    return result.journal;
  }

  /**
   * One customer per address on each channel of the brand: the same email address or phone number
   * is the same customer in every conversation. The address is self-reported, so it never counts
   * as verified and never joins a signed-in customer.
   */
  private async customer(
    tx: TenantTx,
    tenantId: string,
    inbox: InboxRow,
    brandId: string,
    state: AuthorityConversationState,
  ): Promise<{ id: string; handle: string }> {
    const kind = channelKindOf(inbox.channelType);
    const contact = state.contact ?? null;
    const address = kind === 'email' ? contact?.email : kind === 'whatsapp' ? contact?.phone : null;
    const handle =
      address?.trim() ||
      (state.contactRef ? `chatwoot:${state.contactRef}` : `conversation:${state.ref}`);
    const now = this.clock();
    const [principal] = await tx
      .insert(schema.customerPrincipals)
      .values({
        tenantId,
        brandId,
        kind: 'channel',
        channelKind: kind,
        channelHandle: handle,
        displayName: contact?.name?.trim() || null,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.customerPrincipals.tenantId,
          schema.customerPrincipals.brandId,
          schema.customerPrincipals.channelKind,
          schema.customerPrincipals.channelHandle,
        ],
        targetWhere: sql`${schema.customerPrincipals.channelHandle} is not null`,
        set: {
          lastSeenAt: now,
          displayName: sql`coalesce(${schema.customerPrincipals.displayName}, excluded.display_name)`,
        },
      })
      .returning({ id: schema.customerPrincipals.id });
    if (!principal) throw new Error('channel customer was not recorded');
    return { id: principal.id, handle };
  }

  /** The channel's team takes the conversation, and routing leaves it there (like a chosen team). */
  private async toTeam(tx: TenantTx, tenantId: string, conversationId: string, teamId: string) {
    const [team] = await tx
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    if (!team) return;
    await tx
      .insert(schema.conversationInboxState)
      .values({ tenantId, conversationId, teamId })
      .onConflictDoUpdate({
        target: [
          schema.conversationInboxState.tenantId,
          schema.conversationInboxState.conversationId,
        ],
        set: { teamId, updatedAt: this.clock() },
      });
    await enqueueOutbox(tx, tenantId, {
      topic: 'conversation.team_changed',
      aggregateType: 'conversation',
      aggregateId: conversationId,
      payload: { conversationId, teamId, actorStaffMemberId: null },
    });
  }

  /** Whether the conversation's customer writes from an address that never reads replies. */
  private async automated(tx: TenantTx, control: ControlRow): Promise<boolean> {
    if (!control.principalId) return false;
    const [principal] = await tx
      .select({ handle: schema.customerPrincipals.channelHandle })
      .from(schema.customerPrincipals)
      .where(eq(schema.customerPrincipals.id, control.principalId));
    return automatedSender(principal?.handle);
  }

  /**
   * A customer message that came in on a channel. The widget's messages pass through Hamnivo's
   * ledger on their way to Chatwoot; these arrive the other way, so the ledger records them here
   * (key `hv1:x:`) and the same work starts: the AI's turn, routing and the brand's automations.
   * Seen again (webhook and reconciler), the message is recorded once and starts nothing more.
   */
  async customerMessage(
    tx: TenantTx,
    tenantId: string,
    control: ControlRow,
    message: AuthorityMessage,
  ): Promise<void> {
    if (
      message.direction !== 'incoming' ||
      message.private ||
      message.key !== null ||
      message.sender.kind !== 'contact' ||
      !control.principalId
    ) {
      return;
    }
    const [inbox] = await tx
      .select({
        id: schema.authorityInboxes.id,
        purpose: schema.authorityInboxes.purpose,
        channelType: schema.authorityInboxes.channelType,
      })
      .from(schema.authorityInboxes)
      .where(eq(schema.authorityInboxes.id, control.inboxId));
    if (inbox?.purpose !== 'channel') return;
    const key = uuidV5(control.id, `external:${message.ref}`);
    const now = this.clock();
    const [ledger] = await tx
      .insert(schema.messageLedger)
      .values({
        tenantId,
        conversationId: control.id,
        senderKind: 'customer',
        senderId: control.principalId,
        clientMessageId: key,
        requestHash: createHash('sha256').update(`external:${message.ref}`).digest(),
        state: 'committed',
        sourceKey: `${MESSAGE_KEY_PREFIX.external}${key}`,
        authorityMessageId: Number(message.ref),
        committedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.messageLedger.id });
    if (!ledger) return;
    await tx
      .update(schema.authorityInboxes)
      .set({ lastEventAt: now })
      .where(eq(schema.authorityInboxes.id, inbox.id));
    // A reaction (W22) is not a question: nobody is asked to answer it.
    if (reactionOf(message)) return;
    const conversationId = control.id;
    const quiet =
      channelKindOf(inbox.channelType) === 'email' && (await this.automated(tx, control));
    if (!quiet) {
      await enqueueOutbox(tx, tenantId, {
        topic: 'conversation.customer_message',
        aggregateType: 'conversation',
        aggregateId: conversationId,
        payload: { conversationId, ledgerId: ledger.id, epoch: control.ownershipEpoch },
      });
    }
    if (control.lastCustomerMessageAt === null) {
      await enqueueOutbox(tx, tenantId, {
        topic: 'conversation.route',
        aggregateType: 'conversation',
        aggregateId: conversationId,
        payload: { conversationId, trigger: 'new_conversation', ref: `new:${ledger.id}` },
      });
      if (!quiet) {
        await queueAutomationEvent(tx, tenantId, control.brandId, {
          conversationId,
          event: 'chat_started',
          ref: `message:${ledger.id}`,
        });
      }
    }
    if (quiet) return;
    await queueAutomationEvent(tx, tenantId, control.brandId, {
      conversationId,
      event: 'customer_message',
      ref: `message:${ledger.id}`,
      ledgerId: ledger.id,
    });
  }
}
