import { randomBytes } from 'node:crypto';
import type { CheckoutSession } from '@hamnivo/adapters/commerce';
import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import {
  type CartState,
  cartMachine,
  nextState,
  type OrderState,
  orderMachine,
  type PaymentState,
  type PurchaseIntentState,
  paymentMachine,
  purchaseIntentMachine,
  type QuoteState,
  quoteMachine,
} from '@hamnivo/domain/commerce';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { JournalService } from '../authority/journal.service.js';
import type { ControlRow } from '../authority/ownership.service.js';
import { CLOCK, type Clock } from '../tokens.js';
import { CommerceCardsService } from './card-publisher.service.js';
import { receiptPublication } from './cards.js';
import { backoffMs, errorCode, errorEvidence, minor, moneyText } from './common.js';
import { type ActionOutcome, type Effects, journalAction } from './effects.js';
import { openException, resolveExceptionsFor } from './exceptions.js';
import { addReceipt, moveOperation, type OperationRow } from './ledger.js';
import type { MerchantRow } from './providers.service.js';
import type { CartRow, IntentRow, OrderLine, OrderRow, PaymentRow, QuoteRow } from './views.js';

/** How an observation reached Hamnivo; it becomes the receipt's kind and source. */
export interface Observation {
  kind: 'webhook' | 'reconcile' | 'response';
  source: 'provider_webhook' | 'provider_api' | 'reconciler';
  eventId?: string | null;
  occurredAt: Date;
}

/** What the provider says about the payment, reduced to what changes Hamnivo's records. */
export type PaymentSignal =
  | {
      target: 'captured';
      paymentRef: string | null;
      amountMinor: bigint | null;
      currency: string | null;
    }
  | { target: 'processing' | 'requires_action'; paymentRef: string | null }
  /** One attempt was declined on the still-open payment page: recorded, nothing else changes. */
  | { target: 'declined'; paymentRef: string | null }
  | { target: 'failed'; paymentRef: string | null }
  | { target: 'closed'; reason: 'expired' | 'cancelled' }
  | { target: 'open' };

export function signalFromSession(session: CheckoutSession): PaymentSignal {
  if (session.status === 'complete') {
    return session.paymentStatus === 'unpaid'
      ? { target: 'processing', paymentRef: session.paymentRef }
      : {
          target: 'captured',
          paymentRef: session.paymentRef,
          amountMinor: session.amountTotalMinor,
          currency: session.currency,
        };
  }
  if (session.status === 'expired') return { target: 'closed', reason: 'expired' };
  return { target: 'open' };
}

export interface PurchaseRows {
  intent: IntentRow;
  quote: QuoteRow;
  cart: CartRow;
  merchant: MerchantRow;
  control: ControlRow;
  payment: PaymentRow | null;
  order: OrderRow | null;
  operation: OperationRow | null;
}

const ACTION_OUTCOME: Record<PurchaseIntentState, ActionOutcome> = {
  draft: 'requested',
  quoted: 'requested',
  awaiting_approval: 'awaiting_approval',
  approved: 'approved',
  executing: 'executing',
  unknown: 'unknown',
  needs_human: 'unknown',
  completed: 'completed',
  failed: 'failed',
  denied: 'failed',
  expired: 'cancelled',
  cancelled: 'cancelled',
};

/** Payment checks while no final answer is known; after this many, a person looks. */
export const PAYMENT_SYNC_LIMIT = 12;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The purchase lifecycle (C05, C06, C09, C10): a quote approved into a checkout session, then
 * the provider's answers applied to payment, order, cart and quote through their state machines.
 * Every change is driven by an observation from the provider (API response, webhook or
 * reconciliation) and leaves a receipt; "paid" exists only with one (X10).
 */
