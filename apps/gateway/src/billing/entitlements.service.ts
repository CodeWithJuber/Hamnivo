import { appendAudit, type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import {
  type AiAllowance,
  aiAllowance,
  type BillingPeriod,
  LIMIT_KEYS,
  LIMITS,
  type LimitKey,
  type PlanLimits,
  parseLimits,
  periodOf,
  thresholdsReached,
  UNLIMITED,
  withinLimit,
} from '@hamnivo/domain/billing';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, gte, inArray, lt, sql, sum } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import { planLimitError } from '../common/plan-limit.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';

export type EntitlementRow = typeof schema.tenantEntitlements.$inferSelect;

/** Where a tenant stands this period: its plan limits, budget and usage. */
export interface Snapshot {
  period: BillingPeriod;
  entitlement: EntitlementRow | null;
  /** A plan is assigned; without one nothing is limited by a plan. */
  limited: boolean;
  limits: PlanLimits;
  budgetTokens: number | null;
  thresholds: number[];
  /** Usage of the limits measured for this snapshot (others read 0). */
  usage: Record<LimitKey, number>;
  measured: readonly LimitKey[];
}

const PERIOD_KEYS = LIMIT_KEYS.filter((key) => LIMITS[key].kind === 'period');

/**
 * Plan limits and the workspace's own budget (A08, A15). Usage is read live from the usage ledger
 * (period limits) or measured when needed (capacity); the database guards seats and knowledge
 * storage itself, so concurrent requests cannot both take the last unit.
 */
