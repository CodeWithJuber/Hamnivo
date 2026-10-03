import { createHash, randomUUID } from 'node:crypto';
import {
  type BillingEvent,
  type BillingProvider,
  BillingProviderError,
  BillingWebhookSignatureError,
  type ProviderInvoice,
  type ProviderSubscription,
} from '@hamnivo/adapters/billing';
import type {
  BillingSubscription,
  ProviderInvoice as ProviderInvoiceView,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  InvalidPublicIdError,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation } from '../common/pg-error.js';
import type { AppConfig } from '../config.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { type AccountRow, accountState, billingAccount, updateAccount } from './accounts.js';
import {
  type AccountState,
  afterPayment,
  afterPaymentFailure,
  afterSubscription,
} from './lifecycle.js';
import { BILLING_NOTICE_TOPIC, type BillingNotice } from './notices.js';
import { activePlans, applyPlan, FREE_PLAN, type PlanRow } from './plans.js';
import { BILLING_PROVIDER } from './provider.js';

type SubscriptionView = z.infer<typeof BillingSubscription>;
type InvoiceView = z.infer<typeof ProviderInvoiceView>;

/** Which plan a provider subscription pays for: by its price, else by the plan it started on. */
export function planForSubscription(
  plans: readonly PlanRow[],
  subscription: Pick<ProviderSubscription, 'priceRef' | 'planKey'>,
): PlanRow | null {
  return (
    (subscription.priceRef && plans.find((p) => p.stripePriceId === subscription.priceRef)) ||
    (subscription.planKey && plans.find((p) => p.key === subscription.planKey)) ||
    null
  );
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Live subscriptions: a new checkout would start a second one. */
const LIVE = new Set(['trialing', 'active', 'past_due', 'incomplete']);

function invoiceView(invoice: ProviderInvoice): InvoiceView {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency,
    totalMinor: invoice.totalMinor.toString(),
    createdAt: invoice.createdAt.toISOString(),
    paidAt: iso(invoice.paidAt),
    url: invoice.url,
    pdfUrl: invoice.pdfUrl,
  };
}

