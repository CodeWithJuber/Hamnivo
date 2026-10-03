import type { OperatorAccount, PlatformTenantBilling, UsageMeter } from '@hamnivo/contracts';
import {
  appendAudit,
  appendPlatformAudit,
  type Db,
  fromPublicId,
  InvalidPublicIdError,
  resolveTenantSlug,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { LIMIT_KEYS, LIMITS, usageStatus } from '@hamnivo/domain/billing';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { billingAccount, updateAccount } from '../billing/accounts.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { applyPlan, planByKey, trialEnd } from '../billing/plans.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import type { OperatorContext } from '../identity/request-auth.js';
import { TenantsService } from '../identity/tenants.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG, PLATFORM_DB } from '../tokens.js';
import type { OperatorKeyActor } from './operator-keys.js';

/** Who changes a workspace from outside it: an operator in the console, or an operator API key. */
export type LifecycleActor =
  | { kind: 'operator'; operator: OperatorContext }
  | { kind: 'key'; key: OperatorKeyActor };

type TenantStatus = 'active' | 'suspended' | 'closing';

const ACTIONS: Record<TenantStatus, string> = {
  active: 'tenant.reactivated',
  suspended: 'tenant.suspended',
  closing: 'tenant.closed',
};

/**
 * The life of a workspace as the platform operator or a billing system sees it (A17): suspend
 * (the widget shows offline and staff can only read), reactivate, close, and change the plan,
 * plus the plan, trial, subscription and usage to show for it. Changes are written inside the
 * workspace (its own audit log says who did it) and in the platform audit log; each is safe to
 * repeat, since billing systems retry.
 */
@Injectable()
export class TenantLifecycleService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(PLATFORM_DB) private readonly platform: Db | null,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly entitlements: EntitlementsService,
    private readonly tenants: TenantsService,
  ) {}

  /** A workspace by public id (`tnt_…`), external reference (`whmcs:42`) or handle. */
  async resolve(reference: string): Promise<string> {
    if (reference.startsWith('tnt_')) {
      try {
        const id = fromPublicId('tenant', reference);
        const exists = await withTenant(this.db, { tenantId: id }, async (tx) =>
          Boolean((await tx.select({ id: schema.tenants.id }).from(schema.tenants))[0]),
        );
        if (exists) return id;
      } catch (error) {
        if (!(error instanceof InvalidPublicIdError)) throw error;
      }
      throw new AppError('NOT_FOUND', { detail: 'No such workspace.' });
    }
    const id = reference.includes(':')
      ? await this.tenants.byExternalRef(reference)
      : ((await resolveTenantSlug(this.db, reference))?.tenantId ?? null);
    if (!id) throw new AppError('NOT_FOUND', { detail: 'No such workspace.' });
    return id;
  }

  private actorOf(actor: LifecycleActor) {
    return actor.kind === 'operator'
      ? { actorType: 'platform' as const, actorId: actor.operator.email }
      : { actorType: 'platform' as const, actorId: actor.key.actor };
  }

  private async platformAudit(
    actor: LifecycleActor,
    tenantId: string,
    action: string,
    data: Record<string, unknown>,
    reason: string | null = null,
  ) {
    if (!this.platform) return;
    await this.platform.transaction((tx) =>
      appendPlatformAudit(tx, {
        operatorId: actor.kind === 'operator' ? actor.operator.principal.operatorId : null,
        action,
        tenantId,
        targetType: 'tenant',
        targetId: toPublicId('tenant', tenantId),
        outcome: 'success',
        reason,
        data: actor.kind === 'key' ? { ...data, operatorKey: actor.key.name } : data,
      }),
    );
  }

  private async meters(tx: TenantTx) {
    const snapshot = await this.entitlements.snapshot(tx);
    const early = snapshot.thresholds.filter((t) => t > 0 && t < 100);
    const warningAt = early.length > 0 ? Math.min(...early) : 80;
    return {
      period: {
        key: snapshot.period.key,
        start: snapshot.period.start.toISOString(),
        end: snapshot.period.end.toISOString(),
      },
      meters: LIMIT_KEYS.map((key): z.infer<typeof UsageMeter> => {
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
    };
  }

  /** The plan, trial, subscription and this period's usage (platform console). */
  async billing(tenantId: string): Promise<z.infer<typeof PlatformTenantBilling>> {
    return withTenant(this.db, { tenantId }, async (tx) => {
      const [tenant] = await tx.select().from(schema.tenants);
      if (!tenant) throw new AppError('NOT_FOUND');
      const [entitlement] = await tx.select().from(schema.tenantEntitlements);
      const account = await billingAccount(tx, tenantId);
      return {
        tenantId: toPublicId('tenant', tenantId),
        status: tenant.status,
        plan:
          entitlement?.planKey && entitlement.planName
            ? { key: entitlement.planKey, name: entitlement.planName }
            : null,
        trialEndsAt: entitlement?.trialEndsAt?.toISOString() ?? null,
        provider: account.provider,
        subscriptionStatus: account.subscriptionStatus,
        graceEndsAt: account.graceEndsAt?.toISOString() ?? null,
        ...(await this.meters(tx)),
      };
    });
  }

  /** What the operator API returns for a workspace. */
  async account(tenantId: string): Promise<z.infer<typeof OperatorAccount>> {
    return withTenant(this.db, { tenantId }, async (tx) => {
      const [tenant] = await tx.select().from(schema.tenants);
      if (!tenant) throw new AppError('NOT_FOUND');
      const [entitlement] = await tx.select().from(schema.tenantEntitlements);
      const account = await billingAccount(tx, tenantId);
      const external = account.provider === 'whmcs' || account.provider === 'manual';
      return {
        tenantId: toPublicId('tenant', tenantId),
        externalRef: external ? account.subscriptionRef : null,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        plan:
          entitlement?.planKey && entitlement.planName
            ? { key: entitlement.planKey, name: entitlement.planName }
            : null,
        trialEndsAt: entitlement?.trialEndsAt?.toISOString() ?? null,
        studioUrl: `${this.config.PUBLIC_CONSOLE_ORIGIN.replace(/\/$/, '')}/tenants`,
        meters: (await this.meters(tx)).meters,
      };
    });
  }

  /**
   * Suspends, reactivates or closes a workspace. Suspended: staff keep read-only access and the
   * widget shows offline. Closed: nobody gets in; the data stays until the operator deletes it.
   * A closed workspace is not reopened here.
   */
  async setStatus(
    tenantId: string,
    status: TenantStatus,
    actor: LifecycleActor,
    reason: string,
  ): Promise<{ changed: boolean }> {
    const who = this.actorOf(actor);
    const result = await withTenant(
      this.db,
      { tenantId, actorId: `platform:${who.actorId}` },
      async (tx) => {
        const [tenant] = await tx.select().from(schema.tenants).for('update');
        if (!tenant) throw new AppError('NOT_FOUND');
        if (tenant.status === status) return { changed: false, previous: tenant.status };
        if (tenant.status === 'closing') {
          throw new AppError('VERSION_CONFLICT', {
            detail: 'This workspace is closed. Create a new one instead.',
          });
        }
        await tx
          .update(schema.tenants)
          .set({ status, updatedAt: this.clock() })
          .where(eq(schema.tenants.id, tenantId));
        await appendAudit(tx, {
          ...who,
          action: ACTIONS[status],
          targetType: 'tenant',
          targetId: toPublicId('tenant', tenantId),
          outcome: 'success',
          reason,
          data: { from: tenant.status, to: status },
        });
        return { changed: true, previous: tenant.status };
      },
    );
    if (result.changed) {
      await this.platformAudit(
        actor,
        tenantId,
        ACTIONS[status],
        { from: result.previous, to: status },
        reason,
      );
    }
    return { changed: result.changed };
  }

  /** Gives a workspace a plan, optionally as a trial (the plan's trial days). */
  async assignPlan(
    tenantId: string,
    planKey: string,
    startTrial: boolean,
    actor: LifecycleActor,
  ): Promise<{ changed: boolean }> {
    const who = this.actorOf(actor);
    const now = this.clock();
    const result = await withTenant(
      this.db,
      { tenantId, actorId: `platform:${who.actorId}` },
      async (tx) => {
        const plan = await planByKey(tx, planKey);
        if (!plan) {
          throw new AppError('VALIDATION_FAILED', {
            fields: [{ path: 'planKey', message: `There is no active plan ${planKey}.` }],
          });
        }
        if (startTrial && plan.trialDays === 0) {
          throw new AppError('VALIDATION_FAILED', {
            fields: [{ path: 'startTrial', message: 'This plan has no trial.' }],
          });
        }
        const account = await billingAccount(tx, tenantId, { lock: true });
        if (account.provider === 'stripe' && account.subscriptionStatus !== 'none') {
          // Stripe would put its own plan back with its next event.
          throw new AppError('VERSION_CONFLICT', {
            detail:
              'This workspace pays through Stripe. Change the plan in Stripe, or cancel the subscription first.',
          });
        }
        const { changed } = await applyPlan(tx, tenantId, plan, {
          ...who,
          source: actor.kind === 'key' && account.provider === 'whmcs' ? 'whmcs' : 'operator',
          trialEndsAt: startTrial ? trialEnd(plan, now) : null,
          now,
        });
        if (account.provider === 'whmcs' || account.provider === 'manual') {
          await updateAccount(tx, account, { planKey: plan.key });
        }
        return { changed };
      },
    );
    if (result.changed) {
      await this.platformAudit(actor, tenantId, 'billing.plan_assigned', {
        plan: planKey,
        startTrial,
      });
    }
    return result;
  }
}
