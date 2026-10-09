import { parseChatwootEvent } from '@hamnivo/chatwoot';
import {
  type ClaimedInboxEvent,
  claimIntegrationInbox,
  type Db,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import type { AuthorityConversationState, AuthorityEvent, AuthorityMessage } from '@hamnivo/domain';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { queueAutomationEvent } from '../automations/events.js';
import { confirmCardPublication } from '../commerce/card-publisher.service.js';
import type { AppConfig } from '../config.js';
import { projectInboxState } from '../inbox/projection.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { retryDelayMs } from '../outbox/relay.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG, REDIS } from '../tokens.js';
import { isBlocked } from '../visitors/blocks.js';
import { queueReplyWaiting, queueTranscript } from '../widget/notify-queue.js';
import { applyStaffSeen } from '../widget/read-state.js';
import { ChannelAdoption } from './adopt.js';
import { reactionOf } from './extended-parts.js';
import { INBOX_SIGNAL } from './ingress.service.js';
import { type JournalEntry, JournalService } from './journal.service.js';
import { type ControlRow, OwnershipService, type OwnerTarget } from './ownership.service.js';
import { PublicationsService } from './publications.service.js';
import { redactJournaledMessage } from './redaction.js';
import { authorityMessageUuid } from './uuid.js';
import { contractMessage, laneOf, publicationFacts } from './views.js';

const BATCH = 50;
const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 10;

export interface Notification {
  tenantId: string;
  conversationId: string;
  entries: JournalEntry[];
}

/**
 * Applies verified Chatwoot events: confirms Hamnivo's own writes (ledger and publications),
 * journals customer- and staff-lane messages exactly once, applies newer conversation state and
 * detects ownership changes made inside Chatwoot. Webhooks only reduce latency; the reconciler
 * guarantees completeness.
 */
