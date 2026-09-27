import {
  dedupeKey,
  parseChatwootEvent,
  redactChatwootPayload,
  verifyChatwootSignature,
} from '@hamnivo/chatwoot';
import { type Db, fromPublicId, resolveAuthorityConnection, schema, withTenant } from '@hamnivo/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppError } from '../common/app-error.js';
import { APP_DB, CLOCK, type Clock, REDIS } from '../tokens.js';
import { AuthorityRegistry } from './registry.js';

export type WebhookSource = 'account' | 'inbox' | 'bot';
export const INBOX_SIGNAL = 'hamnivo:integration-inbox';

const RESOLVE_TTL_MS = 60_000;

/**
 * Chatwoot webhook intake: verify the signature with the secret of that webhook source, store the
 * event once (deduplicated across the account, inbox and bot copies), acknowledge. Processing
 * happens in the worker, so Chatwoot's 5-second delivery timeout is never at risk.
 */
@Injectable()
export class IngressService {
  private readonly logger = new Logger(IngressService.name);
  private readonly resolved = new Map<string, { tenantId: string | null; expiresAt: number }>();

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
  ) {}

  private async tenantOf(connectionId: string): Promise<string | null> {
    const now = this.clock().getTime();
    const cached = this.resolved.get(connectionId);
    if (cached && cached.expiresAt > now) return cached.tenantId;
    const resolution = await resolveAuthorityConnection(this.db, connectionId);
    const tenantId = resolution && resolution.status !== 'disabled' ? resolution.tenantId : null;
    this.resolved.set(connectionId, { tenantId, expiresAt: now + RESOLVE_TTL_MS });
    return tenantId;
  }

  async receive(input: {
    connectionPublicId: string;
    source: WebhookSource;
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer | undefined;
  }): Promise<{ stored: boolean }> {
    const connectionId = fromPublicId('connection', input.connectionPublicId);
    const tenantId = await this.tenantOf(connectionId);
    if (!tenantId) throw new AppError('NOT_FOUND', { detail: 'Unknown connection.' });
    const runtime = await this.registry.get(tenantId, connectionId);
    const secrets =
      input.source === 'account'
        ? [runtime.accountWebhookSecret]
        : input.source === 'inbox'
          ? runtime.inboxes.map((i) => i.webhookSecret)
          : runtime.bots.map((b) => b.webhookSecret);
    const header = (name: string) => {
      const value = input.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const rawBody = input.rawBody ?? Buffer.alloc(0);
    const now = this.clock().getTime();
    const verdicts = secrets
      .filter((secret): secret is string => Boolean(secret))
      .map((secret) =>
        verifyChatwootSignature({
          secret,
          timestamp: header('x-chatwoot-timestamp'),
          signature: header('x-chatwoot-signature'),
          rawBody,
          now,
        }),
      );
    if (!verdicts.some((v) => v.ok)) {
      const reason = verdicts.find((v) => !v.ok && v.reason !== 'mismatch');
      throw new AppError('AUTH_REQUIRED', {
        detail:
          reason && !reason.ok && reason.reason === 'stale'
            ? 'Stale webhook timestamp.'
            : 'Invalid webhook signature.',
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new AppError('VALIDATION_FAILED', { detail: 'The webhook body is not JSON.' });
    }
    const event = parseChatwootEvent(payload);
    const deliveryId = header('x-chatwoot-delivery') ?? null;
    const key = dedupeKey(event, deliveryId);
    const eventName = String((payload as { event?: unknown }).event ?? 'unknown').slice(0, 80);
    const inserted = await withTenant(this.db, { tenantId }, (tx) =>
      tx
        .insert(schema.integrationInbox)
        .values({
          tenantId,
          connectionId,
          source: input.source,
          dedupeKey: key,
          eventType: eventName,
          deliveryId,
          payload: redactChatwootPayload(payload) as Record<string, unknown>,
        })
        .onConflictDoNothing()
        .returning({ id: schema.integrationInbox.id }),
    );
    if (inserted.length > 0) {
      await this.redis.publish(INBOX_SIGNAL, tenantId).catch((error: unknown) => {
        this.logger.warn(`inbox signal failed: ${String(error)}`);
      });
    }
    return { stored: inserted.length > 0 };
  }
}
