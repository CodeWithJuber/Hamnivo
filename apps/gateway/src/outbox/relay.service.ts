import { writeFile } from 'node:fs/promises';
import { type ClaimedOutboxEvent, claimOutbox, type Db, schema, withTenant } from '@hamnivo/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG, REDIS } from '../tokens.js';
import { OUTBOX_SIGNAL } from './outbox.js';

export type OutboxHandler = (event: ClaimedOutboxEvent) => Promise<void>;
export const OUTBOX_HANDLERS = Symbol('OUTBOX_HANDLERS');
export { OUTBOX_SIGNAL };

const BATCH = 50;
const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 12;
/** Leases of events still held (waiting or running) are extended this often. */
const RENEW_MS = 20_000;

/** Exponential backoff with full jitter, capped at 10 minutes. */
export function retryDelayMs(attempts: number): number {
  const cap = Math.min(600_000, 1000 * 2 ** Math.max(0, attempts - 1));
  return Math.floor(cap / 2 + Math.random() * (cap / 2));
}

/**
 * What must stay in order: the events of one conversation (or of one other aggregate: a
 * migration, a document) run one after another, in the order they were claimed. Events of
 * different aggregates may run at the same time.
 */
export const orderKey = (
  event: Pick<ClaimedOutboxEvent, 'tenantId' | 'aggregateType' | 'aggregateId'>,
) => `${event.tenantId}:${event.aggregateType}:${event.aggregateId}`;

/**
 * Runs `work` for every item, at most `slots` at a time. Items with the same key run one after
 * another in the order given; different keys run side by side. Resolves when all are done.
 */
export async function runKeyed<T>(
  items: readonly T[],
  key: (item: T) => string,
  slots: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const lanes = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const lane = lanes.get(name);
    if (lane) lane.push(item);
    else lanes.set(name, [item]);
  }
  const waiting = [...lanes.values()];
  const runner = async () => {
    for (let lane = waiting.shift(); lane; lane = waiting.shift()) {
      for (const item of lane) await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, slots), waiting.length) }, runner));
}