@Injectable()
export class InboxProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(InboxProcessor.name);
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private loop: Promise<unknown> | undefined;
  private subscriber: Redis | undefined;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly journal: JournalService,
    private readonly ownership: OwnershipService,
    private readonly publications: PublicationsService,
    private readonly adoption: ChannelAdoption,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.stopped = false;
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('message', () => this.wake());
    await this.subscriber.subscribe(INBOX_SIGNAL);
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.loop;
    await this.subscriber?.quit().catch(() => undefined);
  }

  private wake() {
    if (this.stopped || this.loop) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.loop = this.drainOnce()
        .then((count) => {
          this.loop = undefined;
          this.schedule(count === BATCH ? 0 : 1000);
        })
        .catch((error: unknown) => {
          this.loop = undefined;
          this.logger.error(`integration inbox failed: ${String(error)}`);
          this.schedule(5000);
        });
    }, delay);
  }

  /** Processes one batch of due events; returns how many were leased. */
  async drainOnce(): Promise<number> {
    const claims = await claimIntegrationInbox(this.db, {
      limit: BATCH,
      leaseSeconds: LEASE_SECONDS,
    });
    for (const claim of claims) await this.processOne(claim);
    return claims.length;
  }

  private async processOne(claim: ClaimedInboxEvent): Promise<void> {
    const notifications: Notification[] = [];
    try {
      await withTenant(this.db, { tenantId: claim.tenantId, actorId: 'authority' }, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.integrationInbox)
          .where(eq(schema.integrationInbox.id, claim.id));
        if (!row || row.processedAt) return;
        const event = parseChatwootEvent(row.payload);
        notifications.push(...(await this.apply(tx, claim.tenantId, row.connectionId, event)));
        await tx
          .update(schema.integrationInbox)
          .set({ processedAt: this.clock(), lastError: null })
          .where(eq(schema.integrationInbox.id, claim.id));
      });
    } catch (error) {
      const dead = claim.attempts >= MAX_ATTEMPTS;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `integration event ${claim.id} failed (attempt ${claim.attempts}): ${message}`,
      );
      await withTenant(this.db, { tenantId: claim.tenantId }, (tx) =>
        tx
          .update(schema.integrationInbox)
          .set({
            lastError: dead ? `dead-letter: ${message}` : message,
            availableAt: new Date(this.clock().getTime() + retryDelayMs(claim.attempts)),
            ...(dead ? { processedAt: this.clock() } : {}),
          })
          .where(eq(schema.integrationInbox.id, claim.id)),
      );
      return;
    }
    for (const n of notifications) {
      if (n.entries.length > 0) await this.journal.notify(n.tenantId, n.conversationId, n.entries);
      else await this.journal.signalInbox(n.tenantId, n.conversationId);
    }
  }

  private async control(
    tx: TenantTx,
    connectionId: string,
    conversationRef: string,
  ): Promise<ControlRow | null> {
    const external = Number(conversationRef);
    if (!Number.isInteger(external)) return null;
    const [control] = await tx
      .select()
      .from(schema.conversationControls)
      .where(
        and(
          eq(schema.conversationControls.connectionId, connectionId),
          eq(schema.conversationControls.externalConversationId, external),
        ),
      )
      .for('update');
    return control ?? null;
  }

  async apply(
    tx: TenantTx,
    tenantId: string,
    connectionId: string,
    event: AuthorityEvent,
  ): Promise<Notification[]> {
    switch (event.type) {
      case 'message.created':
      case 'message.updated':
        return this.applyMessage(
          tx,
          tenantId,
          connectionId,
          event.type,
          event.message,
          event.conversation,
        );
      case 'conversation.created':
      case 'conversation.updated':
      case 'conversation.status_changed':
        return this.applyConversation(tx, tenantId, connectionId, event.conversation);
      default:
        return [];
    }
  }

  private async applyMessage(
    tx: TenantTx,
    tenantId: string,
    connectionId: string,
    type: 'message.created' | 'message.updated',
    message: AuthorityMessage,
    conversation?: AuthorityConversationState,
  ): Promise<Notification[]> {
    let control = await this.control(tx, connectionId, message.conversationRef);
    const adopted: JournalEntry[] = [];
    // A channel conversation whose first webhook was lost: its message carries it (ADR 0013).
    if (!control && conversation && type === 'message.created') {
      adopted.push(
        ...((await this.adoption.adopt(tx, tenantId, connectionId, conversation)) ?? []),
      );
      control = await this.control(tx, connectionId, message.conversationRef);
    }
    if (!control) return [];
    const authorityId = Number(message.ref);
    const now = this.clock();
    let clientMessageId: string | null = null;
    if (message.key?.startsWith('hv1:m:')) {
      const [ledger] = await tx
        .select({
          id: schema.messageLedger.id,
          state: schema.messageLedger.state,
          senderKind: schema.messageLedger.senderKind,
          clientMessageId: schema.messageLedger.clientMessageId,
        })
        .from(schema.messageLedger)
        .where(eq(schema.messageLedger.sourceKey, message.key));
      clientMessageId = ledger?.clientMessageId ?? null;
      if (ledger && ledger.state !== 'committed') {
        await tx
          .update(schema.messageLedger)
          .set({
            state: 'committed',
            authorityMessageId: authorityId,
            committedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.messageLedger.id, ledger.id));
        // The webhook can confirm a customer message before the API request that sent it does.
        // Whichever commits the message starts the AI job, so it runs exactly once. A reaction
        // (W22) is not a question: nobody is asked to answer it.
        if (ledger.senderKind === 'customer' && !reactionOf(message)) {
          await enqueueOutbox(tx, tenantId, {
            topic: 'conversation.customer_message',
            aggregateType: 'conversation',
            aggregateId: control.id,
            payload: {
              conversationId: control.id,
              ledgerId: ledger.id,
              epoch: control.ownershipEpoch,
            },
          });
        }
      }
    } else if (message.key?.startsWith('hv1:p:')) {
      await this.publications.confirm(tx, tenantId, control, message.key, message);
    } else if (message.key?.startsWith('hv1:c:')) {
      await confirmCardPublication(tx, message.key, message, now);
    }

    const entries: JournalEntry[] = [...adopted];
    const lane = laneOf(message);
    // Webhooks and the reconciler can both deliver a message; only its first sighting acts on it.
    let fresh = false;
    if (lane) {
      const facts = (await publicationFacts(tx, control.id, [message])).get(message.ref);
      const view = contractMessage({
        message,
        id: toPublicId('message', authorityMessageUuid(connectionId, message.ref)),
        conversationId: toPublicId('conversation', control.id),
        sequence: null,
        clientMessageId,
        delivery: message.direction === 'incoming' ? 'accepted' : null,
        ...(facts ? { facts } : {}),
      });
      if (type === 'message.created') {
        fresh = !(await this.journal.hasMessage(tx, control.id, lane, authorityId));
        if (fresh) {
          entries.push(
            ...(await this.journal.append(tx, tenantId, control.id, [
              {
                lane,
                type: 'message.created',
                data: { message: view },
                authorityCreatedAt: message.createdAt,
                authorityId,
              },
            ])),
          );
        }
      } else if (message.contentAttributes.deleted === true) {
        // Deleted in the authority (W23): stored copies lose their text, and the lane hears once.
        entries.push(
          ...(await redactJournaledMessage(tx, this.journal, {
            tenantId,
            conversationId: control.id,
            lane,
            authorityId,
            messageId: view.id,
          })),
        );
      } else {
        entries.push(
          ...(await this.journal.append(tx, tenantId, control.id, [
            { lane, type: 'message.updated', data: { message: view }, authorityId },
          ])),
        );
      }
      // A reply from staff or the assistant: the customer may want an email if it waits (W25).
      if (
        type === 'message.created' &&
        lane === 'customer' &&
        (message.sender.kind === 'user' || message.sender.kind === 'bot')
      ) {
        await queueReplyWaiting(
          tx,
          tenantId,
          control,
          authorityId,
          new Date(now.getTime() + this.config.CUSTOMER_REPLY_EMAIL_DELAY_SECONDS * 1000),
        );
      }
    }
    if (type === 'message.created') {
      await this.adoption.customerMessage(tx, tenantId, control, message);
    }
    if (message.direction === 'incoming') {
      await tx
        .update(schema.conversationControls)
        .set({ lastCustomerMessageAt: message.createdAt })
        .where(eq(schema.conversationControls.id, control.id));
    }

    // A person replying publicly in Chatwoot takes the conversation over from the AI.
    if (
      fresh &&
      lane === 'customer' &&
      message.sender.kind === 'user' &&
      control.ownerMode !== 'HUMAN_ACTIVE' &&
      control.ownerSyncedEpoch === control.ownershipEpoch
    ) {
      const externalUserId = Number(message.sender.ref);
      const result = await this.ownership.transition(
        tx,
        tenantId,
        control.id,
        {
          kind: 'external',
          externalUserId,
          staffMemberId: await this.staffOf(tx, connectionId, externalUserId),
        },
        { origin: 'authority', reason: 'human_reply', actor: { type: 'system', id: 'authority' } },
      );
      entries.push(...result.journal);
    }
    return entries.length ? [{ tenantId, conversationId: control.id, entries }] : [];
  }

  private async staffOf(
    tx: TenantTx,
    connectionId: string,
    externalUserId: number,
  ): Promise<string | null> {
    const [link] = await tx
      .select({ staffMemberId: schema.staffAuthorityLinks.staffMemberId })
      .from(schema.staffAuthorityLinks)
      .where(
        and(
          eq(schema.staffAuthorityLinks.connectionId, connectionId),
          eq(schema.staffAuthorityLinks.externalUserId, externalUserId),
          eq(schema.staffAuthorityLinks.status, 'active'),
        ),
      );
    return link?.staffMemberId ?? null;
  }

  private async targetFromAuthority(
    tx: TenantTx,
    connectionId: string,
    control: ControlRow,
    state: AuthorityConversationState,
  ): Promise<OwnerTarget | null> {
    switch (state.owner.kind) {
      case 'bot': {
        const [bot] = await tx
          .select({ id: schema.authorityBots.id })
          .from(schema.authorityBots)
          .where(
            and(
              eq(schema.authorityBots.connectionId, connectionId),
              eq(schema.authorityBots.externalBotId, Number(state.owner.botRef)),
            ),
          );
        return bot ? { kind: 'ai', botId: bot.id } : null;
      }
      case 'user': {
        const externalUserId = Number(state.owner.userRef);
        const staffMemberId = await this.staffOf(tx, connectionId, externalUserId);
        return staffMemberId
          ? { kind: 'external', externalUserId, staffMemberId }
          : { kind: 'external', externalUserId, staffMemberId: null };
      }
      default:
        if (state.status === 'resolved') return null;
        return control.ownerMode === 'AI_ACTIVE' || control.ownerMode === 'HUMAN_ACTIVE'
          ? { kind: 'queue' }
          : null;
    }
  }

  private async applyConversation(
    tx: TenantTx,
    tenantId: string,
    connectionId: string,
    state: AuthorityConversationState,
  ): Promise<Notification[]> {
    let control = await this.control(tx, connectionId, state.ref);
    const adopted: JournalEntry[] = [];
    if (!control) {
      // Chatwoot started it on an email, WhatsApp or Telegram inbox: Hamnivo takes it over.
      adopted.push(...((await this.adoption.adopt(tx, tenantId, connectionId, state)) ?? []));
      control = await this.control(tx, connectionId, state.ref);
    }
    if (!control) return [];
    // When staff last looked moves without a new version (Chatwoot writes it directly), so it is
    // read before the version check (W06).
    const receipts = await applyStaffSeen(
      tx,
      this.journal,
      tenantId,
      control,
      state.staffLastSeenAt,
      this.clock(),
    );
    if (control.authorityUpdatedAt !== null && state.version <= control.authorityUpdatedAt) {
      return receipts.length ? [{ tenantId, conversationId: control.id, entries: receipts }] : [];
    }
    const entries: JournalEntry[] = [...adopted, ...receipts];
    await tx
      .update(schema.conversationControls)
      .set({
        authorityStatus: state.status,
        authorityUpdatedAt: state.version,
        updatedAt: this.clock(),
      })
      .where(eq(schema.conversationControls.id, control.id));
    await projectInboxState(tx, tenantId, control.id, connectionId, state);
    const wasResolved = control.authorityStatus === 'resolved';
    if (!wasResolved && state.status === 'resolved') {
      const resolved = await this.journal.append(tx, tenantId, control.id, [
        { lane: 'customer', type: 'conversation.resolved', data: { canReopen: true } },
      ]);
      entries.push(...resolved);
      // The customer asked for a transcript when a conversation closes (W25).
      await queueTranscript(tx, tenantId, control, resolved[0]?.seq ?? control.journalSeq);
      // Closing a blocked sender's conversation (H20) is Hamnivo's own housekeeping, not a chat
      // the brand's automations should follow up on.
      const blocked =
        control.brandId !== null &&
        control.principalId !== null &&
        (await isBlocked(tx, control.brandId, control.principalId, this.clock()));
      if (!blocked) {
        await queueAutomationEvent(tx, tenantId, control.brandId, {
          conversationId: control.id,
          event: 'chat_closed',
          ref: `authority:${state.version}`,
        });
      }
    } else if (wasResolved && state.status !== 'resolved') {
      entries.push(
        ...(await this.journal.append(tx, tenantId, control.id, [
          { lane: 'customer', type: 'conversation.reopened', data: {} },
        ])),
      );
    }
    // Read ownership back only when Chatwoot already reflects Hamnivo's latest change; otherwise
    // this state predates it and would undo a takeover that is still being applied.
    if (control.ownerSyncedEpoch === control.ownershipEpoch) {
      const target = await this.targetFromAuthority(tx, connectionId, control, state);
      if (target) {
        const result = await this.ownership.transition(tx, tenantId, control.id, target, {
          origin: 'authority',
          reason: target.kind === 'queue' ? 'authority_handoff' : 'authority_assignment',
          actor: { type: 'system', id: 'authority' },
        });
        entries.push(...result.journal);
      }
    }
    // Staff inboxes are told even when nothing reached the journal (tags, team, a new owner).
    return [{ tenantId, conversationId: control.id, entries }];
  }
}
