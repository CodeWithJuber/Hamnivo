import { EgressError, type EgressPolicy, safeRequest } from '@hamnivo/adapters/net';
import { appendAudit, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import type { AppConfig } from '../../config.js';
import { SecretBroker } from '../../secrets/secret-broker.service.js';
import { CLOCK, type Clock, CONFIG } from '../../tokens.js';
import { EgressService } from '../egress.service.js';
import {
  type Judgement,
  judgeError,
  judgeResponse,
  MAX_ATTEMPTS,
  nextAttemptDelay,
  responseExcerpt,
  shouldDisable,
} from './delivery-rules.js';
import { signatureHeaders } from './signing.js';

export type EndpointRow = typeof schema.webhookEndpoints.$inferSelect;
export type DeliveryRow = typeof schema.webhookDeliveries.$inferSelect;

/** Response bytes read from a receiver; the log keeps an excerpt of the first few hundred. */
const MAX_RESPONSE_BYTES = 16 * 1024;

export const SIGNING_SECRET_KIND = 'webhook.signing_secret';

export interface Prepared {
  url: string;
  /** Plain secrets, used for this request only and then dropped. */
  secrets: string[];
  policy: EgressPolicy;
}

export interface AttemptResult {
  startedAt: Date;
  durationMs: number;
  judgement: Judgement;
  excerpt: string | null;
}

export interface Recorded {
  status: DeliveryRow['status'];
  disabled: 'failing' | 'gone' | null;
}

/**
 * Sends signed webhook requests and records what happened. Used by the delivery worker and by
 * the API's test button, so both sign, judge and log attempts the same way. Plain signing
 * secrets live only for the length of one request; nothing secret is logged or stored.
 */
@Injectable()
export class WebhookSender {
  private readonly logger = new Logger(WebhookSender.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly secrets: SecretBroker,
    private readonly egress: EgressService,
  ) {}

  /**
   * The endpoint's address, its signing secrets valid now (the current one, then the previous
   * one during a rotation's overlap) and the tenant's egress policy.
   */
  async prepare(tx: TenantTx, tenantId: string, endpoint: EndpointRow): Promise<Prepared | null> {
    const now = this.clock();
    const ids = [endpoint.secretId];
    if (
      endpoint.previousSecretId &&
      endpoint.previousSecretExpiresAt &&
      endpoint.previousSecretExpiresAt > now
    ) {
      ids.push(endpoint.previousSecretId);
    }
    const values: string[] = [];
    for (const id of ids) {
      try {
        values.push(await this.secrets.reveal(tx, tenantId, id));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
    if (values.length === 0) return null;
    return { url: endpoint.url, secrets: values, policy: await this.egress.policyIn(tx) };
  }

  /** One signed request. Delivery problems are judged, never thrown. */
  async attempt(prepared: Prepared, eventId: string, body: string): Promise<AttemptResult> {
    const startedAt = this.clock();
    const timestamp = Math.floor(startedAt.getTime() / 1000);
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'Hamnivo-Webhooks/1.0',
      ...signatureHeaders(prepared.secrets, toPublicId('event', eventId), timestamp, body),
    };
    const started = performance.now();
    try {
      const response = await safeRequest(
        {
          url: prepared.url,
          method: 'POST',
          headers,
          body,
          timeoutMs: this.config.WEBHOOK_TIMEOUT_MS,
          maxResponseBytes: MAX_RESPONSE_BYTES,
        },
        prepared.policy,
      );
      return {
        startedAt,
        durationMs: Math.round(response.durationMs),
        judgement: judgeResponse(response, startedAt.getTime()),
        excerpt: responseExcerpt(response.body),
      };
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      if (error instanceof EgressError) {
        return { startedAt, durationMs, judgement: judgeError(error), excerpt: null };
      }
      this.logger.warn(`webhook request failed unexpectedly: ${String(error)}`);
      return {
        startedAt,
        durationMs,
        judgement: {
          outcome: 'network',
          statusCode: null,
          error: 'The request could not be completed.',
          gone: false,
          retryAfterMs: null,
        },
        excerpt: null,
      };
    }
  }

  /** The attempt that could not even be made (no usable signing secret). */
  unsigned(): AttemptResult {
    return {
      startedAt: this.clock(),
      durationMs: 0,
      judgement: {
        outcome: 'blocked',
        statusCode: null,
        error: 'The signing secret is missing or revoked. Rotate the secret to resume deliveries.',
        gone: false,
        retryAfterMs: null,
      },
      excerpt: null,
    };
  }

  /**
   * Records an attempt and moves the delivery on: succeeded, retried later, or failed for good.
   * `health` (the worker's deliveries, not tests) also updates the endpoint's failure count and
   * turns it off after a 410 or after failing long enough, cancelling what is still pending.
   * Returns null when the delivery moved on meanwhile (another worker, or it was cancelled).
   */
  async record(
    tx: TenantTx,
    tenantId: string,
    delivery: DeliveryRow,
    result: AttemptResult,
    options: { health: boolean; retry: boolean },
  ): Promise<Recorded | null> {
    const now = this.clock();
    const attempt = delivery.attempts + 1;
    const { judgement } = result;
    const success = judgement.outcome === 'succeeded';
    const delay =
      success || !options.retry || judgement.gone
        ? null
        : nextAttemptDelay(attempt, judgement.retryAfterMs);
    const status: DeliveryRow['status'] = success
      ? 'succeeded'
      : delay === null
        ? 'failed'
        : 'pending';
    const d = schema.webhookDeliveries;
    const [updated] = await tx
      .update(d)
      .set({
        status,
        attempts: attempt,
        lastAttemptAt: result.startedAt,
        lastStatusCode: judgement.statusCode,
        lastOutcome: judgement.outcome,
        nextAttemptAt: delay === null ? null : new Date(now.getTime() + delay),
        succeededAt: success ? now : null,
        updatedAt: now,
      })
      .where(and(eq(d.id, delivery.id), eq(d.status, 'pending'), eq(d.attempts, delivery.attempts)))
      .returning({ id: d.id });
    if (!updated) return null;
    await tx.insert(schema.webhookAttempts).values({
      tenantId,
      deliveryId: delivery.id,
      attempt,
      startedAt: result.startedAt,
      durationMs: result.durationMs,
      statusCode: judgement.statusCode,
      outcome: judgement.outcome,
      error: judgement.error,
      responseExcerpt: result.excerpt,
    });
    if (!options.health) return { status, disabled: null };
    return { status, disabled: await this.updateHealth(tx, delivery.endpointId, judgement) };
  }

  private async updateHealth(
    tx: TenantTx,
    endpointId: string,
    judgement: Judgement,
  ): Promise<'failing' | 'gone' | null> {
    const now = this.clock();
    const e = schema.webhookEndpoints;
    if (judgement.outcome === 'succeeded') {
      await tx
        .update(e)
        .set({ consecutiveFailures: 0, failingSince: null, lastSuccessAt: now, updatedAt: now })
        .where(eq(e.id, endpointId));
      return null;
    }
    const [endpoint] = await tx
      .update(e)
      .set({
        consecutiveFailures: sql`${e.consecutiveFailures} + 1`,
        failingSince: sql`coalesce(${e.failingSince}, ${now.toISOString()}::timestamptz)`,
        lastFailureAt: now,
        updatedAt: now,
      })
      .where(and(eq(e.id, endpointId), eq(e.status, 'active')))
      .returning();
    if (!endpoint) return null;
    const reason = judgement.gone
      ? 'gone'
      : shouldDisable({
            consecutiveFailures: endpoint.consecutiveFailures,
            failingSince: endpoint.failingSince,
            now,
            afterFailures: this.config.WEBHOOK_DISABLE_AFTER_FAILURES,
            afterHours: this.config.WEBHOOK_DISABLE_AFTER_HOURS,
          })
        ? 'failing'
        : null;
    if (!reason) return null;
    await this.disable(tx, endpoint, reason, { type: 'system', id: 'webhooks' });
    return reason;
  }

  /** Turns an endpoint off and cancels its pending deliveries (they can be replayed later). */
  async disable(
    tx: TenantTx,
    endpoint: EndpointRow,
    reason: 'manual' | 'failing' | 'gone',
    actor: { type: 'staff' | 'system'; id: string },
  ): Promise<void> {
    const now = this.clock();
    const e = schema.webhookEndpoints;
    await tx
      .update(e)
      .set({
        status: 'disabled',
        disabledReason: reason,
        disabledAt: now,
        updatedAt: now,
        version: sql`${e.version} + 1`,
      })
      .where(eq(e.id, endpoint.id));
    const d = schema.webhookDeliveries;
    await tx
      .update(d)
      .set({ status: 'cancelled', nextAttemptAt: null, updatedAt: now })
      .where(and(eq(d.endpointId, endpoint.id), eq(d.status, 'pending')));
    await appendAudit(tx, {
      actorType: actor.type,
      actorId: actor.id,
      action: 'webhook.endpoint_disabled',
      targetType: 'webhook_endpoint',
      targetId: toPublicId('webhookEndpoint', endpoint.id),
      outcome: 'success',
      data: {
        reason,
        consecutiveFailures: endpoint.consecutiveFailures,
        failingSince: endpoint.failingSince?.toISOString() ?? null,
      },
    });
    if (reason !== 'manual') {
      this.logger.warn(`webhook endpoint ${endpoint.id} turned off: ${reason}`);
    }
  }
}

export { MAX_ATTEMPTS };
