import { type Db, schema, withTenant } from '@hamnivo/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { reportError } from '../observability/error-reporting.js';
import { APP_DB, CLOCK, type Clock, REDIS } from '../tokens.js';
import { accountState, billingAccount, updateAccount } from './accounts.js';
import { graceOver } from './lifecycle.js';
import { applyPlan, FREE_PLAN, planByKey } from './plans.js';

const QUEUE = 'hamnivo-billing';

/**
 * Ends trials and grace periods (A16): every minute, workspaces whose trial ended, or whose
 * payment is still failing when the grace period ends, move to the free plan. Each change is
 * checked again inside the workspace with its rows locked, so a subscription that started or a
 * payment that arrived meanwhile wins, and running it twice changes nothing more.
 */
@Injectable()
export class BillingLifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BillingLifecycleService.name);
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue(QUEUE, { connection: this.redis, prefix: 'hamnivo' });
    await this.queue.upsertJobScheduler(
      'billing-lapses',
      { every: 60 * 1000 },
      { name: 'billing-lapses' },
    );
    this.worker = new Worker(QUEUE, () => this.processLapses(), {
      connection: this.redis.duplicate(),
      prefix: 'hamnivo',
      concurrency: 1,
    });
    this.worker.on('failed', (_job, error) => {
      this.logger.error(`billing lapses failed: ${error.message}`);
      reportError(error, { job: 'billing lapses' });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  /** Moves every workspace whose trial or grace period ended to the free plan. */
  async processLapses(): Promise<{ trials: number; graces: number }> {
    const now = this.clock();
    const { rows } = await this.db.execute<{ tenant_id: string; reason: string }>(
      sql`select tenant_id, reason from app.lapsed_billing(${now.toISOString()}::timestamptz, 200)`,
    );
    const done = { trials: 0, graces: 0 };
    for (const row of rows) {
      try {
        const changed = await this.lapse(row.tenant_id, row.reason, now);
        if (changed && row.reason === 'trial_ended') done.trials += 1;
        if (changed && row.reason === 'grace_ended') done.graces += 1;
      } catch (error) {
        this.logger.error(`billing lapse for ${row.tenant_id} failed: ${String(error)}`);
      }
    }
    return done;
  }

  private lapse(tenantId: string, reason: string, now: Date): Promise<boolean> {
    return withTenant(this.db, { tenantId, actorId: 'billing' }, async (tx) => {
      if (reason === 'trial_ended') {
        const [entitlement] = await tx.select().from(schema.tenantEntitlements).for('update');
        if (!entitlement?.trialEndsAt || entitlement.trialEndsAt > now) return false;
        const free = await planByKey(tx, FREE_PLAN);
        if (!free) throw new Error(`no active plan ${FREE_PLAN} to end the trial with`);
        await applyPlan(tx, tenantId, free, {
          actorType: 'system',
          actorId: 'billing',
          source: 'trial_ended',
          trialEndsAt: null,
          now,
        });
        return true;
      }
      const account = await billingAccount(tx, tenantId, { lock: true });
      if (!graceOver(accountState(account), now)) {
        // Paid meanwhile, or no longer past due: the old date must not come back every minute.
        if (account.graceEndsAt && account.graceEndsAt <= now) {
          await updateAccount(tx, account, { graceEndsAt: null });
        }
        return false;
      }
      const free = await planByKey(tx, FREE_PLAN);
      if (!free) throw new Error(`no active plan ${FREE_PLAN} to end the grace period with`);
      await applyPlan(tx, tenantId, free, {
        actorType: 'system',
        actorId: 'billing',
        source: 'grace_ended',
        trialEndsAt: null,
        now,
      });
      // The first failure stays, so a later "past due" report keeps the free plan.
      await updateAccount(tx, account, { graceEndsAt: null });
      return true;
    });
  }
}