@Injectable()
export class PurchasesService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly cards: CommerceCardsService,
    private readonly journal: JournalService,
  ) {}

  /** Loads and locks a purchase with everything that moves with it. */
  async load(tx: TenantTx, intentId: string): Promise<PurchaseRows | null> {
    const [intent] = await tx
      .select()
      .from(schema.purchaseIntents)
      .where(eq(schema.purchaseIntents.id, intentId))
      .for('update');
    if (!intent) return null;
    const [payment] = await tx
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.purchaseIntentId, intent.id))
      .for('update');
    const [order] = await tx
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.purchaseIntentId, intent.id))
      .for('update');
    const [cart] = await tx
      .select()
      .from(schema.carts)
      .where(eq(schema.carts.id, intent.cartId))
      .for('update');
    const [quote] = await tx
      .select()
      .from(schema.quotes)
      .where(eq(schema.quotes.id, intent.quoteId))
      .for('update');
    const [merchant] = await tx
      .select()
      .from(schema.merchantConnections)
      .where(eq(schema.merchantConnections.id, intent.merchantConnectionId));
    const [control] = await tx
      .select()
      .from(schema.conversationControls)
      .where(eq(schema.conversationControls.id, intent.conversationId));
    const [operation] = intent.checkoutOperationId
      ? await tx
          .select()
          .from(schema.operations)
          .where(eq(schema.operations.id, intent.checkoutOperationId))
          .for('update')
      : [];
    if (!cart || !quote || !merchant || !control) return null;
    return {
      intent,
      quote,
      cart,
      merchant,
      control,
      payment: payment ?? null,
      order: order ?? null,
      operation: operation ?? null,
    };
  }

  private async setIntent(
    tx: TenantTx,
    rows: PurchaseRows,
    event: (typeof purchaseIntentMachine.events)[number],
    set: Partial<typeof schema.purchaseIntents.$inferInsert> = {},
  ): Promise<boolean> {
    const to = nextState(purchaseIntentMachine, rows.intent.state as PurchaseIntentState, event);
    if (to === null) return false;
    const [row] = await tx
      .update(schema.purchaseIntents)
      .set({ ...set, state: to, updatedAt: this.clock() })
      .where(eq(schema.purchaseIntents.id, rows.intent.id))
      .returning();
    if (row) rows.intent = row;
    return true;
  }

  private async setQuote(tx: TenantTx, rows: PurchaseRows, event: 'consume' | 'cancel') {
    const to = nextState(quoteMachine, rows.quote.status as QuoteState, event);
    if (to === null) return;
    const [row] = await tx
      .update(schema.quotes)
      .set({ status: to, updatedAt: this.clock() })
      .where(eq(schema.quotes.id, rows.quote.id))
      .returning();
    if (row) rows.quote = row;
  }

  private async setCart(tx: TenantTx, rows: PurchaseRows, event: 'complete' | 'release') {
    const to = nextState(cartMachine, rows.cart.status as CartState, event);
    if (to === null) return;
    const [row] = await tx
      .update(schema.carts)
      .set({ status: to, updatedAt: this.clock() })
      .where(eq(schema.carts.id, rows.cart.id))
      .returning();
    if (row) rows.cart = row;
  }

  private async setOrder(
    tx: TenantTx,
    rows: PurchaseRows,
    event: 'confirm' | 'cancel',
    set: Partial<typeof schema.orders.$inferInsert> = {},
  ): Promise<boolean> {
    if (!rows.order) return false;
    const to = nextState(orderMachine, rows.order.state as OrderState, event);
    if (to === null) return false;
    const [row] = await tx
      .update(schema.orders)
      .set({ ...set, state: to, updatedAt: this.clock() })
      .where(eq(schema.orders.id, rows.order.id))
      .returning();
    if (row) rows.order = row;
    return true;
  }

  private async action(tx: TenantTx, rows: PurchaseRows, effects: Effects, summary: string) {
    await journalAction(this.journal, tx, effects, {
      tenantId: rows.intent.tenantId,
      conversationId: rows.intent.conversationId,
      actionId: toPublicId('purchase', rows.intent.id),
      outcome: ACTION_OUTCOME[rows.intent.state as PurchaseIntentState],
      summary,
    });
  }

  private async newReference(tx: TenantTx): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = randomBytes(6);
      const reference = `HV-${[...bytes].map((b) => ALPHABET[b % 32]).join('')}`;
      const [taken] = await tx
        .select({ id: schema.orders.id })
        .from(schema.orders)
        .where(eq(schema.orders.reference, reference));
      if (!taken) return reference;
    }
    throw new Error('could not allocate an order reference');
  }

  /**
   * The provider created (or reconciliation found) the checkout session: the payment page is
   * ready. Creates the payment projection and the order, then applies whatever the session
   * already shows (it may have been paid while Hamnivo did not know about it).
   */
  async attachSession(
    tx: TenantTx,
    rows: PurchaseRows,
    session: CheckoutSession,
    obs: Observation,
    effects: Effects,
  ): Promise<void> {
    const now = this.clock();
    if (rows.operation) {
      const moved = await moveOperation(
        tx,
        rows.operation,
        'succeed',
        { providerRef: session.id, lastErrorCode: null },
        now,
      );
      if (moved) {
        rows.operation = moved;
        await addReceipt(tx, moved, {
          kind: obs.kind,
          outcome: 'succeeded',
          source: obs.source,
          providerRef: session.id,
          providerEventId: obs.eventId ?? null,
          evidence: {
            subject: 'checkout_session',
            status: session.status,
            amountMinor: session.amountTotalMinor === null ? null : minor(session.amountTotalMinor),
            currency: session.currency,
          },
          observedAt: obs.occurredAt,
        });
        await resolveExceptionsFor(tx, moved.id, now);
      }
    }
    const checkout = {
      checkoutSessionRef: session.id,
      checkoutUrl: session.url,
      checkoutExpiresAt: session.expiresAt,
    };
    const from = rows.intent.state as PurchaseIntentState;
    if (from === 'approved') await this.setIntent(tx, rows, 'dispatch', checkout);
    else if (from === 'unknown' || from === 'needs_human') {
      await this.setIntent(tx, rows, 'reconciled', checkout);
    }
    const quoteDoc = rows.quote.document as { lines: OrderLine[] };
    if (!rows.payment) {
      const [payment] = await tx
        .insert(schema.payments)
        .values({
          tenantId: rows.intent.tenantId,
          purchaseIntentId: rows.intent.id,
          merchantConnectionId: rows.merchant.id,
          provider: rows.merchant.provider,
          sessionRef: session.id,
          paymentRef: session.paymentRef,
          state: 'not_started',
          amountMinor: rows.quote.totalMinor,
          currency: rows.quote.currency,
          lastSyncedAt: now,
          // Webhooks are the fast path; this check catches one that never arrives.
          nextSyncAt: new Date(now.getTime() + backoffMs(1) * 4),
        })
        .onConflictDoNothing()
        .returning();
      rows.payment =
        payment ??
        (
          await tx
            .select()
            .from(schema.payments)
            .where(eq(schema.payments.purchaseIntentId, rows.intent.id))
            .for('update')
        )[0] ??
        null;
    }
    if (!rows.order) {
      const [order] = await tx
        .insert(schema.orders)
        .values({
          tenantId: rows.intent.tenantId,
          reference: await this.newReference(tx),
          conversationId: rows.intent.conversationId,
          principalId: rows.intent.principalId,
          merchantConnectionId: rows.merchant.id,
          brandId: rows.merchant.brandId,
          purchaseIntentId: rows.intent.id,
          quoteId: rows.quote.id,
          state: 'submitted',
          paymentState: 'not_started',
          currency: rows.quote.currency,
          totalMinor: rows.quote.totalMinor,
          lines: quoteDoc.lines as unknown as Record<string, unknown>[],
          placedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      rows.order =
        order ??
        (
          await tx
            .select()
            .from(schema.orders)
            .where(eq(schema.orders.purchaseIntentId, rows.intent.id))
            .for('update')
        )[0] ??
        null;
    }
    const signal = signalFromSession(session);
    if (signal.target === 'open') {
      await this.action(tx, rows, effects, 'The secure payment page is ready.');
    } else {
      await this.applySignal(tx, rows, signal, obs, effects);
    }
  }

  /** The provider refused to open a payment page: nothing can have been charged. */
  async failDispatch(
    tx: TenantTx,
    rows: PurchaseRows,
    error: unknown,
    obs: Observation,
    effects: Effects,
  ): Promise<void> {
    const now = this.clock();
    if (rows.operation) {
      const moved = await moveOperation(
        tx,
        rows.operation,
        'fail',
        { lastErrorCode: errorCode(error) },
        now,
      );
      if (moved) {
        rows.operation = moved;
        await addReceipt(tx, moved, {
          kind: obs.kind,
          outcome: 'failed',
          source: obs.source,
          evidence: { subject: 'checkout_session', ...errorEvidence(error) },
          observedAt: obs.occurredAt,
        });
        if (errorCode(error) === 'amount_mismatch') {
          await openException(tx, {
            tenantId: rows.intent.tenantId,
            kind: 'amount_mismatch',
            subjectType: 'operation',
            subjectId: moved.id,
            operationId: moved.id,
            sourceState: 'session_total_differs',
            nextSafeAction: 'contact_provider',
            evidence: {
              quoteTotalMinor: minor(rows.quote.totalMinor),
              currency: rows.quote.currency,
            },
            now,
          });
        }
      }
    }
    await this.setIntent(tx, rows, 'dispatch_failed');
    await this.setQuote(tx, rows, 'cancel');
    await this.setCart(tx, rows, 'release');
    await this.action(
      tx,
      rows,
      effects,
      'The payment page could not be opened. Nothing was charged. Your cart is saved.',
    );
  }

  /** A checkout request whose answer was lost: resolved from the provider, never resent blindly. */
  async loseTrack(
    tx: TenantTx,
    rows: PurchaseRows,
    error: unknown,
    obs: Observation,
    effects: Effects,
  ): Promise<void> {
    const now = this.clock();
    if (rows.operation) {
      const moved = await moveOperation(
        tx,
        rows.operation,
        'lose_track',
        { lastErrorCode: errorCode(error), nextReconcileAt: new Date(now.getTime() + 15_000) },
        now,
      );
      if (moved) rows.operation = moved;
      await addReceipt(tx, rows.operation, {
        kind: obs.kind,
        outcome: 'unknown',
        source: obs.source,
        evidence: { subject: 'checkout_session', ...errorEvidence(error) },
        observedAt: obs.occurredAt,
      });
    }
    if (await this.setIntent(tx, rows, 'dispatch_unknown')) {
      await this.action(tx, rows, effects, 'Checking with the payment provider.');
    }
  }

  /**
   * Applies what the provider says about the payment. Late or repeated observations that the
   * machines refuse change nothing; a payment captured after Hamnivo stopped expecting it opens
   * an exception instead of being ignored.
   */
  async applySignal(
    tx: TenantTx,
    rows: PurchaseRows,
    signal: PaymentSignal,
    obs: Observation,
    effects: Effects,
  ): Promise<'applied' | 'stale'> {
    const now = this.clock();
    const payment = rows.payment;
    if (!payment) return 'stale';
    const receiptFor = async (
      outcome: 'succeeded' | 'failed' | 'pending',
      evidence: Record<string, unknown>,
      providerRef: string | null,
    ) => {
      if (!rows.operation) return;
      await addReceipt(tx, rows.operation, {
        kind: obs.kind,
        outcome,
        source: obs.source,
        providerRef,
        providerEventId: obs.eventId ?? null,
        evidence,
        observedAt: obs.occurredAt,
      });
    };
    const movePayment = async (
      event: (typeof paymentMachine.events)[number],
      set: Partial<typeof schema.payments.$inferInsert>,
    ): Promise<boolean> => {
      const to = nextState(paymentMachine, payment.state as PaymentState, event);
      if (to === null) return false;
      const [row] = await tx
        .update(schema.payments)
        .set({ ...set, state: to, lastEventAt: obs.occurredAt, lastSyncedAt: now, updatedAt: now })
        .where(eq(schema.payments.id, payment.id))
        .returning();
      if (row) rows.payment = row;
      if (rows.order) {
        const [order] = await tx
          .update(schema.orders)
          .set({ paymentState: to, updatedAt: now })
          .where(eq(schema.orders.id, rows.order.id))
          .returning();
        if (order) rows.order = order;
      }
      return true;
    };
    const tenantId = rows.intent.tenantId;
    const reference = rows.order?.reference ?? null;

    switch (signal.target) {
      case 'open':
        await tx
          .update(schema.payments)
          .set({ lastSyncedAt: now, updatedAt: now })
          .where(eq(schema.payments.id, payment.id));
        return 'stale';
      case 'declined':
        await receiptFor(
          'failed',
          { subject: 'payment_attempt', status: 'declined' },
          signal.paymentRef,
        );
        return 'applied';
      case 'processing':
      case 'requires_action': {
        const moved = await movePayment(
          signal.target === 'processing' ? 'process' : 'require_action',
          {
            paymentRef: signal.paymentRef ?? payment.paymentRef,
          },
        );
        if (!moved) return 'stale';
        await receiptFor(
          'pending',
          { subject: 'payment', status: signal.target },
          signal.paymentRef,
        );
        await this.action(
          tx,
          rows,
          effects,
          signal.target === 'processing'
            ? 'The payment is being confirmed by the bank.'
            : 'The payment needs you to confirm it with your bank.',
        );
        return 'applied';
      }
      case 'captured': {
        const amount = signal.amountMinor ?? payment.amountMinor;
        const moved = await movePayment('capture', {
          paymentRef: signal.paymentRef ?? payment.paymentRef,
          capturedMinor: amount,
          capturedAt: obs.occurredAt,
          nextSyncAt: null,
        });
        if (!moved) {
          if (payment.state !== 'captured') {
            // Captured after Hamnivo closed the purchase (for example, paid in the moment the
            // page expired): money moved, so a person reviews the order.
            await openException(tx, {
              tenantId,
              kind: 'order_update_pending',
              subjectType: 'payment',
              subjectId: payment.id,
              operationId: rows.operation?.id ?? null,
              orderId: rows.order?.id ?? null,
              sourceState: 'captured',
              nextSafeAction: 'review_order',
              evidence: {
                hamnivoState: payment.state,
                amountMinor: minor(amount),
                currency: signal.currency ?? payment.currency,
                paymentRef: signal.paymentRef,
              },
              now,
            });
          }
          return 'stale';
        }
        await receiptFor(
          'succeeded',
          {
            subject: 'payment',
            status: 'captured',
            amountMinor: minor(amount),
            currency: signal.currency ?? payment.currency,
          },
          signal.paymentRef,
        );
        if (
          amount !== payment.amountMinor ||
          (signal.currency !== null && signal.currency !== payment.currency)
        ) {
          await openException(tx, {
            tenantId,
            kind: 'amount_mismatch',
            subjectType: 'payment',
            subjectId: payment.id,
            operationId: rows.operation?.id ?? null,
            orderId: rows.order?.id ?? null,
            sourceState: 'captured',
            nextSafeAction: 'review_order',
            evidence: {
              expectedMinor: minor(payment.amountMinor),
              capturedMinor: minor(amount),
              currency: signal.currency ?? payment.currency,
            },
            now,
          });
        }
        const completed = await this.setIntent(tx, rows, 'payment_succeeded');
        await this.setQuote(tx, rows, 'consume');
        await this.setCart(tx, rows, 'complete');
        const confirmed = await this.setOrder(tx, rows, 'confirm', { confirmedAt: now });
        if (!completed || !confirmed) {
          await openException(tx, {
            tenantId,
            kind: 'order_update_pending',
            subjectType: 'payment',
            subjectId: payment.id,
            operationId: rows.operation?.id ?? null,
            orderId: rows.order?.id ?? null,
            sourceState: 'captured',
            nextSafeAction: 'review_order',
            evidence: { intentState: rows.intent.state, orderState: rows.order?.state ?? null },
            now,
          });
        }
        await resolveExceptionsFor(tx, payment.id, now, ['payment_unknown', 'reconcile_exhausted']);
        if (rows.operation) {
          await resolveExceptionsFor(tx, rows.operation.id, now, [
            'payment_unknown',
            'reconcile_exhausted',
          ]);
        }
        await appendAudit(tx, {
          actorType: 'system',
          actorId: 'commerce',
          action: 'commerce.payment.captured',
          targetType: 'order',
          targetId: rows.order ? toPublicId('order', rows.order.id) : null,
          outcome: 'success',
          occurredAt: now,
          data: {
            purchase: toPublicId('purchase', rows.intent.id),
            amountMinor: minor(amount),
            currency: payment.currency,
            source: obs.source,
          },
        });
        const summary =
          `Payment received: ${moneyText(amount, payment.currency)}.` +
          (reference ? ` Order ${reference} is confirmed.` : '');
        await this.cards.enqueue(
          tx,
          tenantId,
          rows.control,
          receiptPublication(
            {
              kind: 'receipt',
              version: 1,
              receiptId: toPublicId('receipt', payment.id),
              actionId: toPublicId('purchase', rows.intent.id),
              outcome: 'completed',
              summary,
              reference,
              occurredAt: obs.occurredAt.toISOString(),
            },
            rows.merchant.displayName,
          ),
          `payment:${payment.id}:captured`,
        );
        await this.action(tx, rows, effects, summary);
        return 'applied';
      }
      case 'failed': {
        const moved = await movePayment('fail', { nextSyncAt: null });
        if (!moved) return 'stale';
        await receiptFor('failed', { subject: 'payment', status: 'failed' }, signal.paymentRef);
        await this.setIntent(tx, rows, 'payment_failed');
        await this.setQuote(tx, rows, 'cancel');
        await this.setCart(tx, rows, 'release');
        await this.setOrder(tx, rows, 'cancel');
        await this.closedCard(
          tx,
          rows,
          'failed',
          'The payment did not go through. Nothing was charged. Your cart is saved.',
        );
        await this.action(tx, rows, effects, 'The payment did not go through.');
        return 'applied';
      }
      case 'closed': {
        const moved = await movePayment('cancel', { nextSyncAt: null });
        if (!moved && payment.state !== 'cancelled') return 'stale';
        if (moved) {
          await receiptFor('failed', { subject: 'payment', status: signal.reason }, null);
        }
        const changed = await this.setIntent(
          tx,
          rows,
          signal.reason === 'cancelled' ? 'cancel' : 'expire',
        );
        if (!changed) return moved ? 'applied' : 'stale';
        await this.setQuote(tx, rows, 'cancel');
        await this.setCart(tx, rows, 'release');
        await this.setOrder(tx, rows, 'cancel');
        const text =
          signal.reason === 'cancelled'
            ? 'You cancelled the payment. Nothing was charged. Your cart is saved.'
            : 'The payment page closed before payment. Nothing was charged. Your cart is saved.';
        await this.closedCard(tx, rows, 'cancelled', text);
        await this.action(tx, rows, effects, text);
        return 'applied';
      }
    }
  }

  private async closedCard(
    tx: TenantTx,
    rows: PurchaseRows,
    outcome: 'failed' | 'cancelled',
    summary: string,
  ) {
    await this.cards.enqueue(
      tx,
      rows.intent.tenantId,
      rows.control,
      receiptPublication(
        {
          kind: 'receipt',
          version: 1,
          receiptId: toPublicId('receipt', rows.intent.id),
          actionId: toPublicId('purchase', rows.intent.id),
          outcome,
          summary,
          reference: rows.order?.reference ?? null,
          occurredAt: this.clock().toISOString(),
        },
        rows.merchant.displayName,
      ),
      `purchase:${rows.intent.id}:${outcome}`,
    );
  }

  /** Next check of a payment still owed an outcome, or an exception after too many. */
  async scheduleSync(tx: TenantTx, rows: PurchaseRows, sourceState: string): Promise<void> {
    const payment = rows.payment;
    if (!payment) return;
    const now = this.clock();
    const final = ['captured', 'failed', 'cancelled'].includes(payment.state);
    if (final) {
      await tx
        .update(schema.payments)
        .set({ nextSyncAt: null, updatedAt: now })
        .where(eq(schema.payments.id, payment.id));
      return;
    }
    const attempts = payment.syncAttempts + 1;
    if (attempts >= PAYMENT_SYNC_LIMIT) {
      await openException(tx, {
        tenantId: payment.tenantId,
        kind: 'reconcile_exhausted',
        subjectType: 'payment',
        subjectId: payment.id,
        operationId: rows.operation?.id ?? null,
        orderId: rows.order?.id ?? null,
        sourceState,
        nextSafeAction: 'check_status',
        evidence: { sessionRef: payment.sessionRef, attempts },
        now,
      });
    }
    // Back off between checks, but look once right after the payment page closes; after the
    // limit, hourly until the provider answers or a person resolves the exception.
    let next = now.getTime() + (attempts >= PAYMENT_SYNC_LIMIT ? 60 * 60_000 : backoffMs(attempts));
    const pageClosedAt = (rows.intent.checkoutExpiresAt?.getTime() ?? 0) + 60_000;
    if (pageClosedAt > now.getTime()) next = Math.min(next, pageClosedAt);
    await tx
      .update(schema.payments)
      .set({
        syncAttempts: attempts,
        nextSyncAt: new Date(next),
        lastSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.payments.id, payment.id));
  }
}
