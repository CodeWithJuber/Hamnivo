import { type InvoicePaymentPort, manualCollection } from '@hamnivo/adapters/billing';
import { appendAudit, type Db, fromPublicId, schema, toPublicId, withTenant } from '@hamnivo/db';
import type { MeteredPriceJson } from '@hamnivo/db/schema';
import {
  canMoveInvoice,
  draftInvoice,
  InvalidPricingError,
  type InvoiceState,
  LIMIT_KEYS,
  LIMITS,
  type LimitKey,
  periodFromKey,
  validatePricing,
} from '@hamnivo/domain/billing';
import { and, asc, eq, gte, inArray, isNotNull, lt, ne, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import { applyPlan, NO_PLAN, planByKey, trialEnd } from './plans.js';

/**
 * Platform billing (A16): plans, assigning a plan to a tenant, invoices from metered usage and
 * their lifecycle (draft → issued → paid, or void). Run by Hamnivo's operator from the command
 * line (src/main.billing.ts), never from a tenant's request. Plans and invoices are global
 * platform data written through the platform database role; what concerns a tenant (its
 * entitlements and audit log) is written inside that tenant through the application role.
 */

const Count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Minor = z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'an amount in minor units, as a string');

export const PlanInput = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,39}$/)
    .refine((key) => key !== NO_PLAN, `"${NO_PLAN}" means no plan; choose another key`),
  name: z.string().trim().min(1).max(80),
  currency: z.string().regex(/^[A-Z]{3}$/),
  priceMinor: Minor,
  limits: z.partialRecord(z.enum(LIMIT_KEYS), Count.nullable()),
  metered: z
    .array(
      z.object({
        limit: z.enum(['conversations', 'aiReplies', 'aiTokens']),
        includedUnits: Count,
        unitPriceMinor: Minor,
        perUnits: z.int().min(1),
      }),
    )
    .default([]),
  /** Days of trial a workspace may get before it falls back to the free plan. */
  trialDays: z.int().min(0).max(365).default(0),
  /** The Stripe price (`price_…`) a Stripe subscription to this plan uses. */
  stripePriceId: z
    .string()
    .regex(/^price_[A-Za-z0-9_]+$/)
    .nullable()
    .default(null),
});
export type PlanInput = z.input<typeof PlanInput>;

export class BillingOperationError extends Error {
  override name = 'BillingOperationError';
}

type InvoiceRow = typeof schema.invoices.$inferSelect;

export interface BillingOperationsOptions {
  /** Connection as hamnivo_platform (plans, invoices, cross-tenant reads). */
  platform: Db;
  /** Connection as hamnivo_app (tenant entitlements and audit, inside the tenant). */
  app: Db;
  /** Who runs the operation, recorded in invoices and tenant audit logs. */
  operator: string;
  dueDays: number;
  payments?: InvoicePaymentPort;
  clock?: () => Date;
}

const toMetered = (metered: readonly MeteredPriceJson[]) =>
  metered.map((price) => ({ ...price, unitPriceMinor: BigInt(price.unitPriceMinor) }));

export class BillingOperations {
  private readonly payments: InvoicePaymentPort;
  private readonly clock: () => Date;

  constructor(private readonly options: BillingOperationsOptions) {
    this.payments = options.payments ?? manualCollection;
    this.clock = options.clock ?? (() => new Date());
  }

  private get platform() {
    return this.options.platform;
  }

  private audit(
    tenantId: string,
    action: string,
    target: { type: string; id: string },
    data: Record<string, unknown>,
  ) {
    return withTenant(
      this.options.app,
      { tenantId, actorId: `platform:${this.options.operator}` },
      (tx) =>
        appendAudit(tx, {
          actorType: 'platform',
          actorId: this.options.operator,
          action,
          targetType: target.type,
          targetId: target.id,
          outcome: 'success',
          data,
        }),
    );
  }

  async plans() {
    return this.platform.select().from(schema.plans).orderBy(asc(schema.plans.priceMinor));
  }

