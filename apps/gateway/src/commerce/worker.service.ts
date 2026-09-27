import type { NormalizedEvent } from '@hamnivo/adapters/commerce';
import {
  type ClaimedCommerceEvent,
  type ClaimedCommerceWork,
  claimCommerceEvents,
  claimCommerceWork,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
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
import type { Redis } from 'ioredis';
import { JournalService } from '../authority/journal.service.js';
import { retryDelayMs } from '../outbox/relay.service.js';
import { APP_DB, CLOCK, type Clock, REDIS } from '../tokens.js';
import { CheckoutService } from './checkout.service.js';
import { Effects } from './effects.js';
import { eventFromJson } from './events.js';
import { type Observation, type PaymentSignal, PurchasesService } from './purchases.service.js';
import { RefundsService } from './refunds.service.js';
import { COMMERCE_EVENT_SIGNAL } from './webhooks.service.js';

const BATCH = 50;
const LEASE_SECONDS = 60;
const MAX_EVENT_ATTEMPTS = 10;

/** The event cannot be applied yet (the request that created its object is still recording). */
class RetryLater extends Error {
  override readonly name = 'RetryLater';
}

function operationIdOf(reference: string | null | undefined): string | null {
  if (!reference?.startsWith('op_')) return null;
  try {
    return fromPublicId('operation', reference);
  } catch {
    return null;
  }
}

function checkoutSignal(event: NormalizedEvent): PaymentSignal | null {
  const session = event.checkout;
  if (!session) return null;
  switch (event.type) {
    case 'checkout.completed':
      return session.paymentStatus === 'unpaid'
        ? { target: 'processing', paymentRef: session.paymentRef }
        : {
            target: 'captured',
            paymentRef: session.paymentRef,
            amountMinor: session.amountTotalMinor,
            currency: session.currency,
          };
    case 'checkout.async_succeeded':
      return {
        target: 'captured',
        paymentRef: session.paymentRef,
        amountMinor: session.amountTotalMinor,
        currency: session.currency,
      };
    case 'checkout.async_failed':
      return { target: 'failed', paymentRef: session.paymentRef };
    case 'checkout.expired':
      return { target: 'closed', reason: 'expired' };
    default:
      return null;
  }
}

/**
 * The commerce worker: applies verified provider events in order of arrival (each at most once),
 * and asks providers about operations, payments and refunds still owed an outcome, whoever owns
 * the conversation now (C08, C09, R07). Money in flight is never left untracked.
 */
@Injectable()
export class CommerceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CommerceWorker.name);
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private loop: Promise<unknown> | undefined;
  private subscriber: Redis | undefined;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: JournalService,
    private readonly purchases: PurchasesService,
    private readonly checkout: CheckoutService,
    private readonly refunds: RefundsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.stopped = false;
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('message', () => this.wake());
    await this.subscriber.subscribe(COMMERCE_EVENT_SIGNAL);
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
          this.schedule(count >= BATCH ? 0 : 2000);
        })
        .catch((error: unknown) => {
          this.loop = undefined;
          this.logger.error(`commerce worker failed: ${String(error)}`);
          this.schedule(5000);
        });
    }, delay);
  }

  /** One pass: due events, then due checks. Returns how many items were leased. */
  async drainOnce(): Promise<number> {
    const events = await claimCommerceEvents(this.db, {
      limit: BATCH,
      leaseSeconds: LEASE_SECONDS,
    });
    for (const claim of events) await this.processEvent(claim);
    const work = await claimCommerceWork(this.db, { limit: BATCH, leaseSeconds: LEASE_SECONDS });
    for (const item of work) {
      await this.processWork(item).catch((error: unknown) =>
        this.logger.warn(`commerce ${item.subject} ${item.id} check failed: ${String(error)}`),
      );
    }
    return events.length + work.length;
  }

  async processWork(item: ClaimedCommerceWork): Promise<void> {
    switch (item.subject) {
      case 'operation': {
        const [op] = await withTenant(this.db, { tenantId: item.tenantId }, (tx) =>
          tx
            .select({ kind: schema.operations.kind })
            .from(schema.operations)
            .where(eq(schema.operations.id, item.id)),
        );
        if (op?.kind === 'commerce.checkout.create') {
          await this.checkout.reconcileOperation(item.tenantId, item.id, 'worker');
        } else if (op?.kind === 'commerce.refund.create') {
          await this.refunds.reconcileOperation(item.tenantId, item.id, 'worker');
        }
        return;
      }
      case 'payment':
        await this.checkout.syncPayment(item.tenantId, item.id, 'worker');
        return;
      case 'refund':
        await this.refunds.syncRefund(item.tenantId, item.id, 'worker');
        return;
    }
  }

  async processEvent(claim: ClaimedCommerceEvent): Promise<void> {
    const effects = new Effects();
    const followUps: string[] = [];
    try {
      await withTenant(this.db, { tenantId: claim.tenantId, actorId: 'provider' }, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.commerceEvents)
          .where(eq(schema.commerceEvents.id, claim.id))
          .for('update');
        if (!row || row.processedAt) return;
        const event = eventFromJson(row.payload);
        const obs: Observation = {
          kind: 'webhook',
          source: 'provider_webhook',
          eventId: event.id,
          occurredAt: event.occurredAt,
        };
        const outcome = await this.apply(
          tx,
          row.merchantConnectionId,
          event,
          obs,
          effects,
          followUps,
        );
        await tx
          .update(schema.commerceEvents)
          .set({ processedAt: this.clock(), outcome, lastError: null })
          .where(eq(schema.commerceEvents.id, row.id));
      });
      await effects.flush(this.journal);
      for (const paymentId of followUps) {
        await this.checkout.syncPayment(claim.tenantId, paymentId, 'worker');
      }
    } catch (error) {
      const dead = !(error instanceof RetryLater) && claim.attempts >= MAX_EVENT_ATTEMPTS;
      const message = error instanceof Error ? error.message : String(error);
      await withTenant(this.db, { tenantId: claim.tenantId }, (tx) =>
        tx
          .update(schema.commerceEvents)
          .set({
            lastError: dead ? `dead-letter: ${message}` : message.slice(0, 500),
            availableAt: new Date(this.clock().getTime() + retryDelayMs(claim.attempts)),
            ...(dead ? { processedAt: this.clock() } : {}),
          })
          .where(eq(schema.commerceEvents.id, claim.id)),
      );
      this.logger.warn(`commerce event ${claim.id} failed (attempt ${claim.attempts}): ${message}`);
    }
  }

  private async apply(
    tx: TenantTx,
    merchantConnectionId: string,
    event: NormalizedEvent,
    obs: Observation,
    effects: Effects,
    followUps: string[],
  ): Promise<'applied' | 'ignored' | 'stale'> {
    switch (event.type) {
      case 'checkout.completed':
      case 'checkout.async_succeeded':
      case 'checkout.async_failed':
      case 'checkout.expired': {
        const session = event.checkout;
        const signal = checkoutSignal(event);
        if (!session || !signal) return 'ignored';
        const intentId = await this.intentFor(tx, merchantConnectionId, {
          sessionRef: session.id,
          paymentRef: null,
          reference: session.reference,
        });
        if (!intentId) return 'ignored';
        const rows = await this.purchases.load(tx, intentId);
        if (!rows || rows.merchant.id !== merchantConnectionId) return 'ignored';
        let attached = false;
        if (!rows.payment) {
          // The session is not recorded yet: the request that created it is still finishing.
          if (rows.operation?.state === 'dispatched' || rows.operation?.state === 'pending') {
            throw new RetryLater('checkout session not recorded yet');
          }
          // The checkout request's answer was lost, and this event is the first news of it.
          await this.purchases.attachSession(tx, rows, session, obs, effects);
          attached = true;
        }
        const result = await this.purchases.applySignal(tx, rows, signal, obs, effects);
        return attached ? 'applied' : result;
      }
      case 'payment.succeeded':
      case 'payment.processing':
      case 'payment.requires_action':
      case 'payment.failed': {
        const intentId = await this.intentFor(tx, merchantConnectionId, {
          sessionRef: null,
          paymentRef: event.paymentRef ?? null,
          reference: event.reference ?? null,
        });
        if (!intentId) return 'ignored';
        const rows = await this.purchases.load(tx, intentId);
        if (!rows?.payment || rows.merchant.id !== merchantConnectionId) return 'ignored';
        if (event.type === 'payment.failed') {
          return this.purchases.applySignal(
            tx,
            rows,
            { target: 'declined', paymentRef: event.paymentRef ?? null },
            obs,
            effects,
          );
        }
        if (event.type === 'payment.requires_action') {
          // The bank asks the customer to confirm (C06). The payment page stays open, so the
          // same purchase resumes there; the payment machine ignores this once it has moved on.
          return this.purchases.applySignal(
            tx,
            rows,
            { target: 'requires_action', paymentRef: event.paymentRef ?? null },
            obs,
            effects,
          );
        }
        // A payment event carries no checkout totals: the session is read from the provider.
        if (!['captured', 'failed', 'cancelled'].includes(rows.payment.state)) {
          followUps.push(rows.payment.id);
          return 'applied';
        }
        return 'stale';
      }
      case 'refund.updated': {
        if (!event.refund) return 'ignored';
        const loaded = await this.refunds.loadForEvent(tx, {
          providerRef: event.refund.id,
          operationId: operationIdOf(event.refund.reference),
        });
        if (!loaded || loaded.merchant.id !== merchantConnectionId) return 'ignored';
        return this.refunds.applyEvent(tx, loaded, event.refund, obs, effects);
      }
      default:
        return 'ignored';
    }
  }

  /** The purchase an event is about: by session, by payment, or by Hamnivo's own reference. */
  private async intentFor(
    tx: TenantTx,
    merchantConnectionId: string,
    refs: { sessionRef: string | null; paymentRef: string | null; reference: string | null },
  ): Promise<string | null> {
    if (refs.sessionRef) {
      const [payment] = await tx
        .select({ intent: schema.payments.purchaseIntentId })
        .from(schema.payments)
        .where(
          and(
            eq(schema.payments.merchantConnectionId, merchantConnectionId),
            eq(schema.payments.sessionRef, refs.sessionRef),
          ),
        );
      if (payment) return payment.intent;
    }
    if (refs.paymentRef) {
      const [payment] = await tx
        .select({ intent: schema.payments.purchaseIntentId })
        .from(schema.payments)
        .where(
          and(
            eq(schema.payments.merchantConnectionId, merchantConnectionId),
            eq(schema.payments.paymentRef, refs.paymentRef),
          ),
        );
      if (payment) return payment.intent;
    }
    const operationId = operationIdOf(refs.reference);
    if (!operationId) return null;
    const [op] = await tx
      .select({ kind: schema.operations.kind, resourceId: schema.operations.resourceId })
      .from(schema.operations)
      .where(eq(schema.operations.id, operationId));
    return op?.kind === 'commerce.checkout.create' ? op.resourceId : null;
  }
}
