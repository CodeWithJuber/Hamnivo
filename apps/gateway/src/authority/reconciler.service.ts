import {
  type ClaimedReconcileCursor,
  claimReconcileCursors,
  type Db,
  schema,
  withTenant,
} from '@hamnivo/db';
import type { AuthorityConversationState, AuthorityMessage } from '@hamnivo/domain';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { JournalService } from './journal.service.js';
import { InboxProcessor } from './processor.service.js';
import {
  nextReconcileInterval,
  RECONCILE_ERROR_MAX_SECONDS,
  RECONCILE_FORGET_AFTER_MS,
  RECONCILE_MIN_SECONDS,
  reconcileCeiling,
} from './reconcile-policy.js';
import { AuthorityRegistry } from './registry.js';

const BATCH = 20;
const LEASE_SECONDS = 120;
/** Chatwoot returns at most this many newer messages per request. */
const PAGE = 100;

export interface ReconcileResult {
  messages: number;
  stateChanged: boolean;
}

/**
 * Guarantees that every Chatwoot change reaches Hamnivo, whatever happens to webhooks (Chatwoot
 * retries few of them). For each conversation it follows, the worker reads the conversation's
 * state and the messages after the last one it saw, and applies them through the same processor
 * as webhooks, which is idempotent: a change seen twice is applied once. Polls are frequent right
 * after activity and back off while nothing changes.
 */
@Injectable()
export class ReconcilerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReconcilerService.name);
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
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
        .then((count) => this.schedule(count === BATCH ? 0 : 2000))
        .catch((error: unknown) => {
          this.logger.error(`reconciler failed: ${String(error)}`);
          this.schedule(10_000);
        });
    }, delay);
  }

  /** Polls the conversations that are due; returns how many were leased. */
  async drainOnce(): Promise<number> {
    const claims = await claimReconcileCursors(this.db, {
      limit: BATCH,
      leaseSeconds: LEASE_SECONDS,
    });
    for (const claim of claims) {
      try {
        await this.reconcile(claim);
      } catch (error) {
        this.logger.warn(
          `conversation ${claim.conversationRef} of connection ${claim.connectionId} could not be reconciled: ${String(error)}`,
        );
        await this.reschedule(
          claim,
          Math.min(
            Math.max(claim.intervalSeconds, RECONCILE_MIN_SECONDS) * 2,
            RECONCILE_ERROR_MAX_SECONDS,
          ),
        );
      }
    }
    return claims.length;
  }

  /** Reads one conversation from Chatwoot and applies what Hamnivo has not seen yet. */
  async reconcile(claim: ClaimedReconcileCursor): Promise<ReconcileResult> {
    const runtime = await this.registry.get(claim.tenantId, claim.connectionId);
    const ref = claim.conversationRef;
    const state = await runtime.authority.getState(ref);
    let last = claim.lastExternalId;
    let messages: AuthorityMessage[] = [];
    if (last === null) {
      // No known position (a conversation from before the reconciler): follow it from the newest
      // message on instead of replaying history the journal no longer holds.
      const newest = await runtime.authority.listMessages(ref, { view: 'staff' });
      last = newest.reduce((max, m) => Math.max(max, Number(m.ref)), 0);
    } else {
      const since = last;
      messages = (
        await runtime.authority.listMessages(ref, { view: 'staff', after: String(since) })
      )
        .filter((m) => Number(m.ref) > since)
        .sort((a, b) => Number(a.ref) - Number(b.ref));
    }
    const newest = messages.reduce((max, m) => Math.max(max, Number(m.ref)), last);

    const outcome = await withTenant(
      this.db,
      { tenantId: claim.tenantId, actorId: 'reconciler' },
      async (tx) => {
        const cursor = and(
          eq(schema.reconcileCursors.connectionId, claim.connectionId),
          eq(schema.reconcileCursors.scope, 'conversation'),
          eq(schema.reconcileCursors.scopeRef, ref),
        );
        const [control] = await tx
          .select()
          .from(schema.conversationControls)
          .where(
            and(
              eq(schema.conversationControls.connectionId, claim.connectionId),
              eq(schema.conversationControls.externalConversationId, Number(ref)),
            ),
          );
        if (!control) {
          await tx.delete(schema.reconcileCursors).where(cursor);
          return { notifications: [], result: { messages: 0, stateChanged: false } };
        }
        const stateChanged = isNewer(state, control.authorityUpdatedAt);
        const notifications = [
          ...(await this.processor.apply(tx, claim.tenantId, claim.connectionId, {
            type: 'conversation.updated',
            accountRef: String(runtime.accountId),
            conversation: state,
          })),
        ];
        for (const message of messages) {
          notifications.push(
            ...(await this.processor.apply(tx, claim.tenantId, claim.connectionId, {
              type: 'message.created',
              accountRef: String(runtime.accountId),
              message,
            })),
          );
        }
        const now = this.clock();
        const idle = now.getTime() - control.lastActivityAt.getTime() > RECONCILE_FORGET_AFTER_MS;
        if (state.status === 'resolved' && idle && messages.length === 0) {
          await tx.delete(schema.reconcileCursors).where(cursor);
        } else {
          const interval =
            messages.length >= PAGE
              ? 0
              : nextReconcileInterval(
                  claim.intervalSeconds,
                  // Only news counts: re-reading what was already applied keeps backing off.
                  notifications.some((n) => n.entries.length > 0),
                  reconcileCeiling(state.status, control.ownerMode),
                );
          await tx
            .update(schema.reconcileCursors)
            .set({
              lastExternalId: newest,
              lastAuthorityUpdatedAt: state.version,
              intervalSeconds: Math.max(interval, RECONCILE_MIN_SECONDS),
              nextPollAt: new Date(now.getTime() + interval * 1000),
            })
            .where(cursor);
        }
        return { notifications, result: { messages: messages.length, stateChanged } };
      },
    );
    for (const n of outcome.notifications) {
      if (n.entries.length > 0) await this.journal.notify(n.tenantId, n.conversationId, n.entries);
      else await this.journal.signalInbox(n.tenantId, n.conversationId);
    }
    return outcome.result;
  }

  private async reschedule(claim: ClaimedReconcileCursor, seconds: number): Promise<void> {
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
            eq(schema.reconcileCursors.scope, 'conversation'),
            eq(schema.reconcileCursors.scopeRef, claim.conversationRef),
          ),
        ),
    ).catch((error: unknown) => this.logger.warn(`reschedule failed: ${String(error)}`));
  }
}

function isNewer(state: AuthorityConversationState, known: number | null): boolean {
  return known === null || state.version > known;
}