  /** Creates or updates a plan. Tenants keep the copy they were assigned until assigned again. */
  async setPlan(input: PlanInput) {
    const plan = PlanInput.parse(input);
    try {
      validatePricing({
        key: plan.key,
        name: plan.name,
        currency: plan.currency,
        priceMinor: BigInt(plan.priceMinor),
        metered: toMetered(plan.metered),
      });
    } catch (error) {
      if (error instanceof InvalidPricingError || error instanceof RangeError) {
        throw new BillingOperationError(error.message);
      }
      throw error;
    }
    const limits = Object.fromEntries(LIMIT_KEYS.map((key) => [key, plan.limits[key] ?? null]));
    const values = {
      key: plan.key,
      name: plan.name,
      currency: plan.currency,
      priceMinor: BigInt(plan.priceMinor),
      limits,
      metered: plan.metered,
      trialDays: plan.trialDays,
      stripePriceId: plan.stripePriceId,
    };
    const [row] = await this.platform
      .insert(schema.plans)
      .values(values)
      .onConflictDoUpdate({
        target: schema.plans.key,
        set: { ...values, status: 'active', updatedAt: this.clock() },
      })
      .returning();
    return row;
  }

  async tenantId(reference: string): Promise<string> {
    let id: string | null = null;
    try {
      id = fromPublicId('tenant', reference);
    } catch {
      id = null;
    }
    const t = schema.tenants;
    const [row] = await this.platform
      .select({ id: t.id })
      .from(t)
      .where(id ? eq(t.id, id) : eq(t.slug, reference));
    if (!row) throw new BillingOperationError(`No tenant ${reference}`);
    return row.id;
  }

  /**
   * Copies a plan into the tenant's entitlements (keeping the tenant's own budget, lowered to a
   * smaller plan's tokens). With `startTrial`, the plan is a trial that falls back to the free
   * plan after the plan's trial days.
   */
  async assignPlan(
    tenantReference: string,
    planKey: string,
    options: { startTrial?: boolean } = {},
  ) {
    const tenantId = await this.tenantId(tenantReference);
    const now = this.clock();
    const trialEndsAt = await withTenant(
      this.options.app,
      { tenantId, actorId: `platform:${this.options.operator}` },
      async (tx) => {
        const plan = await planByKey(tx, planKey);
        if (!plan) throw new BillingOperationError(`No active plan ${planKey}`);
        if (options.startTrial && plan.trialDays === 0) {
          throw new BillingOperationError(`The plan ${planKey} has no trial days.`);
        }
        const ends = options.startTrial ? trialEnd(plan, now) : null;
        await applyPlan(tx, tenantId, plan, {
          actorType: 'platform',
          actorId: this.options.operator,
          source: 'operator',
          trialEndsAt: ends,
          now,
          force: true,
        });
        return ends;
      },
    );
    return { tenantId, plan: planKey, trialEndsAt };
  }

  /** Usage of a tenant's period limits in one billing period, from the usage ledger. */
  private async periodUsage(tenantId: string, start: Date, end: Date) {
    const u = schema.usageEntries;
    const meters = LIMIT_KEYS.filter((key) => LIMITS[key].kind === 'period').flatMap(
      (key) => LIMITS[key].meters,
    );
    const rows = await this.platform
      .select({ meter: u.meter, total: sum(u.quantity).mapWith(Number) })
      .from(u)
      .where(
        and(
          eq(u.tenantId, tenantId),
          inArray(u.meter, meters),
          gte(u.occurredAt, start),
          lt(u.occurredAt, end),
        ),
      )
      .groupBy(u.meter);
    const byMeter = new Map(rows.map((row) => [row.meter, row.total ?? 0]));
    const usage: Partial<Record<LimitKey, number>> = {};
    for (const key of LIMIT_KEYS) {
      if (LIMITS[key].kind !== 'period') continue;
      usage[key] = LIMITS[key].meters.reduce(
        (total, meter) => total + (byMeter.get(meter) ?? 0),
        0,
      );
    }
    return usage;
  }

