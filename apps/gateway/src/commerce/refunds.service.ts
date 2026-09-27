import type { CommerceProvider, ProviderRefund, RefundRequest } from '@hamnivo/adapters/commerce';
import type { CreateRefundRequest, RefundView } from '@hamnivo/contracts';
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
  type CommerceCapabilities,
  checkRefundApprover,
  evaluateRefund,
  nextState,
  type RefundPolicy,
  type RefundState,
  refundMachine,
} from '@hamnivo/domain/commerce';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { JournalService } from '../authority/journal.service.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { type BrandScope, brandScope, decide, requireBrand } from './access.js';
import { CommerceCardsService } from './card-publisher.service.js';
import { receiptPublication } from './cards.js';
import {
  backoffMs,
  canonicalDigest,
  errorCode,
  errorEvidence,
  minor,
  moneyText,
  outcomeUnknown,
} from './common.js';
import { Effects, journalAction } from './effects.js';
import { openException, resolveExceptionsFor } from './exceptions.js';
import { addReceipt, moveOperation, type OperationRow, openOperation } from './ledger.js';
import { CommerceProviders, type MerchantRow } from './providers.service.js';
import type { Observation } from './purchases.service.js';
import {
  type OrderLine,
  type OrderRow,
  type PaymentRow,
  type RefundRow,
  refundView,
} from './views.js';

type CreateInput = z.output<typeof CreateRefundRequest>;

/** Refunds requested, approved or with the provider: counted so two requests cannot overpay. */
const IN_FLIGHT: RefundRow['state'][] = [
  'requested',
  'policy_checked',
  'awaiting_approval',
  'submitted',
  'pending',
  'unknown',
];
const SYNC_LIMIT = 12;

interface StoredPolicy {
  policy: {
    approval: RefundPolicy['approval'];
    autoApproveMaxMinor: string;
    requireSeparateApprover: boolean;
    windowDays: number | null;
  };
  evaluation: { needsApproval: boolean; partial: boolean; refundableMinor: string };
}

export function merchantRefundPolicy(merchant: MerchantRow): RefundPolicy {
  const policy = merchant.config.refundPolicy;
  return {
    approval: policy.approval,
    autoApproveMaxMinor: BigInt(policy.autoApproveMaxMinor),
    requireSeparateApprover: policy.requireSeparateApprover,
    windowDays: policy.windowDays,
  };
}

function storedPolicy(row: RefundRow): RefundPolicy {
  const stored = (row.policy as unknown as StoredPolicy).policy;
  return { ...stored, autoApproveMaxMinor: BigInt(stored.autoApproveMaxMinor) };
}

const INELIGIBLE: Record<string, string> = {
  not_positive: 'Enter an amount above zero.',
  nothing_captured: 'Nothing was paid for this order.',
  exceeds_refundable: 'This is more than can still be refunded for this order.',
  outside_window: 'The refund period for this order has ended.',
  partial_not_supported: 'This shop can only refund the full amount.',
  refunds_not_supported: 'This shop does not support refunds from Hamnivo.',
};

interface Loaded {
  refund: RefundRow;
  order: OrderRow;
  payment: PaymentRow;
  merchant: MerchantRow;
  scope: BrandScope | null;
  operation: OperationRow | null;
}

