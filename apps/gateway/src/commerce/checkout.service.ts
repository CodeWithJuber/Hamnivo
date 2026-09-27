import type {
  CheckoutRequest,
  CheckoutSession,
  CommerceProvider,
  ProviderQuote,
} from '@hamnivo/adapters/commerce';
import type { ApproveQuoteRequest, PurchaseIntentView, QuoteView } from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  newId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import {
  type ApprovalRefusal,
  checkQuoteApproval,
  nextState,
  type QuoteDocument,
  type QuoteState,
  quoteMachine,
} from '@hamnivo/domain/commerce';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { JournalService } from '../authority/journal.service.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import type { WidgetClaims } from '../widget/tokens.service.js';
import { customerConversation } from './access.js';
import { backoffMs, canonicalDigest, errorCode, errorEvidence, outcomeUnknown } from './common.js';
import { Effects, journalAction } from './effects.js';
import { openException } from './exceptions.js';
import { addReceipt, moveOperation, type OperationRow, openOperation } from './ledger.js';
import { CommerceProviders } from './providers.service.js';
import {
  type Observation,
  type PurchaseRows,
  PurchasesService,
  signalFromSession,
} from './purchases.service.js';
import { intentView, quoteView } from './views.js';

type ApproveInput = z.output<typeof ApproveQuoteRequest>;

/** Stored with the operation so a retry sends exactly the same request (idempotency keys). */
interface StoredCheckoutRequest {
  successUrl: string;
  cancelUrl: string;
  expiresAt: string;
  locale: string | null;
  metadata: Record<string, string>;
}

/** Customer "Check status" at most this often; the provider is asked no more than that. */
const REFRESH_MIN_MS = 3_000;
/** Reconciliation passes before a person is asked to look (it keeps checking, slower). */
const RECONCILE_LIMIT = 10;
/** Stripe requires a checkout session to stay open at least 30 minutes after it is created. */
const MIN_SESSION_MS = 31 * 60_000;

const REFUSALS: Record<ApprovalRefusal, () => AppError> = {
  expired: () => new AppError('QUOTE_EXPIRED'),
  cart_changed: () =>
    new AppError('APPROVAL_MISMATCH', {
      detail: 'Your cart changed after this price was shown. Please review the new total.',
    }),
  hash_mismatch: () =>
    new AppError('APPROVAL_MISMATCH', {
      detail: 'The order summary changed. Please review it again.',
    }),
  not_ready: () =>
    new AppError('APPROVAL_MISMATCH', {
      detail: 'This order summary can no longer be approved. Please review the cart again.',
    }),
  wrong_customer: () => new AppError('NOT_FOUND', { detail: 'Quote not found.' }),
  staff_only: () => new AppError('SCOPE_DENIED'),
  customer_only: () => new AppError('SCOPE_DENIED'),
  merchant_inactive: () =>
    new AppError('FEATURE_DISABLED', { detail: 'This shop is not taking orders right now.' }),
};

export function providerQuoteOf(doc: QuoteDocument, observedAt: Date): ProviderQuote {
  return {
    currency: doc.currency,
    lines: doc.lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      name: l.name,
      quantity: l.quantity,
      unitPriceMinor: BigInt(l.unitPriceMinor),
      totalMinor: BigInt(l.totalMinor),
    })),
    subtotalMinor: BigInt(doc.subtotalMinor),
    discountMinor: BigInt(doc.discountMinor),
    taxMinor: doc.taxMinor === null ? null : BigInt(doc.taxMinor),
    taxMode: doc.taxMode,
    shippingMinor: doc.shippingMinor === null ? null : BigInt(doc.shippingMinor),
    totalMinor: BigInt(doc.totalMinor),
    recurring: null,
    validUntil: null,
    observedAt,
  };
}