@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async entitlement(tx: TenantTx): Promise<EntitlementRow | null> {
    const [row] = await tx.select().from(schema.tenantEntitlements).limit(1);
    return row ?? null;
  }

  /** Sums of the period meters for each period limit. */
  async periodUsage(
    tx: TenantTx,
    period: BillingPeriod,
    keys: readonly LimitKey[] = PERIOD_KEYS,
  ): Promise<Partial<Record<LimitKey, number>>> {
    const wanted = keys.filter((key) => LIMITS[key].kind === 'period');
    const meters = [...new Set(wanted.flatMap((key) => LIMITS[key].meters))];
    if (meters.length === 0) return {};
    const u = schema.usageEntries;
    const rows = await tx
      .select({ meter: u.meter, total: sum(u.quantity).mapWith(Number) })
      .from(u)
      .where(
        and(
          inArray(u.meter, meters),
          gte(u.occurredAt, period.start),
          lt(u.occurredAt, period.end),
        ),
      )
      .groupBy(u.meter);
    const byMeter = new Map(rows.map((row) => [row.meter, row.total ?? 0]));
    return Object.fromEntries(
      wanted.map((key) => [
        key,
        LIMITS[key].meters.reduce((total, meter) => total + (byMeter.get(meter) ?? 0), 0),
      ]),
    );
  }

  /** Capacity in use now, counted the way the database guards count it. */
  async capacityUsage(tx: TenantTx, key: LimitKey): Promise<number> {
    switch (key) {
      case 'seats': {
        const [members] = await tx
          .select({ n: count() })
          .from(schema.staffMembers)
          .where(inArray(schema.staffMembers.status, ['active', 'invited']));
        const [invited] = await tx
          .select({ n: count() })
          .from(schema.invitations)
          .where(
            and(
              sql`${schema.invitations.status} = 'pending'`,
              sql`${schema.invitations.expiresAt} > now()`,
            ),
          );
        return (members?.n ?? 0) + (invited?.n ?? 0);
      }
      case 'knowledgeStorageBytes': {
        const v = schema.documentVersions;
        const [row] = await tx
          .select({ bytes: sum(v.byteSize).mapWith(Number) })
          .from(v)
          .where(inArray(v.state, ['queued', 'processing', 'ready']));
        return row?.bytes ?? 0;
      }
      case 'webhookEndpoints': {
        const [row] = await tx.select({ n: count() }).from(schema.webhookEndpoints);
        return row?.n ?? 0;
      }
      default:
        return 0;
    }
  }

  async snapshot(tx: TenantTx, keys: readonly LimitKey[] = LIMIT_KEYS): Promise<Snapshot> {
    const period = periodOf(this.clock());
    const entitlement = await this.entitlement(tx);
    const limited = Boolean(entitlement?.planKey);
    const usage = Object.fromEntries(LIMIT_KEYS.map((key) => [key, 0])) as Record<LimitKey, number>;
    Object.assign(usage, await this.periodUsage(tx, period, keys));
    for (const key of keys) {
      if (LIMITS[key].kind === 'capacity') usage[key] = await this.capacityUsage(tx, key);
    }
    return {
      period,
      entitlement,
      limited,
      limits: limited ? parseLimits(entitlement?.limits) : { ...UNLIMITED },
      budgetTokens: entitlement?.aiTokenBudget ?? null,
      thresholds: entitlement?.alertThresholds ?? [80, 100],
      usage,
      measured: keys,
    };
  }

  /**
   * Records alerts for thresholds the period usage has reached (once per limit, threshold and
   * period), audits them and announces them to webhook endpoints subscribed to
   * `usage.threshold_reached`.
   */
  async raiseAlerts(tx: TenantTx, tenantId: string, snapshot: Snapshot): Promise<void> {
    const candidates: { limit: LimitKey; source: 'plan' | 'budget'; max: number }[] = [];
    const measured = (key: LimitKey) => snapshot.measured.includes(key);
    // A limit of 0 means "not included", which needs no alert.
    for (const key of PERIOD_KEYS) {
      const max = snapshot.limits[key];
      if (max !== null && max > 0 && measured(key)) {
        candidates.push({ limit: key, source: 'plan', max });
      }
    }
    if (snapshot.budgetTokens !== null && snapshot.budgetTokens > 0 && measured('aiTokens')) {
      candidates.push({ limit: 'aiTokens', source: 'budget', max: snapshot.budgetTokens });
    }
    const now = this.clock();
    for (const candidate of candidates) {
      const used = snapshot.usage[candidate.limit];
      for (const threshold of thresholdsReached(used, candidate.max, snapshot.thresholds)) {
        const [alert] = await tx
          .insert(schema.usageAlerts)
          .values({
            tenantId,
            limitKey: candidate.limit,
            source: candidate.source,
            threshold,
            periodKey: snapshot.period.key,
            used,
            max: candidate.max,
          })
          .onConflictDoNothing()
          .returning({ id: schema.usageAlerts.id });
        if (!alert) continue;
        const data = {
          limit: candidate.limit,
          source: candidate.source,
          threshold,
          used,
          max: candidate.max,
          period: {
            key: snapshot.period.key,
            start: snapshot.period.start.toISOString(),
            end: snapshot.period.end.toISOString(),
          },
        };
        await appendAudit(tx, {
          actorType: 'system',
          actorId: 'billing',
          action: 'usage.threshold_reached',
          targetType: 'tenant',
          targetId: toPublicId('tenant', tenantId),
          outcome: 'success',
          data,
        });
        await tx.execute(
          sql`select app.enqueue_webhook_source(${tenantId}::uuid, 'usage_alert', ${alert.id}::text, ${JSON.stringify(
            { kind: 'usage_alert', ...data, at: now.toISOString() },
          )}::jsonb)`,
        );
        this.logger.log(`usage alert: ${candidate.limit} (${candidate.source}) at ${threshold}%`);
      }
    }
  }

  /**
   * Refuses a new customer conversation when the plan's conversations for the period are used up.
   * The customer hears that chat is unavailable, never the business's plan or its numbers.
   */
  async assertCanStartConversation(tenantId: string): Promise<void> {
    const snapshot = await withTenant(this.db, { tenantId, actorId: 'billing' }, async (tx) => {
      const current = await this.snapshot(tx, ['conversations']);
      await this.raiseAlerts(tx, tenantId, current);
      return current;
    });
    if (!withinLimit(snapshot.usage.conversations, snapshot.limits.conversations)) {
      throw new AppError('PLAN_LIMIT_REACHED', {
        detail: 'This chat cannot take new conversations right now. Please try again later.',
        internal: { limit: 'conversations', period: snapshot.period.key },
      });
    }
  }

  /**
   * Checks a capacity limit before adding `increment` units, inside the caller's transaction.
   * The tenant's entitlement row is locked, so concurrent additions are counted one at a time.
   */
  async assertCapacity(
    tx: TenantTx,
    tenantId: string,
    key: LimitKey,
    increment = 1,
  ): Promise<void> {
    const { rows } = await tx.execute<{ cap: string | null }>(
      sql`select app.plan_limit(${tenantId}::uuid, ${key}) as cap`,
    );
    const raw = rows[0]?.cap;
    if (raw === null || raw === undefined) return;
    const max = Number(raw);
    const used = await this.capacityUsage(tx, key);
    if (!withinLimit(used, max, increment)) {
      throw planLimitError(key, { max, used, resetsAt: null });
    }
  }

  /** Whether the AI may write another reply now (plan replies and tokens, workspace budget). */
  async aiAllowance(tenantId: string): Promise<AiAllowance> {
    return withTenant(this.db, { tenantId, actorId: 'billing' }, async (tx) => {
      const snapshot = await this.snapshot(tx, ['aiReplies', 'aiTokens']);
      await this.raiseAlerts(tx, tenantId, snapshot);
      return aiAllowance({
        limits: snapshot.limits,
        budgetTokens: snapshot.budgetTokens,
        repliesUsed: snapshot.usage.aiReplies,
        tokensUsed: snapshot.usage.aiTokens,
      });
    });
  }
}