/**
 * Refunds (C12). Staff ask; the merchant's policy (evaluated here, not by anyone's wording)
 * decides whether a second person must approve; with a separate approver required the requester
 * cannot approve their own request. The provider call goes through the operation ledger, and
 * "refunded" is shown only when the provider says the refund succeeded.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly providers: CommerceProviders,
    private readonly cards: CommerceCardsService,
    private readonly journal: JournalService,
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

  private async load(tx: TenantTx, refundId: string): Promise<Loaded | null> {
    const [refund] = await tx
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, refundId))
      .for('update');
    if (!refund) return null;
    const [order] = await tx
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, refund.orderId));
    const [payment] = await tx
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, refund.paymentId))
      .for('update');
    if (!order || !payment) return null;
    const [merchant] = await tx
      .select()
      .from(schema.merchantConnections)
      .where(eq(schema.merchantConnections.id, order.merchantConnectionId));
    if (!merchant) return null;
    const [operation] = refund.operationId
      ? await tx
          .select()
          .from(schema.operations)
          .where(eq(schema.operations.id, refund.operationId))
          .for('update')
      : [];
    return {
      refund,
      order,
      payment,
      merchant,
      scope: await brandScope(tx, order.brandId),
      operation: operation ?? null,
    };
  }

  /** Staff views of refunds, with whether this person may approve each one. */
  async views(tx: TenantTx, principal: StaffPrincipal, rows: RefundRow[], scope: BrandScope) {
    const people = [
      ...new Set(rows.flatMap((r) => [r.requestedBy, r.approvedBy, r.rejectedBy]).filter(Boolean)),
    ] as string[];
    const names = new Map(
      people.length
        ? (
            await tx
              .select({ id: schema.staffMembers.id, name: schema.staffMembers.displayName })
              .from(schema.staffMembers)
              .where(inArray(schema.staffMembers.id, people))
          ).map((p) => [p.id, p.name])
        : [],
    );
    const decision = decide(principal, 'commerce.refunds.approve', scope, this.options());
    const permitted =
      decision.allowed ||
      decision.reason === 'mfa_required' ||
      decision.reason === 'step_up_required';
    return rows.map((row): RefundView => {
      const stored = row.policy as unknown as StoredPolicy;
      let reason: RefundView['approval']['reason'] = null;
      if (row.state !== 'awaiting_approval') reason = 'not_awaiting';
      else if (!permitted) reason = 'no_permission';
      else if (
        stored.policy.requireSeparateApprover &&
        row.requestedBy === principal.staffMemberId
      ) {
        reason = 'same_person';
      }
      return refundView(row, names, {
        required: stored.evaluation.needsApproval,
        canApprove: reason === null,
        reason,
      });
    });
  }

  private async view(tx: TenantTx, principal: StaffPrincipal, loaded: Loaded): Promise<RefundView> {
    const [refund] = await tx
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, loaded.refund.id));
    const [view] = await this.views(
      tx,
      principal,
      [refund ?? loaded.refund],
      loaded.scope as BrandScope,
    );
    return view as RefundView;
  }

  private async inFlight(tx: TenantTx, paymentId: string, except?: string): Promise<bigint> {
    const [row] = await tx
      .select({ total: sql<string>`coalesce(sum(${schema.refunds.amountMinor}), 0)::text` })
      .from(schema.refunds)
      .where(
        and(
          eq(schema.refunds.paymentId, paymentId),
          inArray(schema.refunds.state, IN_FLIGHT),
          ...(except ? [ne(schema.refunds.id, except)] : []),
        ),
      );
    return BigInt(row?.total ?? '0');
  }

  // ── Request ─────────────────────────────────────────────────────────────────────────────────

  async request(
    principal: StaffPrincipal,
    orderPublicId: string,
    input: CreateInput,
  ): Promise<RefundView> {
    const orderId = fromPublicId('order', orderPublicId);
    const effects = new Effects();
    const step = await this.staffTx(principal, async (tx) => {
      const [order] = await tx.select().from(schema.orders).where(eq(schema.orders.id, orderId));
      const scope = order ? await brandScope(tx, order.brandId) : null;
      requireBrand(principal, 'commerce.read', scope, this.options(), 'Order not found.');
      if (!order || !scope) throw new AppError('NOT_FOUND');
      enforce(decide(principal, 'commerce.refunds.request', scope, this.options()));
      const amount = BigInt(input.amountMinor);
      const [existing] = await tx
        .select()
        .from(schema.refunds)
        .where(
          and(
            eq(schema.refunds.orderId, order.id),
            eq(schema.refunds.clientRequestId, input.clientRequestId),
          ),
        );
      if (existing) {
        if (existing.amountMinor !== amount || existing.reason !== input.reason) {
          throw new AppError('IDEMPOTENCY_CONFLICT');
        }
        const loaded = await this.load(tx, existing.id);
        if (!loaded) throw new AppError('NOT_FOUND');
        return { kind: 'view' as const, view: await this.view(tx, principal, loaded) };
      }
      const [payment] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.purchaseIntentId, order.purchaseIntentId))
        .for('update');
      if (payment?.state !== 'captured' || !payment.capturedAt) {
        throw new AppError('VALIDATION_FAILED', { detail: INELIGIBLE.nothing_captured });
      }
      const [merchant] = await tx
        .select()
        .from(schema.merchantConnections)
        .where(eq(schema.merchantConnections.id, order.merchantConnectionId));
      if (!merchant) throw new AppError('NOT_FOUND');
      const lines = order.lines as unknown as OrderLine[];
      for (const line of input.lines) {
        const ordered = lines.find((l) => l.lineId === line.lineId);
        if (!ordered || line.quantity > ordered.quantity) {
          throw new AppError('VALIDATION_FAILED', {
            fields: [
              { path: `lines.${line.lineId}`, message: 'Not on this order in that quantity.' },
            ],
          });
        }
      }
      const policy = merchantRefundPolicy(merchant);
      const now = this.clock();
      const evaluation = evaluateRefund(
        policy,
        merchant.capabilities as unknown as CommerceCapabilities,
        {
          amountMinor: amount,
          capturedMinor: payment.capturedMinor,
          refundedMinor: payment.refundedMinor,
          inFlightMinor: await this.inFlight(tx, payment.id),
          paidAt: payment.capturedAt,
          now,
        },
      );
      if (!evaluation.eligible) {
        throw new AppError('VALIDATION_FAILED', {
          detail: INELIGIBLE[evaluation.reasons[0] ?? ''] ?? 'This refund is not allowed.',
          fields: evaluation.reasons.map((r) => ({
            path: 'amountMinor',
            message: INELIGIBLE[r] ?? r,
          })),
        });
      }
      const stored: StoredPolicy = {
        policy: { ...policy, autoApproveMaxMinor: minor(policy.autoApproveMaxMinor) },
        evaluation: {
          needsApproval: evaluation.needsApproval,
          partial: evaluation.partial,
          refundableMinor: minor(evaluation.refundableMinor),
        },
      };
      // requested → policy_checked → awaiting_approval, or straight to submitted when the
      // policy lets small refunds through without a second person.
      const [refund] = await tx
        .insert(schema.refunds)
        .values({
          tenantId: principal.tenantId,
          orderId: order.id,
          paymentId: payment.id,
          amountMinor: amount,
          currency: payment.currency,
          lines: input.lines,
          reason: input.reason,
          note: input.note ?? null,
          state: evaluation.needsApproval ? 'awaiting_approval' : 'submitted',
          clientRequestId: input.clientRequestId,
          requestedBy: principal.staffMemberId,
          requestedAt: now,
          policy: stored as unknown as Record<string, unknown>,
          ...(evaluation.needsApproval ? {} : { approvedAt: now }),
        })
        .returning();
      if (!refund) throw new Error('refund insert returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'commerce.refund.requested',
        targetType: 'refund',
        targetId: toPublicId('refund', refund.id),
        outcome: 'success',
        occurredAt: now,
        data: {
          order: toPublicId('order', order.id),
          amountMinor: minor(amount),
          currency: payment.currency,
          reason: input.reason,
          needsApproval: evaluation.needsApproval,
        },
      });
      const loaded = await this.load(tx, refund.id);
      if (!loaded) throw new Error('refund vanished');
      if (evaluation.needsApproval) {
        return { kind: 'view' as const, view: await this.view(tx, principal, loaded) };
      }
      return { kind: 'dispatch' as const, ...(await this.prepareDispatch(tx, loaded, principal)) };
    });
    if (step.kind === 'view') return step.view;
    await this.dispatch(principal.tenantId, step.refundId, step.provider, step.request, effects);
    await effects.flush(this.journal);
    return this.staffTx(principal, async (tx) => {
      const loaded = await this.load(tx, step.refundId);
      if (!loaded) throw new AppError('NOT_FOUND');
      return this.view(tx, principal, loaded);
    });
  }

  /** Opens the refund operation and returns the exact provider request to send. */
  private async prepareDispatch(tx: TenantTx, loaded: Loaded, approver: StaffPrincipal) {
    const { refund, payment, merchant } = loaded;
    if (!payment.paymentRef)
      throw new AppError('VALIDATION_FAILED', { detail: INELIGIBLE.nothing_captured });
    const now = this.clock();
    const rfd = toPublicId('refund', refund.id);
    const request = {
      paymentRef: payment.paymentRef,
      amountMinor: minor(refund.amountMinor),
      currency: refund.currency,
      reason: refund.reason === 'duplicate' ? 'duplicate' : 'requested_by_customer',
      metadata: { hv_refund: rfd, hv_order: toPublicId('order', refund.orderId) },
    };
    let op = await openOperation(tx, newId(), {
      tenantId: refund.tenantId,
      kind: 'commerce.refund.create',
      businessKey: `refund:${refund.id}`,
      requestHash: canonicalDigest(request),
      provider: merchant.provider,
      resourceType: 'refund',
      resourceId: refund.id,
      conversationId: loaded.order.conversationId,
      ownerEpoch: null,
      actor: { type: 'staff', id: toPublicId('staff', approver.staffMemberId) },
      idempotencyKey: (id) => `hv-refund-${id}`,
      detail: { request },
    });
    const dispatched = await moveOperation(
      tx,
      op,
      'dispatch',
      {
        attempts: op.attempts + 1,
        dispatchedAt: now,
        nextReconcileAt: new Date(
          now.getTime() + this.config.COMMERCE_PROVIDER_TIMEOUT_MS + 30_000,
        ),
      },
      now,
    );
    if (dispatched) op = dispatched;
    await addReceipt(tx, op, {
      kind: 'dispatch',
      outcome: 'pending',
      source: 'provider_api',
      evidence: { subject: 'refund', attempt: op.attempts },
      observedAt: now,
    });
    await tx
      .update(schema.refunds)
      .set({ operationId: op.id, updatedAt: now })
      .where(eq(schema.refunds.id, refund.id));
    return {
      refundId: refund.id,
      provider: await this.providers.forConnection(tx, merchant),
      request: this.refundRequest(op, request),
    };
  }

  private refundRequest(
    op: OperationRow,
    stored: {
      paymentRef: string;
      amountMinor: string;
      currency: string;
      reason: string;
      metadata: Record<string, string>;
    },
  ): RefundRequest {
    return {
      reference: toPublicId('operation', op.id),
      idempotencyKey: op.providerIdempotencyKey,
      paymentRef: stored.paymentRef,
      amountMinor: BigInt(stored.amountMinor),
      currency: stored.currency,
      reason: stored.reason as RefundRequest['reason'],
      metadata: stored.metadata,
    };
  }

  private async dispatch(
    tenantId: string,
    refundId: string,
    provider: CommerceProvider,
    request: RefundRequest,
    effects: Effects,
  ): Promise<void> {
    let result: ProviderRefund | null = null;
    let failure: unknown = null;
    try {
      result = await provider.createRefund(request);
    } catch (error) {
      failure = error;
    }
    const observedAt = this.clock();
    await withTenant(this.db, { tenantId, actorId: 'commerce' }, async (tx) => {
      const loaded = await this.load(tx, refundId);
      if (!loaded) return;
      await this.applyResult(
        tx,
        loaded,
        result,
        failure,
        {
          kind: 'response',
          source: 'provider_api',
          occurredAt: observedAt,
        },
        effects,
      );
    });
  }

  /** Records the answer (or the silence) after a refund request was sent. */
  private async applyResult(
    tx: TenantTx,
    loaded: Loaded,
    result: ProviderRefund | null,
    failure: unknown,
    obs: Observation,
    effects: Effects,
  ): Promise<void> {
    const now = this.clock();
    const op = loaded.operation;
    if (result) {
      if (op) {
        const moved = await moveOperation(
          tx,
          op,
          'succeed',
          { providerRef: result.id, lastErrorCode: null },
          now,
        );
        if (moved) loaded.operation = moved;
        await resolveExceptionsFor(tx, op.id, now);
      }
      await tx
        .update(schema.refunds)
        .set({ providerRefundRef: result.id, updatedAt: now })
        .where(eq(schema.refunds.id, loaded.refund.id));
      loaded.refund = { ...loaded.refund, providerRefundRef: result.id };
      await this.applyProviderRefund(tx, loaded, result, obs, effects);
      return;
    }
    if (outcomeUnknown(failure)) {
      if (op) {
        const moved = await moveOperation(
          tx,
          op,
          'lose_track',
          { lastErrorCode: errorCode(failure), nextReconcileAt: new Date(now.getTime() + 15_000) },
          now,
        );
        if (moved) loaded.operation = moved;
        await addReceipt(tx, loaded.operation ?? op, {
          kind: obs.kind,
          outcome: 'unknown',
          source: obs.source,
          evidence: { subject: 'refund', ...errorEvidence(failure) },
          observedAt: obs.occurredAt,
        });
      }
      await this.moveRefund(tx, loaded, 'outcome_unknown', {});
      return;
    }
    if (op) {
      const moved = await moveOperation(tx, op, 'fail', { lastErrorCode: errorCode(failure) }, now);
      if (moved) loaded.operation = moved;
      await addReceipt(tx, loaded.operation ?? op, {
        kind: obs.kind,
        outcome: 'failed',
        source: obs.source,
        evidence: { subject: 'refund', ...errorEvidence(failure) },
        observedAt: obs.occurredAt,
      });
    }
    await this.fail(tx, loaded, errorCode(failure), obs);
  }

  private async moveRefund(
    tx: TenantTx,
    loaded: Loaded,
    event: (typeof refundMachine.events)[number],
    set: Partial<typeof schema.refunds.$inferInsert>,
  ): Promise<boolean> {
    const to = nextState(refundMachine, loaded.refund.state as RefundState, event);
    if (to === null) return false;
    const [row] = await tx
      .update(schema.refunds)
      .set({ ...set, state: to, updatedAt: this.clock() })
      .where(eq(schema.refunds.id, loaded.refund.id))
      .returning();
    if (row) loaded.refund = row;
    return true;
  }

  private async fail(tx: TenantTx, loaded: Loaded, reason: string, obs: Observation) {
    const now = this.clock();
    if (
      !(await this.moveRefund(tx, loaded, 'provider_failed', {
        failureReason: reason,
        nextSyncAt: null,
      }))
    ) {
      return;
    }
    await openException(tx, {
      tenantId: loaded.refund.tenantId,
      kind: 'refund_failed',
      subjectType: 'refund',
      subjectId: loaded.refund.id,
      operationId: loaded.refund.operationId,
      orderId: loaded.order.id,
      sourceState: 'failed',
      nextSafeAction: 'retry_refund',
      evidence: {
        amountMinor: minor(loaded.refund.amountMinor),
        currency: loaded.refund.currency,
        failureReason: reason,
        providerRef: loaded.refund.providerRefundRef,
        observedVia: obs.source,
      },
      now,
    });
    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'commerce',
      action: 'commerce.refund.failed',
      targetType: 'refund',
      targetId: toPublicId('refund', loaded.refund.id),
      outcome: 'failed',
      occurredAt: now,
      data: { reason, amountMinor: minor(loaded.refund.amountMinor) },
    });
  }

  /** Applies the provider's refund object; "refunded" only when it says succeeded. */
  async applyProviderRefund(
    tx: TenantTx,
    loaded: Loaded,
    result: ProviderRefund,
    obs: Observation,
    effects: Effects,
  ): Promise<'applied' | 'stale'> {
    const now = this.clock();
    const outcome =
      result.status === 'succeeded'
        ? 'succeeded'
        : result.status === 'failed' || result.status === 'canceled'
          ? 'failed'
          : 'pending';
    if (loaded.operation) {
      await addReceipt(tx, loaded.operation, {
        kind: obs.kind,
        outcome,
        source: obs.source,
        providerRef: result.id,
        providerEventId: obs.eventId ?? null,
        evidence: {
          subject: 'refund',
          status: result.status,
          amountMinor: minor(result.amountMinor),
          currency: result.currency,
        },
        observedAt: obs.occurredAt,
      });
    }
    if (outcome === 'pending') {
      const moved = await this.moveRefund(tx, loaded, 'provider_pending', {
        providerRefundRef: result.id,
        nextSyncAt: new Date(now.getTime() + backoffMs(1) * 4),
      });
      return moved ? 'applied' : 'stale';
    }
    if (outcome === 'failed') {
      const state = loaded.refund.state;
      await this.fail(tx, loaded, result.failureReason ?? result.status, obs);
      return state === loaded.refund.state ? 'stale' : 'applied';
    }
    const moved = await this.moveRefund(tx, loaded, 'provider_succeeded', {
      providerRefundRef: result.id,
      succeededAt: obs.occurredAt,
      nextSyncAt: null,
    });
    if (!moved) return 'stale';
    await tx
      .update(schema.payments)
      .set({
        refundedMinor: sql`${schema.payments.refundedMinor} + ${loaded.refund.amountMinor}`,
        updatedAt: now,
      })
      .where(eq(schema.payments.id, loaded.payment.id));
    await resolveExceptionsFor(tx, loaded.refund.id, now, [
      'refund_unknown',
      'reconcile_exhausted',
    ]);
    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'commerce',
      action: 'commerce.refund.succeeded',
      targetType: 'refund',
      targetId: toPublicId('refund', loaded.refund.id),
      outcome: 'success',
      occurredAt: now,
      data: {
        order: toPublicId('order', loaded.order.id),
        amountMinor: minor(loaded.refund.amountMinor),
        currency: loaded.refund.currency,
        providerRef: result.id,
      },
    });
    const [control] = await tx
      .select()
      .from(schema.conversationControls)
      .where(eq(schema.conversationControls.id, loaded.order.conversationId));
    const summary =
      `Refund sent: ${moneyText(loaded.refund.amountMinor, loaded.refund.currency)} for order ` +
      `${loaded.order.reference}. Banks usually take 5 to 10 days to show it.`;
    if (control) {
      await this.cards.enqueue(
        tx,
        loaded.refund.tenantId,
        control,
        receiptPublication(
          {
            kind: 'receipt',
            version: 1,
            receiptId: toPublicId('receipt', loaded.refund.id),
            actionId: toPublicId('refund', loaded.refund.id),
            outcome: 'completed',
            summary,
            reference: loaded.order.reference,
            occurredAt: obs.occurredAt.toISOString(),
          },
          loaded.merchant.displayName,
        ),
        `refund:${loaded.refund.id}:succeeded`,
      );
      await journalAction(this.journal, tx, effects, {
        tenantId: loaded.refund.tenantId,
        conversationId: control.id,
        actionId: toPublicId('refund', loaded.refund.id),
        outcome: 'completed',
        summary,
      });
    }
    return 'applied';
  }

  // ── Approve and reject (separation of duties) ───────────────────────────────────────────────

  async approve(principal: StaffPrincipal, refundPublicId: string): Promise<RefundView> {
    const refundId = fromPublicId('refund', refundPublicId);
    const effects = new Effects();
    const step = await this.staffTx(principal, async (tx) => {
      const loaded = await this.load(tx, refundId);
      requireBrand(
        principal,
        'commerce.read',
        loaded?.scope ?? null,
        this.options(),
        'Refund not found.',
      );
      if (!loaded?.scope) throw new AppError('NOT_FOUND');
      enforce(decide(principal, 'commerce.refunds.approve', loaded.scope, this.options()));
      if (loaded.refund.state !== 'awaiting_approval') {
        throw new AppError('VERSION_CONFLICT', { detail: 'This refund was already decided.' });
      }
      const now = this.clock();
      const separate = checkRefundApprover(
        storedPolicy(loaded.refund),
        loaded.refund.requestedBy,
        principal.staffMemberId,
      );
      if (!separate.ok) {
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', principal.staffMemberId),
          action: 'commerce.refund.approved',
          targetType: 'refund',
          targetId: refundPublicId,
          outcome: 'denied',
          reason: 'same_person',
          occurredAt: now,
          data: {},
        });
        return { kind: 'refused' as const };
      }
      // Rechecked at execution: another refund may have used up the amount meanwhile.
      const evaluation = evaluateRefund(
        storedPolicy(loaded.refund),
        loaded.merchant.capabilities as unknown as CommerceCapabilities,
        {
          amountMinor: loaded.refund.amountMinor,
          capturedMinor: loaded.payment.capturedMinor,
          refundedMinor: loaded.payment.refundedMinor,
          inFlightMinor: await this.inFlight(tx, loaded.payment.id, loaded.refund.id),
          paidAt: loaded.payment.capturedAt ?? now,
          now,
        },
      );
      if (!evaluation.eligible) {
        throw new AppError('VALIDATION_FAILED', {
          detail: INELIGIBLE[evaluation.reasons[0] ?? ''] ?? 'This refund is no longer allowed.',
        });
      }
      await this.moveRefund(tx, loaded, 'approve', {
        approvedBy: principal.staffMemberId,
        approvedAt: now,
      });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'commerce.refund.approved',
        targetType: 'refund',
        targetId: refundPublicId,
        outcome: 'success',
        occurredAt: now,
        data: {
          amountMinor: minor(loaded.refund.amountMinor),
          currency: loaded.refund.currency,
          requestedBy: toPublicId('staff', loaded.refund.requestedBy),
        },
      });
      return { kind: 'dispatch' as const, ...(await this.prepareDispatch(tx, loaded, principal)) };
    });
    if (step.kind === 'refused') throw new AppError('SEPARATE_APPROVER_REQUIRED');
    await this.dispatch(principal.tenantId, step.refundId, step.provider, step.request, effects);
    await effects.flush(this.journal);
    return this.staffTx(principal, async (tx) => {
      const loaded = await this.load(tx, step.refundId);
      if (!loaded) throw new AppError('NOT_FOUND');
      return this.view(tx, principal, loaded);
    });
  }

  async reject(
    principal: StaffPrincipal,
    refundPublicId: string,
    reason: string,
  ): Promise<RefundView> {
    return this.staffTx(principal, async (tx) => {
      const loaded = await this.load(tx, fromPublicId('refund', refundPublicId));
      requireBrand(
        principal,
        'commerce.read',
        loaded?.scope ?? null,
        this.options(),
        'Refund not found.',
      );
      if (!loaded?.scope) throw new AppError('NOT_FOUND');
      enforce(decide(principal, 'commerce.refunds.approve', loaded.scope, this.options()));
      const now = this.clock();
      const moved = await this.moveRefund(tx, loaded, 'reject', {
        rejectedBy: principal.staffMemberId,
        rejectedAt: now,
        rejectionReason: reason,
      });
      if (!moved)
        throw new AppError('VERSION_CONFLICT', { detail: 'This refund was already decided.' });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'commerce.refund.rejected',
        targetType: 'refund',
        targetId: refundPublicId,
        outcome: 'success',
        occurredAt: now,
        data: { reason },
      });
      return this.view(tx, principal, loaded);
    });
  }

  /** "Check refund status": asks the provider now; never sends the refund again blindly. */
  async refresh(principal: StaffPrincipal, refundPublicId: string): Promise<RefundView> {
    const refundId = fromPublicId('refund', refundPublicId);
    const plan = await this.staffTx(principal, async (tx) => {
      const loaded = await this.load(tx, refundId);
      requireBrand(
        principal,
        'commerce.read',
        loaded?.scope ?? null,
        this.options(),
        'Refund not found.',
      );
      if (!loaded) throw new AppError('NOT_FOUND');
      if (loaded.operation && ['dispatched', 'unknown'].includes(loaded.operation.state)) {
        return { kind: 'reconcile' as const, operationId: loaded.operation.id };
      }
      if (
        loaded.refund.providerRefundRef &&
        ['submitted', 'pending', 'unknown'].includes(loaded.refund.state)
      ) {
        return { kind: 'sync' as const };
      }
      return { kind: 'none' as const };
    });
    if (plan.kind === 'reconcile')
      await this.reconcileOperation(principal.tenantId, plan.operationId, 'staff');
    if (plan.kind === 'sync') await this.syncRefund(principal.tenantId, refundId, 'staff');
    return this.staffTx(principal, async (tx) => {
      const loaded = await this.load(tx, refundId);
      if (!loaded) throw new AppError('NOT_FOUND');
      return this.view(tx, principal, loaded);
    });
  }

  // ── Reconciliation (C09, C20) ───────────────────────────────────────────────────────────────

  /** A refund request whose answer was lost: find it by reference, or resend the same request. */
  async reconcileOperation(
    tenantId: string,
    operationId: string,
    trigger: 'worker' | 'staff',
  ): Promise<void> {
    const effects = new Effects();
    const now = this.clock();
    const plan = await withTenant(this.db, { tenantId, actorId: 'commerce' }, async (tx) => {
      const [op] = await tx
        .select()
        .from(schema.operations)
        .where(eq(schema.operations.id, operationId))
        .for('update');
      if (op?.kind !== 'commerce.refund.create' || !op.resourceId) return null;
      if (!['dispatched', 'unknown'].includes(op.state)) return null;
      const inFlight =
        op.state === 'dispatched' &&
        op.dispatchedAt !== null &&
        now.getTime() - op.dispatchedAt.getTime() <
          this.config.COMMERCE_PROVIDER_TIMEOUT_MS + 5_000;
      if (inFlight) return null;
      const loaded = await this.load(tx, op.resourceId);
      if (!loaded) return null;
      const attempts = op.reconcileAttempts + 1;
      await tx
        .update(schema.operations)
        .set({
          reconcileAttempts: attempts,
          nextReconcileAt: new Date(now.getTime() + backoffMs(attempts, 60 * 60_000)),
          updatedAt: now,
        })
        .where(eq(schema.operations.id, op.id));
      const stored = (op.detail as { request: Parameters<RefundsService['refundRequest']>[1] })
        .request;
      return {
        op: { ...op, reconcileAttempts: attempts },
        stored,
        provider: await this.providers.forConnection(tx, loaded.merchant),
      };
    });
    if (!plan) return;
    const { op, stored, provider } = plan;
    const source = trigger === 'worker' ? 'reconciler' : 'provider_api';
    let found: ProviderRefund | null = null;
    let failure: unknown = null;
    let resent = false;
    try {
      found = await provider.findRefund(toPublicId('operation', op.id), stored.paymentRef);
      const age = now.getTime() - op.createdAt.getTime();
      if (!found && op.attempts < 3 && age < 23 * 60 * 60_000) {
        // Not there: the same request under the same idempotency key cannot refund twice.
        resent = true;
        found = await provider.createRefund(this.refundRequest(op, stored));
      }
    } catch (error) {
      failure = error;
    }
    const observedAt = this.clock();
    await withTenant(this.db, { tenantId, actorId: 'commerce' }, async (tx) => {
      const loaded = await this.load(tx, op.resourceId as string);
      if (!loaded?.operation) return;
      const obs: Observation = { kind: 'reconcile', source, occurredAt: observedAt };
      if (resent) {
        await tx
          .update(schema.operations)
          .set({ attempts: loaded.operation.attempts + 1, updatedAt: observedAt })
          .where(eq(schema.operations.id, loaded.operation.id));
      }
      if (found) {
        await this.applyResult(tx, loaded, found, null, obs, effects);
        return;
      }
      if (failure && (!resent || outcomeUnknown(failure))) {
        await addReceipt(tx, loaded.operation, {
          kind: 'reconcile',
          outcome: 'unknown',
          source,
          evidence: { subject: 'refund', ...errorEvidence(failure) },
          observedAt,
        });
        if (op.reconcileAttempts >= 5) {
          await openException(tx, {
            tenantId,
            kind: 'refund_unknown',
            subjectType: 'refund',
            subjectId: loaded.refund.id,
            operationId: op.id,
            orderId: loaded.order.id,
            sourceState: 'unknown',
            nextSafeAction: 'check_status',
            evidence: { attempts: op.reconcileAttempts, lastError: errorCode(failure) },
            now: observedAt,
          });
        }
        return;
      }
      // Refused when resent, or not found and too old to resend: a person decides.
      await this.applyResult(tx, loaded, null, failure ?? new Error('not_found'), obs, effects);
    });
    await effects.flush(this.journal);
    if (failure) this.logger.warn(`refund ${op.id} reconcile: ${errorCode(failure)}`);
  }

  /** Asks the provider about a refund that is still pending. */
  async syncRefund(tenantId: string, refundId: string, trigger: 'worker' | 'staff'): Promise<void> {
    const effects = new Effects();
    const plan = await withTenant(this.db, { tenantId, actorId: 'commerce' }, async (tx) => {
      const loaded = await this.load(tx, refundId);
      if (!loaded?.refund.providerRefundRef) return null;
      if (!['submitted', 'pending', 'unknown'].includes(loaded.refund.state)) {
        await tx
          .update(schema.refunds)
          .set({ nextSyncAt: null })
          .where(eq(schema.refunds.id, refundId));
        return null;
      }
      return {
        ref: loaded.refund.providerRefundRef,
        provider: await this.providers.forConnection(tx, loaded.merchant),
      };
    });
    if (!plan) return;
    let result: ProviderRefund | null = null;
    let failure: unknown = null;
    try {
      result = await plan.provider.getRefund(plan.ref);
    } catch (error) {
      failure = error;
    }
    const observedAt = this.clock();
    await withTenant(this.db, { tenantId, actorId: 'commerce' }, async (tx) => {
      const loaded = await this.load(tx, refundId);
      if (!loaded) return;
      if (result) {
        await this.applyProviderRefund(
          tx,
          loaded,
          result,
          {
            kind: 'reconcile',
            source: trigger === 'worker' ? 'reconciler' : 'provider_api',
            occurredAt: observedAt,
          },
          effects,
        );
      }
      const [current] = await tx
        .select()
        .from(schema.refunds)
        .where(eq(schema.refunds.id, refundId));
      if (!current || !['submitted', 'pending', 'unknown'].includes(current.state)) return;
      const attempts = current.syncAttempts + 1;
      if (attempts >= SYNC_LIMIT) {
        await openException(tx, {
          tenantId,
          kind: 'reconcile_exhausted',
          subjectType: 'refund',
          subjectId: current.id,
          operationId: current.operationId,
          orderId: current.orderId,
          sourceState: result?.status ?? 'provider_unreachable',
          nextSafeAction: 'contact_provider',
          evidence: { attempts, providerRef: current.providerRefundRef },
          now: observedAt,
        });
      }
      await tx
        .update(schema.refunds)
        .set({
          syncAttempts: attempts,
          nextSyncAt: new Date(
            observedAt.getTime() + (attempts >= SYNC_LIMIT ? 60 * 60_000 : backoffMs(attempts)),
          ),
        })
        .where(eq(schema.refunds.id, current.id));
    });
    await effects.flush(this.journal);
    if (failure) this.logger.warn(`refund ${refundId} sync: ${errorCode(failure)}`);
  }

  /** For webhooks: the refund an event is about, loaded and locked. */
  async loadForEvent(
    tx: TenantTx,
    where: { providerRef: string | null; operationId: string | null },
  ): Promise<Loaded | null> {
    if (where.providerRef) {
      const [row] = await tx
        .select({ id: schema.refunds.id })
        .from(schema.refunds)
        .where(eq(schema.refunds.providerRefundRef, where.providerRef));
      if (row) return this.load(tx, row.id);
    }
    if (where.operationId) {
      const [op] = await tx
        .select()
        .from(schema.operations)
        .where(eq(schema.operations.id, where.operationId));
      if (op?.kind === 'commerce.refund.create' && op.resourceId)
        return this.load(tx, op.resourceId);
    }
    return null;
  }

  /** Webhook path: attach the provider's refund to its operation if needed, then apply it. */
  async applyEvent(
    tx: TenantTx,
    loaded: Loaded,
    result: ProviderRefund,
    obs: Observation,
    effects: Effects,
  ): Promise<'applied' | 'stale'> {
    if (loaded.operation && ['dispatched', 'unknown'].includes(loaded.operation.state)) {
      await this.applyResult(tx, loaded, result, null, obs, effects);
      return 'applied';
    }
    return this.applyProviderRefund(tx, loaded, result, obs, effects);
  }
}