/**
 * Relays outbox events to their handlers at least once. Leasing happens across tenants through
 * app.claim_outbox(); acknowledgement and failure bookkeeping happen inside the event's tenant.
 *
 * In the background it is a pump with `OUTBOX_CONCURRENCY` slots (1 is the old one-by-one
 * relay): a customer's reply no longer waits behind other conversations' replies, a knowledge
 * ingestion or a migration, while each conversation's own events stay in order. It claims only
 * what it has room for, keeps the leases of what it holds, and wakes as soon as a commit says
 * there may be work (OUTBOX_SIGNAL) instead of on its next one-second look.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private renewer: NodeJS.Timeout | undefined;
  private claiming: Promise<void> | undefined;
  private subscriber: Redis | undefined;
  /** Claimed events not yet acknowledged, by id. */
  private readonly held = new Map<string, ClaimedOutboxEvent>();
  /** Events waiting their turn, per order key. */
  private readonly lanes = new Map<string, ClaimedOutboxEvent[]>();
  /** Order keys being worked on, and the work. */
  private readonly running = new Map<string, Promise<void>>();
  /** The last claim filled its limit: more is likely due. */
  private behind = false;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(OUTBOX_HANDLERS) private readonly handlers: Map<string, OutboxHandler>,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private get slots(): number {
    return Math.max(1, this.config.OUTBOX_CONCURRENCY);
  }

  async onApplicationBootstrap(): Promise<void> {
    this.stopped = false;
    try {
      this.subscriber = this.redis.duplicate();
      this.subscriber.on('message', () => this.wake());
      this.subscriber.on('error', () => undefined);
      await this.subscriber.subscribe(OUTBOX_SIGNAL);
    } catch (error) {
      // Without the signal the relay still looks every second.
      this.logger.warn(`outbox signal unavailable: ${String(error)}`);
    }
    this.renewer = setInterval(() => void this.renew(), RENEW_MS);
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.renewer) clearInterval(this.renewer);
    await this.claiming;
    // What waits is handed back at once, for another worker; what runs is finished.
    const waiting = [...this.lanes.values()].flat();
    this.lanes.clear();
    await this.release(waiting);
    await Promise.all(this.running.values());
    await this.subscriber?.quit().catch(() => undefined);
    this.subscriber = undefined;
  }

  private wake() {
    if (this.stopped || this.claiming) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.claiming = this.fill()
        .then(async (full) => {
          this.claiming = undefined;
          await this.beat();
          this.schedule(full ? 0 : 1000);
        })
        .catch((error: unknown) => {
          this.claiming = undefined;
          this.logger.error(`outbox relay failed: ${String(error)}`);
          this.schedule(5000);
        });
    }, delay);
  }

  /** Claims as many due events as there is room for; true when more are likely due at once. */
  private async fill(): Promise<boolean> {
    const room = Math.min(BATCH, this.slots * 4 - this.held.size);
    if (room <= 0) return false;
    const events = await claimOutbox(this.db, { limit: room, leaseSeconds: LEASE_SECONDS });
    for (const event of events) {
      this.held.set(event.id, event);
      const key = orderKey(event);
      const lane = this.lanes.get(key);
      if (lane) lane.push(event);
      else this.lanes.set(key, [event]);
    }
    this.dispatch();
    this.behind = events.length === room;
    return this.behind && this.held.size < this.slots * 4;
  }

  /** Starts the waiting lanes there are slots for, oldest first, one run per order key. */
  private dispatch() {
    for (const [key, lane] of this.lanes) {
      if (this.running.size >= this.slots) return;
      if (this.running.has(key) || lane.length === 0) continue;
      const work = (async () => {
        for (let event = lane.shift(); event; event = lane.shift()) {
          await this.handle(event);
          this.held.delete(event.id);
        }
      })()
        .catch((error: unknown) => this.logger.error(`outbox lane failed: ${String(error)}`))
        .finally(() => {
          this.running.delete(key);
          if (lane.length === 0 && this.lanes.get(key) === lane) this.lanes.delete(key);
          if (this.stopped) return;
          this.dispatch();
          // A slot is free and more was due: look again now, not in a second.
          if (this.behind) this.wake();
        });
      this.running.set(key, work);
    }
  }

  /** Runs one event and records the outcome; never throws for the handler's own failure. */
  private async handle(event: ClaimedOutboxEvent): Promise<void> {
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
      ).catch((bookkeeping: unknown) =>
        // The lease runs out and the event is claimed again: at least once still holds.
        this.logger.error(`outbox ${event.id} not recorded: ${String(bookkeeping)}`),
      );
      this.logger.warn(
        `outbox ${event.topic} ${event.id} failed (attempt ${event.attempts}): ${message}`,
      );
    }
  }

  /** Keeps the leases of held events, waiting or running, so no other worker takes them. */
  private async renew(): Promise<void> {
    for (const [tenantId, ids] of byTenant([...this.held.values()])) {
      await withTenant(this.db, { tenantId }, (tx) =>
        tx
          .update(schema.outboxEvents)
          .set({ lockedUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})` })
          .where(
            and(inArray(schema.outboxEvents.id, ids), isNull(schema.outboxEvents.processedAt)),
          ),
      ).catch((error: unknown) => this.logger.warn(`outbox leases not renewed: ${String(error)}`));
    }
  }

  /** Gives up the leases of events that will not run here. */
  private async release(events: ClaimedOutboxEvent[]): Promise<void> {
    for (const event of events) this.held.delete(event.id);
    for (const [tenantId, ids] of byTenant(events)) {
      await withTenant(this.db, { tenantId }, (tx) =>
        tx
          .update(schema.outboxEvents)
          .set({ lockedUntil: null })
          .where(
            and(inArray(schema.outboxEvents.id, ids), isNull(schema.outboxEvents.processedAt)),
          ),
      ).catch(() => undefined);
    }
  }

  /** Marks a completed pass, so a container health check can tell a stuck worker from a busy one. */
  private async beat(): Promise<void> {
    if (!this.config.WORKER_HEARTBEAT_FILE) return;
    await writeFile(this.config.WORKER_HEARTBEAT_FILE, String(this.clock().getTime())).catch(
      (error: unknown) => this.logger.warn(`heartbeat not written: ${String(error)}`),
    );
  }

  /**
   * Processes one batch and returns how many events were leased, once all of them are done
   * (tests drive the relay with it). The batch runs as the pump does: in order per conversation,
   * side by side otherwise.
   */
  async drainOnce(): Promise<number> {
    const events = await claimOutbox(this.db, { limit: BATCH, leaseSeconds: LEASE_SECONDS });
    await runKeyed(events, orderKey, this.slots, (event) => this.handle(event));
    return events.length;
  }
}

function byTenant(events: readonly ClaimedOutboxEvent[]): Map<string, string[]> {
  const tenants = new Map<string, string[]>();
  for (const event of events) {
    const ids = tenants.get(event.tenantId);
    if (ids) ids.push(event.id);
    else tenants.set(event.tenantId, [event.id]);
  }
  return tenants;
}
