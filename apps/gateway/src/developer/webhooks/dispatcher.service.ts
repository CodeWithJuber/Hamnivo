import { claimWebhookDeliveries, type Db, schema, withTenant } from '@hamnivo/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AppConfig } from '../../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../../tokens.js';
import { leaseSeconds } from './delivery-rules.js';
import { type AttemptResult, type Prepared, WebhookSender } from './sender.service.js';

/**
 * The webhook delivery worker: leases due deliveries across tenants, sends them a few at a time
 * and records each attempt in its tenant. A lease outlives one request (deadline plus a margin),
 * so a crashed worker's deliveries are simply picked up again later.
 */
@Injectable()
export class WebhookDispatcher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly sender: WebhookSender,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.loop;
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.loop = this.drainOnce()
        .then((count) => this.schedule(count > 0 ? 0 : 1000))
        .catch((error: unknown) => {
          this.logger.error(`webhook dispatch failed: ${String(error)}`);
          this.schedule(5000);
        });
    }, delay);
  }

  /** Sends one batch of due deliveries; returns how many were leased. */
  async drainOnce(): Promise<number> {
    const concurrency = this.config.WEBHOOK_CONCURRENCY;
    const claimed = await claimWebhookDeliveries(this.db, {
      limit: concurrency * 4,
      leaseSeconds: leaseSeconds(this.config.WEBHOOK_TIMEOUT_MS),
    });
    let next = 0;
    const lanes = Array.from({ length: Math.min(concurrency, claimed.length) }, async () => {
      while (next < claimed.length) {
        const item = claimed[next];
        next += 1;
        if (!item) continue;
        try {
          await this.deliver(item.tenantId, item.id);
        } catch (error) {
          this.logger.warn(`webhook delivery ${item.id} not recorded: ${String(error)}`);
        }
      }
    });
    await Promise.all(lanes);
    return claimed.length;
  }

  /** One attempt of one delivery. */
  async deliver(tenantId: string, deliveryId: string): Promise<void> {
    const loaded = await withTenant(this.db, { tenantId, actorId: 'webhooks' }, async (tx) => {
      const [row] = await tx
        .select({
          delivery: schema.webhookDeliveries,
          endpoint: schema.webhookEndpoints,
          body: schema.webhookEvents.body,
        })
        .from(schema.webhookDeliveries)
        .innerJoin(
          schema.webhookEndpoints,
          eq(schema.webhookEndpoints.id, schema.webhookDeliveries.endpointId),
        )
        .innerJoin(
          schema.webhookEvents,
          eq(schema.webhookEvents.id, schema.webhookDeliveries.eventId),
        )
        .where(eq(schema.webhookDeliveries.id, deliveryId));
      if (row?.delivery.status !== 'pending') return null;
      const now = this.clock();
      if (row.endpoint.status !== 'active') {
        await tx
          .update(schema.webhookDeliveries)
          .set({ status: 'cancelled', nextAttemptAt: null, updatedAt: now })
          .where(eq(schema.webhookDeliveries.id, deliveryId));
        return null;
      }
      const prepared = row.body ? await this.sender.prepare(tx, tenantId, row.endpoint) : null;
      return { delivery: row.delivery, body: row.body, prepared };
    });
    if (!loaded) return;

    let result: AttemptResult;
    if (loaded.body === null) {
      // Past its retention: there is nothing left to send.
      result = {
        startedAt: this.clock(),
        durationMs: 0,
        judgement: {
          outcome: 'blocked',
          statusCode: null,
          error: 'The event is past its retention and can no longer be sent.',
          gone: false,
          retryAfterMs: null,
        },
        excerpt: null,
      };
    } else if (!loaded.prepared) {
      result = this.sender.unsigned();
    } else {
      result = await this.sender.attempt(
        loaded.prepared as Prepared,
        loaded.delivery.eventId,
        loaded.body,
      );
    }
    // An expired event is not the endpoint's failure: it neither retries nor counts against it.
    const sendable = loaded.body !== null;
    await withTenant(this.db, { tenantId, actorId: 'webhooks' }, (tx) =>
      this.sender.record(tx, tenantId, loaded.delivery, result, {
        health: sendable,
        retry: sendable,
      }),
    );
  }
}
