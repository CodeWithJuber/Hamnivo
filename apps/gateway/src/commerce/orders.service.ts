import type {
  ConversationCommerce,
  CustomerOrderView,
  OrderDetail,
  OrderStatusCard,
  OrderSummary,
  RecordFulfillmentRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import {
  type CommerceCapabilities,
  evaluateRefund,
  type FulfillmentState,
  fulfillmentMachine,
  nextState,
  type OrderState,
  orderMachine,
} from '@hamnivo/domain/commerce';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import type { WidgetClaims } from '../widget/tokens.service.js';
import {
  type BrandScope,
  brandScope,
  customerConversation,
  decide,
  requireBrand,
} from './access.js';
import { CommerceCardsService } from './card-publisher.service.js';
import { orderStatusPublication } from './cards.js';
import { minor } from './common.js';
import { receiptsOf } from './ledger.js';
import { merchantRefundPolicy, RefundsService } from './refunds.service.js';
import {
  customerOrderView,
  exceptionView,
  fulfillmentView,
  type OrderLine,
  type OrderRow,
  operationView,
  orderSummary,
} from './views.js';

type FulfillmentInput = z.output<typeof RecordFulfillmentRequest>;

const PENDING_REFUNDS = [
  'requested',
  'policy_checked',
  'awaiting_approval',
  'submitted',
  'pending',
  'unknown',
] as const;

const FULFILLMENT_EVENT: Record<
  FulfillmentInput['state'],
  (typeof fulfillmentMachine.events)[number]
> = {
  in_progress: 'start',
  delayed: 'delay',
  shipped: 'ship',
  delivered: 'deliver',
  provisioned: 'provision',
  failed: 'fail',
};

/** Card wording of a fulfilment state (only what the merchant or staff reported). */
const FULFILLMENT_TEXT: Record<string, string> = {
  in_progress: 'is being prepared',
  delayed: 'is delayed',
  shipped: 'has shipped',
  delivered: 'was delivered',
  provisioned: 'is active',
  failed: 'could not be completed',
};

/** What the customer's card shows for each fulfilment state: shipped is not delivered (C10). */
const CARD_FULFILLMENT: Record<
  FulfillmentState,
  z.infer<typeof OrderStatusCard>['fulfillmentState']
> = {
  pending: 'not_started',
  in_progress: 'processing',
  delayed: 'delayed',
  shipped: 'shipped',
  delivered: 'fulfilled',
  provisioned: 'provisioned',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** States in which a delivery estimate still means something. */
const ESTIMATE_STATES: readonly FulfillmentState[] = ['in_progress', 'delayed', 'shipped'];

/**
 * Orders and fulfilment (C10), staff order views with operations, receipts and exceptions
 * (C19, R07), and the customer's own order view. Everything is read from the records at request
 * time; nothing is cached (K06).
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly refunds: RefundsService,
    private readonly cards: CommerceCardsService,
  ) {}

  private options() {
    return { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 };
  }

  private staffTx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  /** Brands (with workspaces) where this person may read commerce records. */
  private async readableBrands(
    tx: TenantTx,
    principal: StaffPrincipal,
  ): Promise<Map<string, BrandScope>> {
    const brands = await tx
      .select({ id: schema.brands.id, workspaceId: schema.brands.workspaceId })
      .from(schema.brands);
    const readable = new Map<string, BrandScope>();
    for (const brand of brands) {
      const scope = { brandId: brand.id, workspaceId: brand.workspaceId };
      if (decide(principal, 'commerce.read', scope, this.options()).allowed)
        readable.set(brand.id, scope);
    }
    return readable;
  }

  private async summaries(tx: TenantTx, orders: OrderRow[]): Promise<OrderSummary[]> {
    if (orders.length === 0) return [];
    const ids = orders.map((o) => o.id);
    const principals = await tx
      .select({ id: schema.customerPrincipals.id, name: schema.customerPrincipals.displayName })
      .from(schema.customerPrincipals)
      .where(inArray(schema.customerPrincipals.id, [...new Set(orders.map((o) => o.principalId))]));
    const names = new Map(principals.map((p) => [p.id, p.name]));
    const payments = await tx
      .select({ intent: schema.payments.purchaseIntentId, refunded: schema.payments.refundedMinor })
      .from(schema.payments)
      .where(
        inArray(
          schema.payments.purchaseIntentId,
          orders.map((o) => o.purchaseIntentId),
        ),
      );
    const refunded = new Map(payments.map((p) => [p.intent, p.refunded]));
    const exceptions = await tx
      .select({ orderId: schema.financeExceptions.orderId })
      .from(schema.financeExceptions)
      .where(
        and(
          inArray(schema.financeExceptions.orderId, ids),
          eq(schema.financeExceptions.state, 'open'),
        ),
      );
    const refunds = await tx
      .select({ orderId: schema.refunds.orderId })
      .from(schema.refunds)
      .where(
        and(
          inArray(schema.refunds.orderId, ids),
          inArray(schema.refunds.state, [...PENDING_REFUNDS]),
        ),
      );
    const count = (rows: { orderId: string | null }[], id: string) =>
      rows.filter((r) => r.orderId === id).length;
    return orders.map((order) =>
      orderSummary(order, {
        customerName: names.get(order.principalId) ?? null,
        refundedMinor: refunded.get(order.purchaseIntentId) ?? 0n,
        openExceptions: count(exceptions, order.id),
        pendingRefunds: count(refunds, order.id),
      }),
    );
  }

  async list(
    principal: StaffPrincipal,
    query: { q?: string; needsAttention?: 'true' | 'false'; limit: number },
  ): Promise<OrderSummary[]> {
    return this.staffTx(principal, async (tx) => {
      const brands = await this.readableBrands(tx, principal);
      if (brands.size === 0) return [];
      const text = query.q?.trim();
      const rows = await tx
        .select()
        .from(schema.orders)
        .where(
          and(
            inArray(schema.orders.brandId, [...brands.keys()]),
            text
              ? or(ilike(schema.orders.reference, `%${text.replace(/[%_\\]/g, '')}%`))
              : undefined,
          ),
        )
        .orderBy(desc(schema.orders.placedAt))
        .limit(query.needsAttention === 'true' ? 500 : query.limit);
      const summaries = await this.summaries(tx, rows);
      return query.needsAttention === 'true'
        ? summaries
            .filter((s) => s.openExceptions > 0 || s.pendingRefunds > 0)
            .slice(0, query.limit)
        : summaries;
    });
  }

  private async readableOrder(tx: TenantTx, principal: StaffPrincipal, publicId: string) {
    const [order] = await tx
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, fromPublicId('order', publicId)));
    const scope = order ? await brandScope(tx, order.brandId) : null;
    requireBrand(principal, 'commerce.read', scope, this.options(), 'Order not found.');
    if (!order || !scope) throw new AppError('NOT_FOUND', { detail: 'Order not found.' });
    return { order, scope };
  }

  async detail(principal: StaffPrincipal, publicId: string): Promise<OrderDetail> {
    return this.staffTx(principal, async (tx) => {
      const { order, scope } = await this.readableOrder(tx, principal, publicId);
      return this.detailOf(tx, principal, order, scope);
    });
  }

  private async detailOf(
    tx: TenantTx,
    principal: StaffPrincipal,
    order: OrderRow,
    scope: BrandScope,
  ): Promise<OrderDetail> {
    const now = this.clock();
    const [summary] = await this.summaries(tx, [order]);
    const [merchant] = await tx
      .select()
      .from(schema.merchantConnections)
      .where(eq(schema.merchantConnections.id, order.merchantConnectionId));
    if (!merchant || !summary) throw new AppError('NOT_FOUND');
    const [payment] = await tx
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.purchaseIntentId, order.purchaseIntentId));
    const fulfillments = await tx
      .select()
      .from(schema.fulfillments)
      .where(eq(schema.fulfillments.orderId, order.id))
      .orderBy(asc(schema.fulfillments.createdAt));
    const refunds = await tx
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.orderId, order.id))
      .orderBy(desc(schema.refunds.requestedAt));
    const [intent] = await tx
      .select({ operationId: schema.purchaseIntents.checkoutOperationId })
      .from(schema.purchaseIntents)
      .where(eq(schema.purchaseIntents.id, order.purchaseIntentId));
    const operationIds = [
      ...(intent?.operationId ? [intent.operationId] : []),
      ...refunds.map((r) => r.operationId).filter((id): id is string => id !== null),
    ];
    const operations = operationIds.length
      ? await tx
          .select()
          .from(schema.operations)
          .where(inArray(schema.operations.id, operationIds))
          .orderBy(asc(schema.operations.createdAt))
      : [];
    const receipts = await receiptsOf(
      tx,
      operations.map((o) => o.id),
    );
    const exceptions = await tx
      .select()
      .from(schema.financeExceptions)
      .where(
        or(
          eq(schema.financeExceptions.orderId, order.id),
          operationIds.length
            ? inArray(schema.financeExceptions.operationId, operationIds)
            : undefined,
        ),
      )
      .orderBy(desc(schema.financeExceptions.openedAt));
    const policy = merchantRefundPolicy(merchant);
    let maxMinor = 0n;
    if (payment?.state === 'captured' && payment.capturedAt) {
      const inFlight = refunds
        .filter((r) => (PENDING_REFUNDS as readonly string[]).includes(r.state))
        .reduce((acc, r) => acc + r.amountMinor, 0n);
      maxMinor = evaluateRefund(policy, merchant.capabilities as unknown as CommerceCapabilities, {
        amountMinor: 1n,
        capturedMinor: payment.capturedMinor,
        refundedMinor: payment.refundedMinor,
        inFlightMinor: inFlight,
        paidAt: payment.capturedAt,
        now,
      }).refundableMinor;
    }
    const lines = order.lines as unknown as OrderLine[];
    const caps = merchant.capabilities as unknown as CommerceCapabilities;
    const [quote] = await tx
      .select({ shippingMinor: schema.quotes.shippingMinor })
      .from(schema.quotes)
      .where(eq(schema.quotes.id, order.quoteId));
    return {
      order: summary,
      merchant: {
        id: toPublicId('merchant', merchant.id),
        name: merchant.displayName,
        provider: merchant.provider === 'stripe' ? 'stripe' : 'mock',
      },
      lines: lines.map((l) => ({
        lineId: l.lineId,
        name: l.name,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
        totalMinor: l.totalMinor,
      })),
      shippingMinor: quote?.shippingMinor == null ? null : minor(quote.shippingMinor),
      deliverySummary: order.deliverySummary,
      payment: payment
        ? {
            state: payment.state,
            amountMinor: minor(payment.amountMinor),
            capturedMinor: minor(payment.capturedMinor),
            refundedMinor: minor(payment.refundedMinor),
            capturedAt: payment.capturedAt?.toISOString() ?? null,
            providerRef: payment.paymentRef,
          }
        : null,
      refundable: {
        maxMinor: minor(maxMinor),
        partial: caps.refunds.partial,
        policy: {
          approval: policy.approval,
          autoApproveMaxMinor: minor(policy.autoApproveMaxMinor),
          requireSeparateApprover: policy.requireSeparateApprover,
          windowDays: policy.windowDays,
        },
      },
      fulfillments: fulfillments.map(fulfillmentView),
      refunds: await this.refunds.views(tx, principal, refunds, scope),
      operations: operations.map((op) => operationView(op, receipts.get(op.id) ?? [])),
      exceptions: exceptions.map((e) => exceptionView(e, order, now)),
      observedAt: now.toISOString(),
    };
  }

  /** Records a shipment or service update the merchant reported (HNV-21-02: delays included). */
  async recordFulfillment(
    principal: StaffPrincipal,
    publicId: string,
    input: FulfillmentInput,
  ): Promise<OrderDetail> {
    return this.staffTx(principal, async (tx) => {
      const { order, scope } = await this.readableOrder(tx, principal, publicId);
      enforce(decide(principal, 'commerce.orders.manage', scope, this.options()));
      if (!['confirmed', 'partially_fulfilled', 'fulfilled'].includes(order.state)) {
        throw new AppError('VALIDATION_FAILED', { detail: 'Only paid orders can be fulfilled.' });
      }
      const now = this.clock();
      const [latest] = await tx
        .select()
        .from(schema.fulfillments)
        .where(
          and(eq(schema.fulfillments.orderId, order.id), eq(schema.fulfillments.kind, input.kind)),
        )
        .orderBy(desc(schema.fulfillments.createdAt))
        .limit(1)
        .for('update');
      let fulfillment = latest;
      if (!fulfillment || ['delivered', 'provisioned', 'cancelled'].includes(fulfillment.state)) {
        [fulfillment] = await tx
          .insert(schema.fulfillments)
          .values({
            tenantId: principal.tenantId,
            orderId: order.id,
            kind: input.kind,
            source: 'staff',
          })
          .returning();
      }
      if (!fulfillment) throw new Error('fulfillment insert returned nothing');
      let state = fulfillment.state as FulfillmentState;
      // Start first when needed: a pending shipment reported as shipped went through "in progress".
      if (
        nextState(fulfillmentMachine, state, FULFILLMENT_EVENT[input.state]) === null &&
        nextState(fulfillmentMachine, state, 'start') !== null
      ) {
        state = nextState(fulfillmentMachine, state, 'start') as FulfillmentState;
      }
      const to = nextState(fulfillmentMachine, state, FULFILLMENT_EVENT[input.state]);
      if (to === null) {
        throw new AppError('VERSION_CONFLICT', {
          detail: `A ${fulfillment.kind} that is ${fulfillment.state.replace('_', ' ')} cannot become ${input.state.replace('_', ' ')}.`,
        });
      }
      await tx
        .update(schema.fulfillments)
        .set({
          state: to,
          source: 'staff',
          note: input.note ?? fulfillment.note,
          estimateAt: input.estimateAt ? new Date(input.estimateAt) : fulfillment.estimateAt,
          carrierRef: input.carrierRef ?? fulfillment.carrierRef,
          lastUpdateAt: now,
          updatedAt: now,
        })
        .where(eq(schema.fulfillments.id, fulfillment.id));
      const done = to === 'delivered' || to === 'provisioned';
      const orderTo = done ? nextState(orderMachine, order.state as OrderState, 'fulfil') : null;
      const [updated] = await tx
        .update(schema.orders)
        .set({ fulfillmentState: to, ...(orderTo ? { state: orderTo } : {}), updatedAt: now })
        .where(eq(schema.orders.id, order.id))
        .returning();
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'commerce.fulfillment.recorded',
        targetType: 'order',
        targetId: toPublicId('order', order.id),
        outcome: 'success',
        occurredAt: now,
        data: { kind: input.kind, state: to, estimateAt: input.estimateAt ?? null },
      });
      const [control] = await tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, order.conversationId));
      const [merchant] = await tx
        .select({ name: schema.merchantConnections.displayName })
        .from(schema.merchantConnections)
        .where(eq(schema.merchantConnections.id, order.merchantConnectionId));
      if (control && merchant) {
        // An estimate is the shop's, and only while the order is still on its way.
        const estimateAt = ESTIMATE_STATES.includes(to)
          ? (input.estimateAt ?? fulfillment.estimateAt?.toISOString() ?? null)
          : null;
        const estimate = estimateAt
          ? ` The shop's estimate: ${estimateAt.slice(0, 10)}. This date is not guaranteed.`
          : '';
        const [payment] = await tx
          .select({ refunded: schema.payments.refundedMinor })
          .from(schema.payments)
          .where(eq(schema.payments.purchaseIntentId, order.purchaseIntentId));
        const refunded = payment?.refunded ?? 0n;
        await this.cards.enqueue(
          tx,
          principal.tenantId,
          control,
          orderStatusPublication(
            {
              kind: 'order_status',
              version: 1,
              orderId: toPublicId('order', order.id),
              reference: order.reference,
              paymentState:
                refunded <= 0n
                  ? 'paid'
                  : refunded >= order.totalMinor
                    ? 'refunded'
                    : 'partially_refunded',
              fulfillmentState: CARD_FULFILLMENT[to],
              estimateAt,
              summary:
                `Order ${order.reference} ${FULFILLMENT_TEXT[to] ?? 'was updated'}.${estimate}`.slice(
                  0,
                  300,
                ),
              observedAt: now.toISOString(),
            },
            merchant.name,
          ),
          `fulfillment:${fulfillment.id}:${to}:${now.getTime()}`,
        );
      }
      return this.detailOf(tx, principal, updated ?? order, scope);
    });
  }

  /** A conversation's orders and the operations still owed an outcome (R07). */
  async conversation(
    principal: StaffPrincipal,
    conversationPublicId: string,
  ): Promise<z.infer<typeof ConversationCommerce>> {
    return this.staffTx(principal, async (tx) => {
      const [control] = await tx
        .select()
        .from(schema.conversationControls)
        .where(
          eq(schema.conversationControls.id, fromPublicId('conversation', conversationPublicId)),
        );
      const scope = control?.brandId ? await brandScope(tx, control.brandId) : null;
      requireBrand(principal, 'commerce.read', scope, this.options(), 'Conversation not found.');
      if (!control) throw new AppError('NOT_FOUND');
      const orders = await tx
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.conversationId, control.id))
        .orderBy(desc(schema.orders.placedAt));
      const inFlight = await tx
        .select()
        .from(schema.operations)
        .where(
          and(
            eq(schema.operations.conversationId, control.id),
            inArray(schema.operations.state, ['pending', 'dispatched', 'unknown']),
          ),
        )
        .orderBy(asc(schema.operations.createdAt));
      const receipts = await receiptsOf(
        tx,
        inFlight.map((o) => o.id),
      );
      return {
        orders: await this.summaries(tx, orders),
        inFlight: inFlight.map((op) => operationView(op, receipts.get(op.id) ?? [])),
      };
    });
  }

  /** The customer's own order in this conversation. */
  async customerOrder(
    claims: WidgetClaims,
    conversationId: string,
    orderPublicId: string,
  ): Promise<z.infer<typeof CustomerOrderView>> {
    return withTenant(
      this.db,
      { tenantId: claims.tenantId, actorId: toPublicId('customer', claims.principalId) },
      async (tx) => {
        const control = await customerConversation(tx, claims, conversationId);
        const [order] = await tx
          .select()
          .from(schema.orders)
          .where(
            and(
              eq(schema.orders.id, fromPublicId('order', orderPublicId)),
              eq(schema.orders.conversationId, control.id),
              eq(schema.orders.principalId, claims.principalId),
            ),
          );
        if (!order) throw new AppError('NOT_FOUND', { detail: 'Order not found.' });
        const refunds = await tx
          .select()
          .from(schema.refunds)
          .where(eq(schema.refunds.orderId, order.id))
          .orderBy(asc(schema.refunds.requestedAt));
        return customerOrderView(order, refunds, this.clock());
      },
    );
  }
}
