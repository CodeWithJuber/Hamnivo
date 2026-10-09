import {
  type ClaimedInboxCursor,
  claimReconcileInboxCursors,
  type Db,
  schema,
  withTenant,
} from '@hamnivo/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import {
  CHANNEL_DISCOVERY_REF,
  CHANNEL_DISCOVERY_SECONDS,
  CHANNEL_POLL_SECONDS,
  ChannelInboxesService,
} from './channel-inboxes.service.js';
import { JournalService } from './journal.service.js';
import { InboxProcessor, type Notification } from './processor.service.js';
import { RECONCILE_ERROR_MAX_SECONDS } from './reconcile-policy.js';
import { AuthorityRegistry } from './registry.js';

const BATCH = 20;
const LEASE_SECONDS = 120;

/**
 * Follows Chatwoot accounts for channels (ADR 0013). Webhooks bring new email, WhatsApp and
 * Telegram conversations within seconds, but Chatwoot does not retry most of them, so this worker
 * also looks: every few minutes for inboxes made in Chatwoot, and every minute at each channel
 * inbox's most recent conversations, adopting any Hamnivo has not seen. Adoption is idempotent,
 * so a conversation found both ways is taken over once.
 */
@Injectable()
export class ChannelPollService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChannelPollService.name);
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
    private readonly channels: ChannelInboxesService,
    private readonly processor: InboxProcessor,
    private readonly journal: JournalService,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.loop;
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.loop = this.drainOnce()
        .then((count) => this.schedule(count === BATCH ? 0 : 5000))
        .catch((error: unknown) => {
          this.logger.error(`channel poll failed: ${String(error)}`);
          this.schedule(30_000);
        });
    }, delay);
  }

  /** Polls the inbox cursors that are due; returns how many were leased. */
  async drainOnce(): Promise<number> {
    const claims = await claimReconcileInboxCursors(this.db, {
      limit: BATCH,
      leaseSeconds: LEASE_SECONDS,
    });
    for (const claim of claims) {
      let next: number;
      try {
        next = await this.poll(claim);
      } catch (error) {
        this.logger.warn(
          `inbox ${claim.inboxRef} of connection ${claim.connectionId} could not be polled: ${String(error)}`,
        );
        next = Math.min(Math.max(claim.intervalSeconds, 60) * 2, RECONCILE_ERROR_MAX_SECONDS);
      }
      await this.reschedule(claim, next);
    }
    return claims.length;
  }

  /** One cursor: the account's inbox list, or one channel inbox's recent conversations. */
  async poll(claim: ClaimedInboxCursor): Promise<number> {
    if (claim.inboxRef === CHANNEL_DISCOVERY_REF) {
      await this.channels.discover(claim.tenantId, claim.connectionId);
      return CHANNEL_DISCOVERY_SECONDS;
    }
    const inbox = await withTenant(this.db, { tenantId: claim.tenantId }, (tx) =>
      this.channels.activeChannel(tx, claim.connectionId, claim.inboxRef),
    );
    if (!inbox) return CHANNEL_DISCOVERY_SECONDS;
    if (!inbox.brandId || inbox.pausedAt) return CHANNEL_POLL_SECONDS;
    const runtime = await this.registry.get(claim.tenantId, claim.connectionId);
    const recent = await runtime.authority.listInboxConversations(claim.inboxRef);
    const open = recent.filter((state) => state.status !== 'resolved');
    if (open.length === 0) return CHANNEL_POLL_SECONDS;
    const notifications = await withTenant(
      this.db,
      { tenantId: claim.tenantId, actorId: 'reconciler' },
      async (tx) => {
        const known = new Set(
          (
            await tx
              .select({ ref: schema.conversationControls.externalConversationId })
              .from(schema.conversationControls)
              .where(eq(schema.conversationControls.inboxId, inbox.id))
          ).map((row) => String(row.ref)),
        );
        const out: Notification[] = [];
        for (const state of open) {
          if (known.has(state.ref)) continue;
          out.push(
            ...(await this.processor.apply(tx, claim.tenantId, claim.connectionId, {
              type: 'conversation.created',
              accountRef: String(runtime.accountId),
              conversation: state,
            })),
          );
        }
        return out;
      },
    );
    for (const n of notifications) {
      if (n.entries.length > 0) await this.journal.notify(n.tenantId, n.conversationId, n.entries);
      else await this.journal.signalInbox(n.tenantId, n.conversationId);
    }
    return CHANNEL_POLL_SECONDS;
  }

  private async reschedule(claim: ClaimedInboxCursor, seconds: number): Promise<void> {
    await withTenant(this.db, { tenantId: claim.tenantId, actorId: 'reconciler' }, (tx) =>
      tx
        .update(schema.reconcileCursors)
        .set({
          intervalSeconds: seconds,
          nextPollAt: new Date(this.clock().getTime() + seconds * 1000),
        })
        .where(
          and(
            eq(schema.reconcileCursors.connectionId, claim.connectionId),
            eq(schema.reconcileCursors.scope, 'inbox'),
            eq(schema.reconcileCursors.scopeRef, claim.inboxRef),
          ),
        ),
    ).catch((error: unknown) => this.logger.warn(`reschedule failed: ${String(error)}`));
  }
}
