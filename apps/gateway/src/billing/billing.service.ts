import type {
  BillingOverview,
  Budget,
  Invoice,
  InvoiceSummary,
  SetBudgetRequest,
  UsageOverview,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantInvoiceRow,
  type TenantTx,
  tenantInvoices,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import {
  aiAllowance,
  LIMIT_KEYS,
  LIMITS,
  type LimitKey,
  usageStatus,
} from '@hamnivo/domain/billing';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { EntitlementsService, type Snapshot } from './entitlements.service.js';

type Usage = z.infer<typeof UsageOverview>;
type Summary = z.infer<typeof InvoiceSummary>;

const LIMIT_NAMES: Record<LimitKey, string> = {
  conversations: 'conversations',
  aiReplies: 'AI replies',
  aiTokens: 'AI tokens',
  knowledgeStorageBytes: 'knowledge storage',
  seats: 'seats',
  webhookEndpoints: 'webhook endpoints',
};

function summary(row: TenantInvoiceRow, now: Date): Summary {
  return {
    id: toPublicId('invoice', row.id),
    number: row.number,
    period: {
      key: row.periodKey,
      start: row.periodStart.toISOString(),
      end: row.periodEnd.toISOString(),
    },
    status: row.status,
    currency: row.currency,
    totalMinor: row.totalMinor.toString(),
    issuedAt: row.issuedAt?.toISOString() ?? null,
    dueAt: row.dueAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    overdue: row.status === 'issued' && row.dueAt !== null && row.dueAt < now,
    payment: {
      method: row.paymentMethod,
      state: row.paymentState,
      lastFailureAt: row.paymentFailedAt?.toISOString() ?? null,
      nextRetryAt: row.nextPaymentRetryAt?.toISOString() ?? null,
    },
  };
}

/**
 * The workspace's view of its plan (A15), usage against the limits (A08), its own budget and its
 * invoices (A16). Plans and invoices are set by Hamnivo's operator; the workspace sets only its
 * budget and alert thresholds.
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly entitlements: EntitlementsService,
  ) {}

  private usageView(snapshot: Snapshot, alerts: (typeof schema.usageAlerts.$inferSelect)[]): Usage {
    // Meters turn to "warning" at the lowest alert threshold below 100% (80% by default).
    const early = snapshot.thresholds.filter((t) => t > 0 && t < 100);
    const warningAt = early.length > 0 ? Math.min(...early) : 80;
    const ai = aiAllowance({
      limits: snapshot.limits,
      budgetTokens: snapshot.budgetTokens,
      repliesUsed: snapshot.usage.aiReplies,
      tokensUsed: snapshot.usage.aiTokens,
    });
    return {
      period: {
        key: snapshot.period.key,
        start: snapshot.period.start.toISOString(),
        end: snapshot.period.end.toISOString(),
      },
      measuredAt: this.clock().toISOString(),
      limited: snapshot.limited,
      meters: LIMIT_KEYS.map((key) => {
        const status = usageStatus(snapshot.usage[key], snapshot.limits[key], warningAt);
        return {
          limit: key,
          kind: LIMITS[key].kind,
          unit: LIMITS[key].unit,
          used: status.used,
          max: status.limit,
          remaining: status.remaining,
          state: status.state,
        };
      }),
      ai: { allowed: ai.allowed, reason: ai.allowed ? null : ai.reason },
      budget: this.budgetView(snapshot.entitlement),
      alerts: alerts.map((alert) => ({
        limit: alert.limitKey,
        source: alert.source,
        threshold: alert.threshold,
        used: alert.used,
        max: alert.max,
        at: alert.createdAt.toISOString(),
      })),
    };
  }

  private budgetView(row: Snapshot['entitlement']): z.infer<typeof Budget> {
    return {
      aiTokens: row?.aiTokenBudget ?? null,
      alertThresholds: row?.alertThresholds ?? [80, 100],
      updatedAt: row?.budgetUpdatedAt?.toISOString() ?? null,
    };
  }

  private async usageIn(tx: TenantTx): Promise<Usage> {
    const snapshot = await this.entitlements.snapshot(tx);
    const alerts = await tx
      .select()
      .from(schema.usageAlerts)
      .where(eq(schema.usageAlerts.periodKey, snapshot.period.key))
      .orderBy(desc(schema.usageAlerts.createdAt));
    return this.usageView(snapshot, alerts);
  }

  async usage(tenantId: string): Promise<Usage> {
    return withTenant(this.db, { tenantId }, (tx) => this.usageIn(tx));
  }

  async overview(tenantId: string): Promise<z.infer<typeof BillingOverview>> {
    return withTenant(this.db, { tenantId }, async (tx) => {
      const usage = await this.usageIn(tx);
      const entitlement = await this.entitlements.entitlement(tx);
      const now = this.clock();
      const invoices = (await tenantInvoices(tx)).map((row) => summary(row, now));
      const plan =
        entitlement?.planKey && entitlement.planName && entitlement.currency
          ? {
              key: entitlement.planKey,
              name: entitlement.planName,
              currency: entitlement.currency,
              priceMinor: (entitlement.priceMinor ?? 0n).toString(),
              limits: Object.fromEntries(usage.meters.map((m) => [m.limit, m.max])) as Record<
                LimitKey,
                number | null
              >,
              metered: entitlement.metered.map((price) => ({
                limit: price.limit,
                includedUnits: price.includedUnits,
                unitPriceMinor: price.unitPriceMinor,
                perUnits: price.perUnits,
              })),
            }
          : null;
      return {
        plan,
        standing: !plan ? 'no_plan' : invoices.some((i) => i.overdue) ? 'past_due' : 'active',
        usage,
        invoices,
      };
    });
  }

  async setBudget(
    principal: StaffPrincipal,
    input: z.output<typeof SetBudgetRequest>,
  ): Promise<z.infer<typeof Budget>> {
    const thresholds = [...new Set(input.alertThresholds)].sort((a, b) => a - b);
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      async (tx) => {
        const snapshot = await this.entitlements.snapshot(tx, []);
        const planTokens = snapshot.limits.aiTokens;
        if (input.aiTokens !== null && planTokens !== null && input.aiTokens > planTokens) {
          throw new AppError('VALIDATION_FAILED', {
            fields: [
              {
                path: 'aiTokens',
                message: `The budget must stay within the plan's ${planTokens} ${LIMIT_NAMES.aiTokens} a month.`,
              },
            ],
          });
        }
        const now = this.clock();
        const values = {
          aiTokenBudget: input.aiTokens,
          alertThresholds: thresholds,
          budgetUpdatedAt: now,
          budgetUpdatedBy: principal.staffMemberId,
          updatedAt: now,
        };
        if (snapshot.entitlement) {
          await tx
            .update(schema.tenantEntitlements)
            .set(values)
            .where(eq(schema.tenantEntitlements.id, snapshot.entitlement.id));
        } else {
          await tx
            .insert(schema.tenantEntitlements)
            .values({ tenantId: principal.tenantId, ...values });
        }
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', principal.staffMemberId),
          action: 'billing.budget_updated',
          targetType: 'tenant',
          targetId: toPublicId('tenant', principal.tenantId),
          outcome: 'success',
          data: { aiTokens: input.aiTokens, alertThresholds: thresholds },
        });
        const updated = await this.entitlements.entitlement(tx);
        return this.budgetView(updated);
      },
    );
  }

  async invoices(tenantId: string): Promise<Summary[]> {
    return withTenant(this.db, { tenantId }, async (tx) => {
      const now = this.clock();
      return (await tenantInvoices(tx)).map((row) => summary(row, now));
    });
  }

  async invoice(tenantId: string, publicId: string): Promise<z.infer<typeof Invoice>> {
    let id: string;
    try {
      id = fromPublicId('invoice', publicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Invoice not found.' });
    }
    return withTenant(this.db, { tenantId }, async (tx) => {
      const [row] = await tenantInvoices(tx, id);
      if (!row) throw new AppError('NOT_FOUND', { detail: 'Invoice not found.' });
      return {
        ...summary(row, this.clock()),
        planName: row.planName,
        lines: row.lines as z.infer<typeof Invoice>['lines'],
        subtotalMinor: row.subtotalMinor.toString(),
        usage: row.usage,
      };
    });
  }
}