/**
 * Approval and hosted checkout (C04–C06, C09, R07). The customer approves exactly one quote
 * (hash, cart revision, identity, before expiry). The checkout request is recorded in the
 * operation ledger before it is sent and is never repeated blindly: a lost answer makes the
 * operation `unknown`, and reconciliation finds the session by reference, or resends the same
 * request under the same idempotency key while the provider still honours it.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly providers: CommerceProviders,
    private readonly purchases: PurchasesService,
    private readonly journal: JournalService,
  ) {}

  private tenantTx<T>(tenantId: string, actorId: string, work: (tx: TenantTx) => Promise<T>) {
    return withTenant(this.db, { tenantId, actorId }, work);
  }

  private customerTx<T>(claims: WidgetClaims, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.tenantTx(claims.tenantId, toPublicId('customer', claims.principalId), work);
  }

  /** The customer's purchase, loaded and locked, or NOT_FOUND. */
  private async customerPurchase(
    tx: TenantTx,
    claims: WidgetClaims,
    conversationId: string,
    where: { quoteId?: string; intentId?: string },
  ): Promise<PurchaseRows> {
    const control = await customerConversation(tx, claims, conversationId);
    const [found] = await tx
      .select({ id: schema.purchaseIntents.id })
      .from(schema.purchaseIntents)
      .where(
        and(
          eq(schema.purchaseIntents.conversationId, control.id),
          eq(schema.purchaseIntents.principalId, claims.principalId),
          where.quoteId
            ? eq(schema.purchaseIntents.quoteId, where.quoteId)
            : eq(schema.purchaseIntents.id, where.intentId ?? ''),
        ),
      );
    const rows = found ? await this.purchases.load(tx, found.id) : null;
    if (!rows) throw new AppError('NOT_FOUND', { detail: 'Purchase not found.' });
    return rows;
  }

  private view(rows: PurchaseRows): PurchaseIntentView {
    return intentView(rows.intent, rows.payment, rows.order, this.clock());
  }

  async getQuote(
    claims: WidgetClaims,
    conversationId: string,
    quoteId: string,
  ): Promise<QuoteView> {
    return this.customerTx(claims, async (tx) => {
      const rows = await this.customerPurchase(tx, claims, conversationId, {
        quoteId: fromPublicId('quote', quoteId),
      });
      return quoteView({ ...rows, now: this.clock() });
    });
  }

  async getPurchase(
    claims: WidgetClaims,
    conversationId: string,
    purchaseId: string,
  ): Promise<PurchaseIntentView> {
    return this.customerTx(claims, async (tx) =>
      this.view(
        await this.customerPurchase(tx, claims, conversationId, {
          intentId: fromPublicId('purchase', purchaseId),
        }),
      ),
    );
  }

  // ── Approval (C04) and checkout (C05) ──────────────────────────────────────────────────────

  async approve(
    claims: WidgetClaims,
    conversationId: string,
    quotePublicId: string,
    input: ApproveInput,
    context: { locale: string | null; origin: string | null },
  ): Promise<PurchaseIntentView> {
    const quoteId = fromPublicId('quote', quotePublicId);
    const effects = new Effects();
    const step = await this.customerTx(claims, async (tx) => {
      const rows = await this.customerPurchase(tx, claims, conversationId, { quoteId });
      // A repeated tap (same request id) returns the same purchase and starts nothing new.
      if (rows.intent.approvalNonce === input.clientRequestId)
        return { kind: 'replay' as const, rows };
      const [reused] = await tx
        .select({ id: schema.purchaseIntents.id })
        .from(schema.purchaseIntents)
        .where(eq(schema.purchaseIntents.approvalNonce, input.clientRequestId));
      if (reused) throw new AppError('IDEMPOTENCY_CONFLICT');
      const now = this.clock();
      const check = checkQuoteApproval(
        {
          state: rows.quote.status as QuoteState,
          hash: rows.quote.hash.toString('hex'),
          cartRevision: rows.quote.cartRevision,
          currentCartRevision: rows.cart.revision,
          principalId: rows.quote.principalId,
          expiresAt: rows.quote.expiresAt,
          approver: rows.quote.approver,
          merchantActive: rows.merchant.status === 'active',
        },
        {
          kind: 'customer',
          principalId: claims.principalId,
          quoteHash: input.quoteHash,
          cartRevision: input.cartRevision,
          now,
        },
      );
      if (!check.ok) {
        if (check.reason === 'expired') await this.expireQuote(tx, rows, effects);
        return { kind: 'refused' as const, reason: check.reason };
      }
      await this.setQuote(tx, rows, 'approve');
      const pur = toPublicId('purchase', rows.intent.id);
      const [approved] = await tx
        .update(schema.purchaseIntents)
        .set({
          state: 'approved',
          approvedHash: rows.quote.hash,
          approvedCartRevision: rows.quote.cartRevision,
          approvedAt: now,
          approvalNonce: input.clientRequestId,
          approvalEvidence: {
            widget: claims.widgetId,
            session: toPublicId('session', claims.sessionId),
            verifiedCustomer: claims.verified,
            locale: context.locale,
            origin: context.origin,
          },
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.purchaseIntents.id, rows.intent.id),
            eq(schema.purchaseIntents.state, 'awaiting_approval'),
          ),
        )
        .returning();
      if (!approved) return { kind: 'refused' as const, reason: 'not_ready' as const };
      rows.intent = approved;
      await tx
        .update(schema.carts)
        .set({ status: 'locked', updatedAt: now })
        .where(and(eq(schema.carts.id, rows.cart.id), eq(schema.carts.status, 'open')));
      const doc = rows.quote.document as unknown as QuoteDocument;
      const widgetOrigin = this.config.PUBLIC_WIDGET_ORIGIN.replace(/\/$/, '');
      const back = (result: string) =>
        `${widgetOrigin}/checkout-return.html?purchase=${pur}&result=${result}`;
      const stored: StoredCheckoutRequest = {
        successUrl: back('success'),
        cancelUrl: back('cancel'),
        expiresAt: new Date(
          now.getTime() + this.config.COMMERCE_CHECKOUT_MINUTES * 60_000,
        ).toISOString(),
        locale: context.locale,
        metadata: {
          hv_tenant: toPublicId('tenant', claims.tenantId),
          hv_purchase: pur,
          hv_quote: doc.quoteId,
        },
      };
      let op = await openOperation(tx, newId(), {
        tenantId: claims.tenantId,
        kind: 'commerce.checkout.create',
        businessKey: `checkout:${rows.intent.id}`,
        requestHash: canonicalDigest({ intent: pur, quote: doc.quoteId, hash: input.quoteHash }),
        provider: rows.merchant.provider,
        resourceType: 'purchase_intent',
        resourceId: rows.intent.id,
        conversationId: rows.control.id,
        ownerEpoch: rows.control.ownershipEpoch,
        actor: { type: 'customer', id: toPublicId('customer', claims.principalId) },
        idempotencyKey: (id) => `hv-checkout-${id}`,
        detail: { request: stored },
      });
      await tx
        .update(schema.purchaseIntents)
        .set({ checkoutOperationId: op.id })
        .where(eq(schema.purchaseIntents.id, rows.intent.id));
      const dispatched = await moveOperation(
        tx,
        op,
        'dispatch',
        {
          attempts: op.attempts + 1,
          dispatchedAt: now,
          // If this process dies mid-call, the reconciler picks the operation up from here.
          nextReconcileAt: new Date(
            now.getTime() + this.config.COMMERCE_PROVIDER_TIMEOUT_MS + 30_000,
          ),
        },
        now,
      );
      if (!dispatched) throw new Error('checkout operation could not be dispatched');
      op = dispatched;
      rows.operation = op;
      await addReceipt(tx, op, {
        kind: 'dispatch',
        outcome: 'pending',
        source: 'provider_api',
        evidence: { subject: 'checkout_session', attempt: op.attempts },
        observedAt: now,
      });
      await appendAudit(tx, {
        actorType: 'customer',
        actorId: toPublicId('customer', claims.principalId),
        action: 'commerce.quote.approved',
        targetType: 'purchase',
        targetId: pur,
        outcome: 'success',
        occurredAt: now,
        data: {
          quote: doc.quoteId,
          hash: input.quoteHash,
          cartRevision: input.cartRevision,
          totalMinor: doc.totalMinor,
          currency: doc.currency,
        },
      });
      effects.add(
        claims.tenantId,
        rows.control.id,
        await this.journal.append(tx, claims.tenantId, rows.control.id, [
          {
            lane: 'customer',
            type: 'approval.updated',
            data: { approvalId: doc.quoteId, status: 'approved' },
          },
        ]),
      );
      await journalAction(this.journal, tx, effects, {
        tenantId: claims.tenantId,
        conversationId: rows.control.id,
        actionId: pur,
        outcome: 'approved',
        summary: 'Approved. Opening the secure payment page.',
      });
      return {
        kind: 'dispatch' as const,
        intentId: rows.intent.id,
        provider: await this.providers.forConnection(tx, rows.merchant),
        request: this.checkoutRequest(op, doc, stored, rows.quote.createdAt),
      };
    });
    if (step.kind === 'refused') {
      await effects.flush(this.journal);
      throw REFUSALS[step.reason]();
    }
    if (step.kind === 'replay') return this.view(step.rows);
    const view = await this.dispatch(
      claims.tenantId,
      step.intentId,
      step.provider,
      step.request,
      effects,
    );
    await effects.flush(this.journal);
    return view;
  }

  private checkoutRequest(
    op: OperationRow,
    doc: QuoteDocument,
    stored: StoredCheckoutRequest,
    quotedAt: Date,
  ): CheckoutRequest {
    return {
      reference: toPublicId('operation', op.id),
      idempotencyKey: op.providerIdempotencyKey,
      quote: providerQuoteOf(doc, quotedAt),
      successUrl: stored.successUrl,
      cancelUrl: stored.cancelUrl,
      expiresAt: new Date(stored.expiresAt),
      locale: stored.locale,
      metadata: stored.metadata,
    };
  }

  /** Sends the checkout request and records whatever came back, including silence. */
  private async dispatch(
    tenantId: string,
    intentId: string,
    provider: CommerceProvider,
    request: CheckoutRequest,
    effects: Effects,
  ): Promise<PurchaseIntentView> {
    let session: CheckoutSession | null = null;
    let failure: unknown = null;
    try {
      session = await provider.createCheckout(request);
    } catch (error) {
      failure = error;
    }
    const observedAt = this.clock();
    return this.tenantTx(tenantId, 'commerce', async (tx) => {
      const rows = await this.purchases.load(tx, intentId);
      if (!rows) throw new Error(`purchase ${intentId} vanished`);
      const obs: Observation = { kind: 'response', source: 'provider_api', occurredAt: observedAt };
      if (session) await this.purchases.attachSession(tx, rows, session, obs, effects);
      else if (outcomeUnknown(failure))
        await this.purchases.loseTrack(tx, rows, failure, obs, effects);
      else await this.purchases.failDispatch(tx, rows, failure, obs, effects);
      return this.view(rows);
    });
  }

  private async setQuote(tx: TenantTx, rows: PurchaseRows, event: 'approve' | 'expire' | 'cancel') {
    const to = nextState(quoteMachine, rows.quote.status as QuoteState, event);
    if (to === null) return false;
    const [row] = await tx
      .update(schema.quotes)
      .set({ status: to, updatedAt: this.clock() })
      .where(eq(schema.quotes.id, rows.quote.id))
      .returning();
    if (row) rows.quote = row;
    return true;
  }

  private async expireQuote(tx: TenantTx, rows: PurchaseRows, effects: Effects) {
    if (!(await this.setQuote(tx, rows, 'expire'))) return;
    await tx
      .update(schema.purchaseIntents)
      .set({ state: 'expired', updatedAt: this.clock() })
      .where(
        and(
          eq(schema.purchaseIntents.id, rows.intent.id),
          eq(schema.purchaseIntents.state, 'awaiting_approval'),
        ),
      );
    effects.add(
      rows.intent.tenantId,
      rows.control.id,
      await this.journal.append(tx, rows.intent.tenantId, rows.control.id, [
        {
          lane: 'customer',
          type: 'approval.updated',
          data: { approvalId: toPublicId('quote', rows.quote.id), status: 'expired' },
        },
      ]),
    );
  }

  // ── Customer: check status, cancel (C06, HNV-20-05/06) ─────────────────────────────────────

  /** "Check status": asks the provider now (rate limited); never creates a second payment. */
  async refresh(
    claims: WidgetClaims,
    conversationId: string,
    purchaseId: string,
  ): Promise<PurchaseIntentView> {
    const intentId = fromPublicId('purchase', purchaseId);
    const plan = await this.customerTx(claims, async (tx) => {
      const rows = await this.customerPurchase(tx, claims, conversationId, { intentId });
      const now = this.clock();
      if (
        rows.intent.lastCheckedAt &&
        now.getTime() - rows.intent.lastCheckedAt.getTime() < REFRESH_MIN_MS
      ) {
        return { kind: 'view' as const, view: this.view(rows) };
      }
      await tx
        .update(schema.purchaseIntents)
        .set({ lastCheckedAt: now })
        .where(eq(schema.purchaseIntents.id, rows.intent.id));
      if (rows.operation && ['dispatched', 'unknown'].includes(rows.operation.state)) {
        return { kind: 'reconcile' as const, operationId: rows.operation.id };
      }
      if (rows.payment && !['captured', 'failed', 'cancelled'].includes(rows.payment.state)) {
        return { kind: 'sync' as const, paymentId: rows.payment.id };
      }
      return { kind: 'view' as const, view: this.view(rows) };
    });
    if (plan.kind === 'reconcile')
      await this.reconcileOperation(claims.tenantId, plan.operationId, 'customer');
    if (plan.kind === 'sync') await this.syncPayment(claims.tenantId, plan.paymentId, 'customer');
    if (plan.kind === 'view') return plan.view;
    return this.getPurchase(claims, conversationId, purchaseId);
  }

  /**
   * Closes an unpaid payment page and keeps the cart. If the provider says it was paid in the
   * meantime, that payment stands: a completed payment is never undone here.
   */
  async cancel(
    claims: WidgetClaims,
    conversationId: string,
    purchaseId: string,
  ): Promise<PurchaseIntentView> {
    const intentId = fromPublicId('purchase', purchaseId);
    const effects = new Effects();
    const plan = await this.customerTx(claims, async (tx) => {
      const rows = await this.customerPurchase(tx, claims, conversationId, { intentId });
      if (rows.intent.state === 'awaiting_approval') {
        await tx
          .update(schema.purchaseIntents)
          .set({ state: 'cancelled', updatedAt: this.clock() })
          .where(eq(schema.purchaseIntents.id, rows.intent.id));
        await this.setQuote(tx, rows, 'cancel');
        const reloaded = await this.purchases.load(tx, rows.intent.id);
        return { kind: 'view' as const, view: this.view(reloaded ?? rows) };
      }
      const payment = rows.payment;
      if (
        rows.intent.state !== 'executing' ||
        !payment ||
        !['not_started', 'requires_action'].includes(payment.state)
      ) {
        return { kind: 'view' as const, view: this.view(rows) };
      }
      return {
        kind: 'expire' as const,
        sessionRef: payment.sessionRef,
        provider: await this.providers.forConnection(tx, rows.merchant),
      };
    });
    if (plan.kind === 'view') return plan.view;
    let session: CheckoutSession;
    try {
      session = await plan.provider.expireCheckout(plan.sessionRef);
    } catch (error) {
      throw new AppError('PROVIDER_UNAVAILABLE', {
        detail: 'The payment page could not be closed right now. Nothing was charged by this.',
        internal: errorEvidence(error),
      });
    }
    const observedAt = this.clock();
    const view = await this.tenantTx(
      claims.tenantId,
      toPublicId('customer', claims.principalId),
      async (tx) => {
        const rows = await this.purchases.load(tx, intentId);
        if (!rows) throw new AppError('NOT_FOUND');
        const obs: Observation = {
          kind: 'reconcile',
          source: 'provider_api',
          occurredAt: observedAt,
        };
        const signal = signalFromSession(session);
        await this.purchases.applySignal(
          tx,
          rows,
          signal.target === 'closed' ? { target: 'closed', reason: 'cancelled' } : signal,
          obs,
          effects,
        );
        return this.view(rows);
      },
    );
    await effects.flush(this.journal);
    return view;
  }

  // ── Reconciliation (C09, R07): worker, "Check status" and finance checks ───────────────────

  /** Resolves a checkout request whose answer was lost, from the provider's own records. */
  async reconcileOperation(
    tenantId: string,
    operationId: string,
    trigger: 'worker' | 'customer' | 'staff',
  ): Promise<void> {
    const effects = new Effects();
    const now = this.clock();
    const plan = await this.tenantTx(tenantId, 'commerce', async (tx) => {
      const [op] = await tx
        .select()
        .from(schema.operations)
        .where(eq(schema.operations.id, operationId))
        .for('update');
      if (!op || !['dispatched', 'unknown'].includes(op.state) || !op.resourceId) return null;
      if (op.kind !== 'commerce.checkout.create') return null;
      const rows = await this.purchases.load(tx, op.resourceId);
      if (!rows) return null;
      // A request still in flight is left alone until its timeout has surely passed.
      const inFlight =
        op.state === 'dispatched' &&
        op.dispatchedAt !== null &&
        now.getTime() - op.dispatchedAt.getTime() <
          this.config.COMMERCE_PROVIDER_TIMEOUT_MS + 5_000;
      if (inFlight) return null;
      const attempts = op.reconcileAttempts + 1;
      await tx
        .update(schema.operations)
        .set({
          reconcileAttempts: attempts,
          nextReconcileAt: new Date(now.getTime() + backoffMs(attempts, 60 * 60_000)),
          updatedAt: now,
        })
        .where(eq(schema.operations.id, op.id));
      const stored = (op.detail as { request?: StoredCheckoutRequest }).request;
      return {
        op: { ...op, reconcileAttempts: attempts },
        stored,
        doc: rows.quote.document as unknown as QuoteDocument,
        quotedAt: rows.quote.createdAt,
        provider: await this.providers.forConnection(tx, rows.merchant),
      };
    });
    if (!plan) return;
    const { op, provider } = plan;
    const source = trigger === 'worker' ? 'reconciler' : 'provider_api';
    const createdAfter = op.dispatchedAt ?? op.createdAt;
    let found: CheckoutSession | null = null;
    let failure: unknown = null;
    let resent = false;
    try {
      found = await provider.findCheckout(toPublicId('operation', op.id), createdAfter);
      const expiresAt = plan.stored ? new Date(plan.stored.expiresAt) : null;
      if (
        !found &&
        plan.stored &&
        expiresAt &&
        expiresAt.getTime() - now.getTime() >= MIN_SESSION_MS &&
        op.attempts < 3
      ) {
        // Never created (the request was lost on the way): the same request under the same
        // idempotency key cannot make a second session.
        resent = true;
        found = await provider.createCheckout(
          this.checkoutRequest(op, plan.doc, plan.stored, plan.quotedAt),
        );
      }
    } catch (error) {
      failure = error;
    }
    const observedAt = this.clock();
    await this.tenantTx(tenantId, 'commerce', async (tx) => {
      const rows = await this.purchases.load(tx, op.resourceId as string);
      if (!rows?.operation) return;
      const obs: Observation = { kind: 'reconcile', source, occurredAt: observedAt };
      if (resent) {
        await tx
          .update(schema.operations)
          .set({ attempts: rows.operation.attempts + 1, updatedAt: observedAt })
          .where(eq(schema.operations.id, rows.operation.id));
      }
      if (found) {
        await this.purchases.attachSession(tx, rows, found, obs, effects);
        return;
      }
      if (failure && !resent) {
        // The provider could not be asked: try again later; after many tries a person looks.
        await addReceipt(tx, rows.operation, {
          kind: 'reconcile',
          outcome: 'unknown',
          source,
          evidence: { subject: 'checkout_session', ...errorEvidence(failure) },
          observedAt,
        });
        if (op.reconcileAttempts >= RECONCILE_LIMIT) {
          await openException(tx, {
            tenantId,
            kind: 'payment_unknown',
            subjectType: 'operation',
            subjectId: op.id,
            operationId: op.id,
            sourceState: 'provider_unreachable',
            nextSafeAction: 'check_status',
            evidence: { attempts: op.reconcileAttempts, lastError: errorCode(failure) },
            now: observedAt,
          });
        }
        return;
      }
      if (failure && resent && outcomeUnknown(failure)) {
        await this.purchases.loseTrack(tx, rows, failure, obs, effects);
        return;
      }
      // Not found and not resendable (or refused when resent): no session exists, so nothing
      // can be paid. The purchase ends and the cart is kept.
      await this.purchases.failDispatch(tx, rows, failure ?? new Error('not_found'), obs, effects);
    });
    await effects.flush(this.journal);
    if (failure) this.logger.warn(`checkout ${op.id} reconcile: ${errorCode(failure)}`);
  }

  /** Asks the provider for a payment still owed an outcome (a lost webhook, a slow bank). */
  async syncPayment(
    tenantId: string,
    paymentId: string,
    trigger: 'worker' | 'customer' | 'staff',
  ): Promise<void> {
    const effects = new Effects();
    const plan = await this.tenantTx(tenantId, 'commerce', async (tx) => {
      const [payment] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.id, paymentId));
      if (!payment) return null;
      const rows = await this.purchases.load(tx, payment.purchaseIntentId);
      if (!rows?.payment) return null;
      if (['captured', 'failed', 'cancelled'].includes(rows.payment.state)) {
        await this.purchases.scheduleSync(tx, rows, rows.payment.state);
        return null;
      }
      return {
        intentId: rows.intent.id,
        sessionRef: rows.payment.sessionRef,
        provider: await this.providers.forConnection(tx, rows.merchant),
      };
    });
    if (!plan) return;
    let session: CheckoutSession | null = null;
    let failure: unknown = null;
    try {
      session = await plan.provider.getCheckout(plan.sessionRef);
    } catch (error) {
      failure = error;
    }
    const observedAt = this.clock();
    await this.tenantTx(tenantId, 'commerce', async (tx) => {
      const rows = await this.purchases.load(tx, plan.intentId);
      if (!rows) return;
      if (session) {
        await this.purchases.applySignal(
          tx,
          rows,
          signalFromSession(session),
          {
            kind: 'reconcile',
            source: trigger === 'worker' ? 'reconciler' : 'provider_api',
            occurredAt: observedAt,
          },
          effects,
        );
      }
      await this.purchases.scheduleSync(
        tx,
        rows,
        session ? session.status : 'provider_unreachable',
      );
    });
    await effects.flush(this.journal);
    if (failure) this.logger.warn(`payment ${paymentId} sync: ${errorCode(failure)}`);
  }
}
