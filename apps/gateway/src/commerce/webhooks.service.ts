import { createHash } from 'node:crypto';
import { type NormalizedEvent, WebhookSignatureError } from '@hamnivo/adapters/commerce';
import { type Db, fromPublicId, resolveMerchantConnection, schema, withTenant } from '@hamnivo/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AppError } from '../common/app-error.js';
import { APP_DB, CLOCK, type Clock, REDIS } from '../tokens.js';
import { eventToJson } from './events.js';
import { CommerceProviders } from './providers.service.js';

export const COMMERCE_EVENT_SIGNAL = 'hamnivo:commerce-events';

/**
 * Payment-provider webhooks (C08): the signature is checked over the exact raw bytes with the
 * merchant's signing secret, the event is stored once per provider event id, and the request is
 * acknowledged at once. Processing happens in the worker; a replayed delivery changes nothing.
 */
@Injectable()
export class CommerceWebhooksService {
  private readonly logger = new Logger(CommerceWebhooksService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly providers: CommerceProviders,
  ) {}

  async receive(input: {
    merchantPublicId: string;
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer | undefined;
  }): Promise<{ received: true; duplicate: boolean }> {
    const connectionId = fromPublicId('merchant', input.merchantPublicId);
    const resolution = await resolveMerchantConnection(this.db, connectionId);
    if (!resolution) throw new AppError('NOT_FOUND', { detail: 'Unknown merchant connection.' });
    const tenantId = resolution.tenantId;
    const rawBody = input.rawBody ?? Buffer.alloc(0);
    const prepared = await withTenant(this.db, { tenantId, actorId: 'provider' }, async (tx) => {
      const [merchant] = await tx
        .select()
        .from(schema.merchantConnections)
        .where(eq(schema.merchantConnections.id, connectionId));
      if (!merchant) return null;
      const secret = await this.providers.webhookSecret(tx, merchant);
      if (!secret) return { merchant, secret: null, provider: null };
      return { merchant, secret, provider: await this.providers.forConnection(tx, merchant) };
    });
    if (!prepared) throw new AppError('NOT_FOUND', { detail: 'Unknown merchant connection.' });
    if (!prepared.secret || !prepared.provider) {
      throw new AppError('AUTH_REQUIRED', {
        detail: 'Webhook signing is not set up for this shop.',
      });
    }
    let event: NormalizedEvent;
    try {
      event = prepared.provider.verifyWebhook(
        rawBody,
        input.headers,
        prepared.secret,
        this.clock(),
      );
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        throw new AppError('AUTH_REQUIRED', {
          detail:
            error.reason === 'stale' ? 'Stale webhook timestamp.' : 'Invalid webhook signature.',
        });
      }
      throw new AppError('VALIDATION_FAILED', { detail: 'The webhook body could not be read.' });
    }
    // An event from another provider account (for example a connected account) is kept as
    // evidence but never applied to this shop's orders.
    const foreign =
      event.account !== null &&
      prepared.merchant.providerAccountId !== null &&
      event.account !== prepared.merchant.providerAccountId;
    const now = this.clock();
    const inserted = await withTenant(this.db, { tenantId, actorId: 'provider' }, (tx) =>
      tx
        .insert(schema.commerceEvents)
        .values({
          tenantId,
          merchantConnectionId: connectionId,
          providerEventId: event.id,
          eventType: event.type,
          providerType: event.providerType.slice(0, 80),
          payload: eventToJson(event),
          bodyHash: createHash('sha256').update(rawBody).digest(),
          occurredAt: event.occurredAt,
          ...(foreign || event.type === 'ignored'
            ? {
                processedAt: now,
                outcome: 'ignored' as const,
                lastError: foreign ? 'account_mismatch' : null,
              }
            : {}),
        })
        .onConflictDoNothing()
        .returning({ id: schema.commerceEvents.id }),
    );
    if (inserted.length > 0 && !foreign && event.type !== 'ignored') {
      await this.redis.publish(COMMERCE_EVENT_SIGNAL, tenantId).catch((error: unknown) => {
        this.logger.warn(`commerce event signal failed: ${String(error)}`);
      });
    }
    return { received: true, duplicate: inserted.length === 0 };
  }
}