/**
 * Subscriptions through the server's billing provider (A16): what Studio shows on Plan & billing,
 * Upgrade (the provider's checkout), Manage (its portal or client area), its invoices, and the
 * provider's webhook events turned into plans. Every event is applied once (billing_events), in
 * the workspace's transaction with its billing account locked, and a subscription's state is read
 * from the provider when the event arrives, so events applied in any order end in the same state.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  private canCheckout(account: AccountRow): boolean {
    return this.provider.capabilities().checkout && account.provider !== 'whmcs';
  }

  private canManage(account: AccountRow): boolean {
    if (!this.provider.capabilities().portal) return false;
    return this.provider.name === 'whmcs' ? true : account.customerRef !== null;
  }

  async subscription(tenantId: string): Promise<SubscriptionView> {
    return withTenant(this.db, { tenantId }, async (tx) => {
      const account = await billingAccount(tx, tenantId);
      const [entitlement] = await tx.select().from(schema.tenantEntitlements).limit(1);
      const plans = await activePlans(tx);
      const checkout = this.canCheckout(account);
      return {
        provider: account.provider,
        status: account.subscriptionStatus,
        plan:
          entitlement?.planKey && entitlement.planName
            ? { key: entitlement.planKey, name: entitlement.planName }
            : null,
        trialEndsAt: iso(entitlement?.trialEndsAt ?? null),
        graceEndsAt: iso(account.graceEndsAt),
        paymentFailedAt: iso(account.paymentFailedAt),
        currentPeriodEnd: iso(account.currentPeriodEnd),
        cancelAtPeriodEnd: account.cancelAtPeriodEnd,
        canUpgrade: checkout && !LIVE.has(account.subscriptionStatus),
        canManage: this.canManage(account),
        plans: plans.map((plan) => ({
          key: plan.key,
          name: plan.name,
          currency: plan.currency,
          priceMinor: plan.priceMinor.toString(),
          limits: Object.fromEntries(
            Object.entries(plan.limits).map(([key, value]) => [key, value ?? null]),
          ) as SubscriptionView['plans'][number]['limits'],
          trialDays: plan.trialDays,
          purchasable: checkout && plan.stripePriceId !== null,
          current: plan.key === entitlement?.planKey,
        })),
      };
    });
  }

  private studioUrl(path: string): string {
    return `${this.config.PUBLIC_CONSOLE_ORIGIN.replace(/\/$/, '')}${path}`;
  }

  private providerError(error: unknown): never {
    if (error instanceof BillingProviderError) {
      throw new AppError(error.retryable ? 'PROVIDER_UNAVAILABLE' : 'VALIDATION_FAILED', {
        detail: error.retryable
          ? 'The billing provider could not be reached. Try again in a moment.'
          : 'The billing provider refused this request.',
        internal: { kind: error.kind, code: error.code },
      });
    }
    throw error;
  }

  /**
   * Opens the provider's checkout for a plan (Upgrade). The workspace's customer is created once
   * (an idempotency key per workspace) and remembered; a workspace with a live subscription is
   * sent to Manage instead, so it can never pay for two.
   */
  async startCheckout(
    principal: StaffPrincipal,
    planKey: string,
    idempotencyKey: string | undefined,
  ): Promise<{ url: string }> {
    const tenantId = principal.tenantId;
    const tenantRef = toPublicId('tenant', tenantId);
    const context = await withTenant(this.db, { tenantId }, async (tx) => {
      const account = await billingAccount(tx, tenantId);
      const plan = (await activePlans(tx)).find((p) => p.key === planKey) ?? null;
      const [tenant] = await tx.select({ name: schema.tenants.name }).from(schema.tenants);
      return { account, plan, tenantName: tenant?.name ?? 'Hamnivo workspace' };
    });
    if (!this.canCheckout(context.account)) {
      throw new AppError('FEATURE_DISABLED', {
        detail:
          this.provider.name === 'whmcs' || context.account.provider === 'whmcs'
            ? 'Plans are bought in your provider’s client area.'
            : 'Plans cannot be bought online on this server. Ask your provider.',
      });
    }
    if (LIVE.has(context.account.subscriptionStatus)) {
      throw new AppError('VERSION_CONFLICT', {
        detail: 'This workspace already has a subscription. Use Manage to change it.',
      });
    }
    if (!context.plan?.stripePriceId) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'planKey', message: 'This plan cannot be bought online.' }],
      });
    }
    try {
      let customerRef = context.account.customerRef;
      if (!customerRef) {
        ({ customerRef } = await this.provider.createCustomer({
          tenantRef,
          name: context.tenantName,
          email: null,
          idempotencyKey: `hv:billing:customer:${tenantId}`,
        }));
        const stored = customerRef;
        await withTenant(this.db, { tenantId, actorId: 'billing' }, async (tx) => {
          const account = await billingAccount(tx, tenantId, { lock: true });
          if (!account.customerRef) {
            await updateAccount(tx, account, { provider: 'stripe', customerRef: stored });
          }
        });
      }
      const checkout = await this.provider.createCheckout({
        tenantRef,
        customerRef,
        planKey: context.plan.key,
        priceRef: context.plan.stripePriceId,
        trialDays: 0,
        successUrl: this.studioUrl('/settings/billing?checkout=done'),
        cancelUrl: this.studioUrl('/settings/billing?checkout=cancelled'),
        // Stripe keeps keys up to 255 characters: the client's key is shortened to a digest.
        idempotencyKey: `hv:billing:checkout:${tenantId}:${context.plan.key}:${createHash('sha256')
          .update(idempotencyKey ?? randomUUID())
          .digest('hex')
          .slice(0, 32)}`,
      });
      return { url: checkout.url };
    } catch (error) {
      return this.providerError(error);
    }
  }

  /** Opens the provider's portal (Stripe) or client area (WHMCS) (Manage). */
  async openPortal(principal: StaffPrincipal): Promise<{ url: string }> {
    const account = await withTenant(this.db, { tenantId: principal.tenantId }, (tx) =>
      billingAccount(tx, principal.tenantId),
    );
    if (!this.canManage(account)) {
      throw new AppError('FEATURE_DISABLED', {
        detail: 'There is nothing to manage here yet: this workspace has no paid plan.',
      });
    }
    try {
      return await this.provider.createPortal({
        customerRef: account.customerRef ?? '',
        returnUrl: this.studioUrl('/settings/billing'),
      });
    } catch (error) {
      return this.providerError(error);
    }
  }

  /** The provider's invoices for the workspace, newest first (empty without a customer). */
  async providerInvoices(tenantId: string): Promise<InvoiceView[]> {
    const account = await withTenant(this.db, { tenantId }, (tx) => billingAccount(tx, tenantId));
    if (!account.customerRef || !this.provider.capabilities().invoices) return [];
    try {
      return (await this.provider.listInvoices(account.customerRef, 24)).map(invoiceView);
    } catch (error) {
      return this.providerError(error);
    }
  }

  // ── Webhooks ────────────────────────────────────────────────────────────────────────────────

  /** A Stripe Billing webhook: verified, then applied once. Answers only after it is applied. */
  async receiveStripe(
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    if (this.provider.name !== 'stripe' || !this.config.STRIPE_WEBHOOK_SECRET) {
      throw new AppError('NOT_FOUND');
    }
    let event: BillingEvent;
    try {
      event = this.provider.verifyWebhook(
        rawBody ?? Buffer.alloc(0),
        headers,
        this.config.STRIPE_WEBHOOK_SECRET,
        this.clock(),
      );
    } catch (error) {
      if (error instanceof BillingWebhookSignatureError) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'The webhook signature is not valid.',
          reason: `signature_${error.reason}`,
        });
      }
      throw error;
    }
    await this.apply(event);
  }

  private async tenantFor(event: BillingEvent): Promise<string | null> {
    if (event.kind === 'ignored') return null;
    const refs =
      event.kind === 'checkout.completed'
        ? {
            tenant: event.tenantRef,
            customer: event.customerRef,
            subscription: event.subscriptionRef,
          }
        : event.kind === 'invoice.paid' || event.kind === 'invoice.payment_failed'
          ? {
              tenant: event.invoice.tenantRef,
              customer: event.invoice.customerRef,
              subscription: event.invoice.subscriptionRef,
            }
          : {
              tenant: event.subscription.tenantRef,
              customer: event.subscription.customerRef,
              subscription: event.subscription.ref,
            };
    if (refs.tenant) {
      try {
        return fromPublicId('tenant', refs.tenant);
      } catch (error) {
        if (!(error instanceof InvalidPublicIdError)) throw error;
      }
    }
    const { rows } = await this.db.execute<{ tenant_id: string }>(
      sql`select tenant_id from app.billing_account_tenant('stripe', ${refs.customer}, ${refs.subscription})`,
    );
    return rows[0]?.tenant_id ?? null;
  }

  /** Applies one provider event to its workspace, once. Exposed for tests and replays. */
  async apply(event: BillingEvent): Promise<'applied' | 'stale' | 'ignored' | 'duplicate'> {
    if (event.kind === 'ignored') return 'ignored';
    const tenantId = await this.tenantFor(event);
    if (!tenantId) {
      this.logger.warn(`billing event ${event.id} (${event.providerType}) names no workspace`);
      return 'ignored';
    }
    // The subscription as the provider sees it now (outside the transaction: a network call).
    let latest: ProviderSubscription | null = null;
    if (event.kind === 'subscription.changed' || event.kind === 'subscription.deleted') {
      try {
        latest = (await this.provider.getSubscription(event.subscription.ref)) ?? {
          ...event.subscription,
          state: 'canceled',
        };
      } catch (error) {
        if (error instanceof BillingProviderError && error.retryable) {
          // Stripe sends the event again later.
          throw new AppError('PROVIDER_UNAVAILABLE', { detail: 'Stripe could not be reached.' });
        }
        throw error;
      }
    }
    try {
      return await withTenant(this.db, { tenantId, actorId: 'billing' }, async (tx) => {
        const [tenant] = await tx.select({ id: schema.tenants.id }).from(schema.tenants);
        if (!tenant) return 'ignored';
        const account = await billingAccount(tx, tenantId, { lock: true });
        const [seen] = await tx
          .select({ eventId: schema.billingEvents.eventId })
          .from(schema.billingEvents)
          .where(
            and(
              eq(schema.billingEvents.provider, 'stripe'),
              eq(schema.billingEvents.eventId, event.id),
            ),
          );
        if (seen) return 'duplicate';
        const outcome = await this.applyIn(tx, tenantId, account, event, latest);
        await tx.insert(schema.billingEvents).values({
          tenantId,
          provider: 'stripe',
          eventId: event.id,
          type: event.providerType,
          occurredAt: event.occurredAt,
          outcome: outcome.outcome,
          detail: outcome.detail,
        });
        return outcome.outcome;
      });
    } catch (error) {
      // The same event delivered twice at once: the other delivery applied it.
      if (isUniqueViolation(error, 'billing_events_pkey')) return 'duplicate';
      throw error;
    }
  }

  private async applyIn(
    tx: TenantTx,
    tenantId: string,
    account: AccountRow,
    event: Exclude<BillingEvent, { kind: 'ignored' }>,
    latest: ProviderSubscription | null,
  ): Promise<{ outcome: 'applied' | 'stale' | 'ignored'; detail: Record<string, unknown> }> {
    const now = this.clock();
    const grace = this.config.BILLING_GRACE_DAYS;
    const owns = (customerRef: string | null) =>
      !account.customerRef || !customerRef || account.customerRef === customerRef;
    switch (event.kind) {
      case 'checkout.completed': {
        if (!owns(event.customerRef)) return { outcome: 'ignored', detail: { reason: 'customer' } };
        await updateAccount(tx, account, {
          provider: 'stripe',
          customerRef: account.customerRef ?? event.customerRef,
          subscriptionRef: event.subscriptionRef ?? account.subscriptionRef,
        });
        return { outcome: 'applied', detail: { subscription: event.subscriptionRef } };
      }
      case 'subscription.changed':
      case 'subscription.deleted': {
        const subscription = latest ?? event.subscription;
        if (!owns(subscription.customerRef)) {
          return { outcome: 'ignored', detail: { reason: 'customer' } };
        }
        // An older subscription of this workspace (ended before the current one started).
        if (account.subscriptionRef && account.subscriptionRef !== subscription.ref) {
          const current = LIVE.has(account.subscriptionStatus);
          if (current || !LIVE.has(subscription.state)) {
            return { outcome: 'stale', detail: { subscription: subscription.ref } };
          }
        }
        const plans = await activePlans(tx);
        const plan = planForSubscription(plans, subscription);
        const next = afterSubscription(
          accountState(account),
          { state: subscription.state, planKey: plan?.key ?? null },
          now,
          grace,
        );
        await updateAccount(tx, account, {
          provider: 'stripe',
          customerRef: account.customerRef ?? subscription.customerRef,
          subscriptionRef: subscription.ref,
          ...next.account,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          providerUpdatedAt: event.occurredAt,
        });
        const changed = await this.entitle(tx, tenantId, next.entitlement, plan, plans, now);
        await appendAudit(tx, {
          actorType: 'system',
          actorId: 'billing',
          action: 'billing.subscription_changed',
          targetType: 'tenant',
          targetId: toPublicId('tenant', tenantId),
          outcome: 'success',
          data: {
            provider: 'stripe',
            event: event.id,
            subscription: subscription.ref,
            status: subscription.state,
            plan: plan?.key ?? null,
            entitlement: next.entitlement,
            planChanged: changed,
            graceEndsAt: next.account.graceEndsAt?.toISOString() ?? null,
          },
        });
        return {
          outcome: 'applied',
          detail: {
            status: subscription.state,
            plan: plan?.key ?? null,
            entitlement: next.entitlement,
          },
        };
      }
      case 'invoice.paid': {
        if (!owns(event.invoice.customerRef))
          return { outcome: 'ignored', detail: { reason: 'customer' } };
        const next = afterPayment(accountState(account));
        await updateAccount(tx, account, this.accountValues(next));
        await this.notify(tx, tenantId, {
          kind: 'receipt',
          invoiceId: event.invoice.id,
          number: event.invoice.number,
          amountMinor: event.invoice.amountPaidMinor.toString(),
          currency: event.invoice.currency,
          paidAt: (event.invoice.paidAt ?? event.occurredAt).toISOString(),
          url: event.invoice.url,
        });
        return { outcome: 'applied', detail: { invoice: event.invoice.id } };
      }
      case 'invoice.payment_failed': {
        if (!owns(event.invoice.customerRef))
          return { outcome: 'ignored', detail: { reason: 'customer' } };
        const next = afterPaymentFailure(accountState(account), event.occurredAt, now, grace);
        await updateAccount(tx, account, this.accountValues(next));
        await appendAudit(tx, {
          actorType: 'system',
          actorId: 'billing',
          action: 'billing.payment_failed',
          targetType: 'tenant',
          targetId: toPublicId('tenant', tenantId),
          outcome: 'success',
          data: {
            provider: 'stripe',
            invoice: event.invoice.id,
            attempt: event.invoice.attemptCount,
            graceEndsAt: next.graceEndsAt?.toISOString() ?? null,
          },
        });
        await this.notify(tx, tenantId, {
          kind: 'payment_failed',
          invoiceId: event.invoice.id,
          number: event.invoice.number,
          amountMinor: event.invoice.totalMinor.toString(),
          currency: event.invoice.currency,
          graceEndsAt: next.graceEndsAt?.toISOString() ?? null,
          url: event.invoice.url,
        });
        return {
          outcome: 'applied',
          detail: {
            invoice: event.invoice.id,
            graceEndsAt: next.graceEndsAt?.toISOString() ?? null,
          },
        };
      }
    }
  }

  private accountValues(state: AccountState) {
    return { paymentFailedAt: state.paymentFailedAt, graceEndsAt: state.graceEndsAt };
  }

  /** Gives the workspace the subscribed plan, or the free plan, as the state decided. */
  private async entitle(
    tx: TenantTx,
    tenantId: string,
    action: 'plan' | 'keep' | 'fallback',
    plan: PlanRow | null,
    plans: readonly PlanRow[],
    now: Date,
  ): Promise<boolean> {
    if (action === 'keep') return false;
    const target = action === 'plan' ? plan : (plans.find((p) => p.key === FREE_PLAN) ?? null);
    if (!target) {
      this.logger.error(
        `billing: no plan to give ${toPublicId('tenant', tenantId)} (${action === 'plan' ? 'unknown price' : `no ${FREE_PLAN} plan`})`,
      );
      return false;
    }
    const { changed } = await applyPlan(tx, tenantId, target, {
      actorType: 'system',
      actorId: 'billing',
      source: action === 'plan' ? 'stripe' : 'subscription_ended',
      trialEndsAt: null,
      now,
    });
    return changed;
  }

  private notify(tx: TenantTx, tenantId: string, notice: BillingNotice) {
    return enqueueOutbox(tx, tenantId, {
      topic: BILLING_NOTICE_TOPIC,
      aggregateType: 'billing_notice',
      aggregateId: notice.invoiceId,
      payload: { ...notice },
    });
  }
}
