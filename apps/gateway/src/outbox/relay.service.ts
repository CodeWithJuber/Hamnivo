import { writeFile } from 'node:fs/promises';
import { type ClaimedOutboxEvent, claimOutbox, type Db, schema, withTenant } from '@hamnivo/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

export type OutboxHandler = (event: ClaimedOutboxEvent) => Promise<void>;
export const OUTBOX_HANDLERS = Symbol('OUTBOX_HANDLERS');

const BATCH = 50;
const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 12;

/** Exponential backoff with full jitter, capped at 10 minutes. */
export function retryDelayMs(attempts: number): number {
  const cap = Math.min(600_000, 1000 * 2 ** Math.max(0, attempts - 1));
  return Math.floor(cap / 2 + Math.random() * (cap / 2));
}

/**
 * Relays outbox events to their handlers at least once. Leasing happens across tenants through
 * app.claim_outbox(); acknowledgement and failure bookkeeping happen inside the event's tenant.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(OUTBOX_HANDLERS) private readonly handlers: Map<string, OutboxHandler>,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
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
        .then(async (count) => {
          await this.beat();
          this.schedule(count === BATCH ? 0 : 1000);
        })
        .catch((error: unknown) => {
          this.logger.error(`outbox relay failed: ${String(error)}`);
          this.schedule(5000);
        });
    }, delay);
  }

  /** Marks a completed pass, so a container health check can tell a stuck worker from a busy one. */
  private async beat(): Promise<void> {
    if (!this.config.WORKER_HEARTBEAT_FILE) return;
    await writeFile(this.config.WORKER_HEARTBEAT_FILE, String(this.clock().getTime())).catch(
      (error: unknown) => this.logger.warn(`heartbeat not written: ${String(error)}`),
    );
  }

  /** Processes one batch; returns how many events were leased. */
  async drainOnce(): Promise<number> {
    const events = await claimOutbox(this.db, { limit: BATCH, leaseSeconds: LEASE_SECONDS });
    for (const event of events) {
      const handler = this.handlers.get(event.topic);
      try {
        if (handler) await handler(event);
        await withTenant(this.db, { tenantId: event.tenantId }, (tx) =>
          tx
            .update(schema.outboxEvents)
            .set({ processedAt: this.clock(), lockedUntil: null, lastError: null })
            .where(eq(schema.outboxEvents.id, event.id)),
        );
      } catch (error) {
        const dead = event.attempts >= MAX_ATTEMPTS;
        const message = error instanceof Error ? error.message : String(error);
        await withTenant(this.db, { tenantId: event.tenantId }, (tx) =>
          tx
            .update(schema.outboxEvents)
            .set({
              lockedUntil: null,
              lastError: dead ? `dead-letter: ${message}` : message,
              availableAt: new Date(this.clock().getTime() + retryDelayMs(event.attempts)),
              ...(dead ? { processedAt: this.clock() } : {}),
            })
            .where(eq(schema.outboxEvents.id, event.id)),
        );
        this.logger.warn(
          `outbox ${event.topic} ${event.id} failed (attempt ${event.attempts}): ${message}`,
        );
      }
    }
    return events.length;
  }
}
