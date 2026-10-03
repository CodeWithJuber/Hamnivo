import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { LimitsJson, MeteredPriceJson } from '@hamnivo/db/schema';
import { eq, sql } from 'drizzle-orm';

/** The plan new workspaces start on, and the one trials and lapsed subscriptions fall back to. */
export const FREE_PLAN = 'free';
/** HAMNIVO_DEFAULT_PLAN value for self-hosting: new workspaces get no plan, so no limits. */
export const NO_PLAN = 'unlimited';

export interface PlanRow {
  key: string;
  name: string;
  currency: string;
  priceMinor: bigint;
  limits: LimitsJson;
  metered: MeteredPriceJson[];
  trialDays: number;
  stripePriceId: string | null;
}

/** Anything that runs SQL: a tenant transaction or a connection pool. */
type Sql = Pick<TenantTx, 'execute'>;

/**
 * Active plans, read through app.active_plans() so the application role can assign a plan
 * without access to the platform's plan table.
 */
export async function activePlans(db: Sql): Promise<PlanRow[]> {
  const { rows } = await db.execute<{
    key: string;
    name: string;
    currency: string;
    price_minor: string | number;
    limits: LimitsJson;
    metered: MeteredPriceJson[];
    trial_days: number;
    stripe_price_id: string | null;
  }>(sql`select * from app.active_plans()`);
  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    currency: row.currency,
    priceMinor: BigInt(row.price_minor),
    limits: row.limits,
    metered: row.metered,
    trialDays: Number(row.trial_days),
    stripePriceId: row.stripe_price_id,
  }));
}

export async function planByKey(db: Sql, key: string): Promise<PlanRow | null> {
  return (await activePlans(db)).find((plan) => plan.key === key) ?? null;
}

export type PlanSource =
  | 'default'
  | 'operator'
  | 'stripe'
  | 'whmcs'
  | 'trial_ended'
  | 'grace_ended'
  | 'subscription_ended';

export interface PlanChange {
  actorType: 'platform' | 'system' | 'staff';
  actorId: string;
  /** Why the plan changed, recorded in the workspace's audit log. */
  source: PlanSource;
  /** The plan is a trial until then; null: not a trial. */
  trialEndsAt: Date | null;
  now: Date;
  /**
   * Writes even when nothing changed, which dates the assignment from `now` again (the billing
   * CLI: an operator assigning a plan means it). Provider events and billing systems leave it off.
   */
  force?: boolean;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Copies a plan into the workspace's entitlements, inside the workspace's transaction (A15). The
 * workspace keeps its own AI budget, lowered to the plan's tokens when it was above them. The
 * entitlement row is locked, so concurrent changes apply one after the other, and a change to
 * the plan the workspace already has (same limits, same trial) writes nothing: provider events
 * and billing-system calls may repeat.
 */
export async function applyPlan(
  tx: TenantTx,
  tenantId: string,
  plan: PlanRow,
  change: PlanChange,
): Promise<{ previous: string | null; changed: boolean }> {
  const [current] = await tx.select().from(schema.tenantEntitlements).for('update');
  const unchanged =
    current?.planKey === plan.key &&
    current.priceMinor === plan.priceMinor &&
    current.currency === plan.currency &&
    sameJson(current.limits, plan.limits) &&
    sameJson(current.metered, plan.metered) &&
    (current.trialEndsAt?.getTime() ?? null) === (change.trialEndsAt?.getTime() ?? null);
  if (unchanged && !change.force) return { previous: current.planKey, changed: false };
  const values = {
    planKey: plan.key,
    planName: plan.name,
    currency: plan.currency,
    priceMinor: plan.priceMinor,
    limits: plan.limits,
    metered: plan.metered,
    trialEndsAt: change.trialEndsAt,
    assignedAt: change.now,
    assignedBy: change.actorId,
    updatedAt: change.now,
  };
  const tokens = plan.limits.aiTokens;
  const budget =
    typeof tokens === 'number' && current?.aiTokenBudget && current.aiTokenBudget > tokens
      ? { aiTokenBudget: tokens }
      : {};
  if (current) {
    await tx
      .update(schema.tenantEntitlements)
      .set({ ...values, ...budget })
      .where(eq(schema.tenantEntitlements.id, current.id));
  } else {
    await tx.insert(schema.tenantEntitlements).values({ tenantId, ...values });
  }
  await appendAudit(tx, {
    actorType: change.actorType,
    actorId: change.actorId,
    action: 'billing.plan_assigned',
    targetType: 'tenant',
    targetId: toPublicId('tenant', tenantId),
    outcome: 'success',
    data: {
      plan: plan.key,
      previous: current?.planKey ?? null,
      source: change.source,
      trialEndsAt: change.trialEndsAt?.toISOString() ?? null,
      limits: plan.limits,
    },
  });
  return { previous: current?.planKey ?? null, changed: true };
}

/** When a trial of `plan` that starts now ends; null when the plan has no trial. */
export function trialEnd(plan: PlanRow, now: Date): Date | null {
  return plan.trialDays > 0 ? new Date(now.getTime() + plan.trialDays * 86_400_000) : null;
}
