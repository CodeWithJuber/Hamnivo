import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from '@hamnivo/contracts';
import {
  type ClaimedOutboxEvent,
  type Db,
  newId,
  schema,
  type TenantTx,
  withTenant,
} from '@hamnivo/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { AppConfig } from '../../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../../tokens.js';
import { type BuiltEvent, buildEvent, serializeEvent } from './events.js';

export const WEBHOOK_SOURCE_TOPIC = 'webhooks.source';

/** A body larger than this is not sent (events are small; a message is at most a few KiB). */
export const MAX_EVENT_BYTES = 256 * 1024;

const DAY = 86_400_000;

/**
 * Turns outbox `webhooks.source` events into one stored, signed-once body and one delivery per
 * subscribed active endpoint. Runs at least once per source event; the source key makes a
 * repeated run find the event it already stored instead of creating a second one.
 */
@Injectable()
export class WebhookFanout {
  private readonly logger = new Logger(WebhookFanout.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Outbox handler for `webhooks.source`. */
  async onSource(event: ClaimedOutboxEvent): Promise<void> {
    await withTenant(this.db, { tenantId: event.tenantId, actorId: 'webhooks' }, async (tx) => {
      const built = await buildEvent(tx, event.payload);
      if (!built) return;
      await this.enqueue(tx, event.tenantId, `outbox:${event.id}`, built);
    });
  }

  /**
   * Stores the event and creates deliveries for the endpoints subscribed to it. Returns the
   * event id, or null when no endpoint wants it (nothing is stored then).
   */
  async enqueue(
    tx: TenantTx,
    tenantId: string,
    sourceKey: string,
    built: BuiltEvent,
    only?: { endpointId: string },
  ): Promise<{ eventId: string; deliveryIds: string[] } | null> {
    const e = schema.webhookEndpoints;
    const endpoints = await tx
      .select({ id: e.id, eventTypes: e.eventTypes })
      .from(e)
      .where(only ? eq(e.id, only.endpointId) : eq(e.status, 'active'));
    const subscribed = only
      ? endpoints
      : endpoints.filter((endpoint) => endpoint.eventTypes.includes(built.type));
    if (subscribed.length === 0) return null;

    const ev = schema.webhookEvents;
    const [existing] = await tx.select({ id: ev.id }).from(ev).where(eq(ev.sourceKey, sourceKey));
    let eventId = existing?.id;
    if (!eventId) {
      eventId = newId();
      let body: string;
      try {
        body = serializeEvent({ eventId, tenantId, ...built });
      } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        // Never send what the published schema does not describe; the cause is a bug to fix.
        this.logger.error(`webhook event ${built.type} skipped: it does not match its schema`);
        return null;
      }
      if (Buffer.byteLength(body) > MAX_EVENT_BYTES) {
        this.logger.warn(`webhook event ${built.type} skipped: ${Buffer.byteLength(body)} bytes`);
        return null;
      }
      const now = this.clock();
      await tx.insert(ev).values({
        id: eventId,
        tenantId,
        type: built.type,
        sourceKey,
        body,
        occurredAt: built.occurredAt,
        expiresAt: new Date(now.getTime() + this.config.WEBHOOK_RETENTION_DAYS * DAY),
      });
    }
    const now = this.clock();
    const d = schema.webhookDeliveries;
    const rows = await tx
      .insert(d)
      .values(
        subscribed.map((endpoint) => ({
          tenantId,
          endpointId: endpoint.id,
          eventId: eventId as string,
          status: 'pending' as const,
          nextAttemptAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: d.id });
    return { eventId, deliveryIds: rows.map((row) => row.id) };
  }

  /** Deliveries of an event that already exist (the first delivery per endpoint). */
  async firstDelivery(tx: TenantTx, endpointId: string, eventId: string) {
    const d = schema.webhookDeliveries;
    const [row] = await tx
      .select()
      .from(d)
      .where(and(eq(d.endpointId, endpointId), eq(d.eventId, eventId)))
      .limit(1);
    return row ?? null;
  }
}

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}