  /**
   * Drafts one invoice per tenant with a plan for a finished period: the plan price and metered
   * usage beyond what it includes. Only tenants whose plan was assigned before the period ended
   * are billed for it (a whole period, without proration). A tenant that already has a (not
   * voided) invoice for the period is skipped, so running this twice creates nothing new.
   */
  async generateInvoices(periodKey: string) {
    const period = periodFromKey(periodKey);
    if (period.end > this.clock()) {
      throw new BillingOperationError(`The period ${periodKey} is not over yet.`);
    }
    const e = schema.tenantEntitlements;
    const entitled = await this.platform.select().from(e).where(isNotNull(e.planKey));
    // Workspaces paying through Stripe or WHMCS are invoiced there, never twice.
    const elsewhere = new Set(
      (
        await this.platform
          .select({ tenantId: schema.billingAccounts.tenantId })
          .from(schema.billingAccounts)
          .where(inArray(schema.billingAccounts.provider, ['stripe', 'whmcs']))
      ).map((row) => row.tenantId),
    );
    const created: InvoiceRow[] = [];
    for (const entitlement of entitled) {
      if (!entitlement.planKey || !entitlement.planName || !entitlement.currency) continue;
      if (elsewhere.has(entitlement.tenantId)) continue;
      // A trial is free; it falls back to the free plan when it ends.
      if (entitlement.trialEndsAt) continue;
      // Assigned after the period: it had no plan then, so nothing is owed for it.
      if (!entitlement.assignedAt || entitlement.assignedAt >= period.end) continue;
      const [existing] = await this.platform
        .select({ id: schema.invoices.id })
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.tenantId, entitlement.tenantId),
            eq(schema.invoices.periodKey, period.key),
            ne(schema.invoices.status, 'void'),
          ),
        );
      if (existing) continue;
      const usage = await this.periodUsage(entitlement.tenantId, period.start, period.end);
      const draft = draftInvoice(
        {
          key: entitlement.planKey,
          name: entitlement.planName,
          currency: entitlement.currency,
          priceMinor: entitlement.priceMinor ?? 0n,
          metered: toMetered(entitlement.metered),
        },
        usage,
        period,
      );
      // Nothing is owed (the free plan without metered usage): no invoice.
      if (draft.totalMinor === 0n) continue;
      const [{ n } = { n: 0 }] = await this.platform
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.tenantId, entitlement.tenantId),
            eq(schema.invoices.periodKey, period.key),
          ),
        );
      const number = `HV-${period.key.replace('-', '')}-${entitlement.tenantId.replaceAll('-', '').slice(-8).toUpperCase()}${n > 0 ? `-${n + 1}` : ''}`;
      const [row] = await this.platform
        .insert(schema.invoices)
        .values({
          tenantId: entitlement.tenantId,
          number,
          periodKey: period.key,
          periodStart: period.start,
          periodEnd: period.end,
          planKey: entitlement.planKey,
          planName: entitlement.planName,
          currency: draft.currency,
          subtotalMinor: draft.subtotalMinor,
          totalMinor: draft.totalMinor,
          lines: draft.lines.map((line) => ({
            kind: line.kind,
            limit: line.limitKey,
            description: line.description,
            quantity: line.quantity,
            includedUnits: line.includedUnits,
            billableUnits: line.billableUnits,
            perUnits: line.perUnits,
            unitPriceMinor: line.unitPriceMinor.toString(),
            amountMinor: line.amountMinor.toString(),
          })),
          usage: Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, v ?? 0])),
          createdBy: this.options.operator,
        })
        .returning();
      if (!row) continue;
      created.push(row);
      await this.audit(
        entitlement.tenantId,
        'billing.invoice_drafted',
        { type: 'invoice', id: toPublicId('invoice', row.id) },
        { number, period: period.key, totalMinor: draft.totalMinor.toString() },
      );
    }
    return created;
  }

  private async invoice(reference: string): Promise<InvoiceRow> {
    let id: string | null = null;
    try {
      id = fromPublicId('invoice', reference);
    } catch {
      id = null;
    }
    const i = schema.invoices;
    const [row] = await this.platform
      .select()
      .from(i)
      .where(id ? eq(i.id, id) : eq(i.number, reference));
    if (!row) throw new BillingOperationError(`No invoice ${reference}`);
    return row;
  }

  private async move(
    row: InvoiceRow,
    to: InvoiceState,
    set: Partial<typeof schema.invoices.$inferInsert>,
  ): Promise<InvoiceRow> {
    if (!canMoveInvoice(row.status, to)) {
      throw new BillingOperationError(`An invoice that is ${row.status} cannot become ${to}.`);
    }
    const [updated] = await this.platform
      .update(schema.invoices)
      .set({ ...set, status: to, updatedAt: this.clock() })
      .where(and(eq(schema.invoices.id, row.id), eq(schema.invoices.status, row.status)))
      .returning();
    if (!updated) throw new BillingOperationError('The invoice changed meanwhile; try again.');
    return updated;
  }

  /** Issues a draft (it becomes visible to the tenant) and asks the payment port to collect. */
  async issue(reference: string) {
    const draft = await this.invoice(reference);
    const now = this.clock();
    const dueAt = new Date(now.getTime() + this.options.dueDays * 86_400_000);
    let row = await this.move(draft, 'issued', { issuedAt: now, dueAt });
    const outcome = await this.payments.collect({
      id: toPublicId('invoice', row.id),
      number: row.number,
      tenantId: toPublicId('tenant', row.tenantId),
      currency: row.currency,
      totalMinor: row.totalMinor,
      dueAt,
    });
    row = await this.applyOutcome(row, outcome);
    await this.audit(
      row.tenantId,
      'billing.invoice_issued',
      { type: 'invoice', id: toPublicId('invoice', row.id) },
      { number: row.number, dueAt: dueAt.toISOString(), payment: outcome.status },
    );
    return row;
  }

  private async applyOutcome(
    row: InvoiceRow,
    outcome: Awaited<ReturnType<InvoicePaymentPort['collect']>>,
  ): Promise<InvoiceRow> {
    const i = schema.invoices;
    switch (outcome.status) {
      case 'manual':
        return row;
      case 'paid':
        return this.move(row, 'paid', {
          paidAt: outcome.paidAt,
          paymentMethod: 'provider',
          paymentState: 'paid',
          paymentReference: outcome.providerRef,
        });
      case 'pending':
      case 'failed': {
        const [updated] = await this.platform
          .update(i)
          .set(
            outcome.status === 'pending'
              ? {
                  paymentMethod: 'provider',
                  paymentState: 'pending',
                  paymentReference: outcome.providerRef,
                  updatedAt: this.clock(),
                }
              : {
                  paymentMethod: 'provider',
                  paymentState: 'failed',
                  paymentFailedAt: this.clock(),
                  nextPaymentRetryAt: outcome.retryAt,
                  updatedAt: this.clock(),
                },
          )
          .where(eq(i.id, row.id))
          .returning();
        return updated ?? row;
      }
    }
  }

  /** Records a payment received (bank transfer, card terminal, provider dashboard). */
  async markPaid(reference: string, paymentReference: string | null) {
    const issued = await this.invoice(reference);
    const row = await this.move(issued, 'paid', {
      paidAt: this.clock(),
      paymentState: 'paid',
      paymentReference,
      nextPaymentRetryAt: null,
    });
    await this.audit(
      row.tenantId,
      'billing.invoice_paid',
      { type: 'invoice', id: toPublicId('invoice', row.id) },
      { number: row.number, reference: paymentReference },
    );
    return row;
  }

  /** Records a failed collection; the invoice stays issued (and overdue once past its date). */
  async recordPaymentFailure(reference: string, reason: string, retryAt: Date | null) {
    const row = await this.invoice(reference);
    if (row.status !== 'issued') {
      throw new BillingOperationError(
        `Only an issued invoice can fail to be paid (${row.status}).`,
      );
    }
    const [updated] = await this.platform
      .update(schema.invoices)
      .set({
        paymentState: 'failed',
        paymentFailedAt: this.clock(),
        nextPaymentRetryAt: retryAt,
        updatedAt: this.clock(),
      })
      .where(eq(schema.invoices.id, row.id))
      .returning();
    await this.audit(
      row.tenantId,
      'billing.payment_failed',
      { type: 'invoice', id: toPublicId('invoice', row.id) },
      { number: row.number, reason, retryAt: retryAt?.toISOString() ?? null },
    );
    return updated ?? row;
  }

  async voidInvoice(reference: string, reason: string) {
    const current = await this.invoice(reference);
    const row = await this.move(current, 'void', { voidedAt: this.clock(), voidReason: reason });
    await this.audit(
      row.tenantId,
      'billing.invoice_voided',
      { type: 'invoice', id: toPublicId('invoice', row.id) },
      { number: row.number, reason },
    );
    return row;
  }
}
