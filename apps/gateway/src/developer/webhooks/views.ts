import type { WebhookAttempt, WebhookDelivery, WebhookEventType } from '@hamnivo/contracts';
import { type schema, toPublicId } from '@hamnivo/db';
import type { z } from 'zod';
import { MAX_ATTEMPTS } from './delivery-rules.js';

type DeliveryRow = typeof schema.webhookDeliveries.$inferSelect;
type AttemptRow = typeof schema.webhookAttempts.$inferSelect;
type Outcome = z.infer<typeof WebhookAttempt>['outcome'];

export function deliveryView(row: DeliveryRow, endpointUrl: string, type: string): WebhookDelivery {
  return {
    id: toPublicId('webhookDelivery', row.id),
    endpointId: toPublicId('webhookEndpoint', row.endpointId),
    endpointUrl,
    eventId: toPublicId('event', row.eventId),
    eventType: type as WebhookEventType,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: MAX_ATTEMPTS,
    nextAttemptAt: row.status === 'pending' ? (row.nextAttemptAt?.toISOString() ?? null) : null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastStatusCode: row.lastStatusCode,
    lastOutcome: (row.lastOutcome as Outcome | null) ?? null,
    succeededAt: row.succeededAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    replayOf: row.replayOf ? toPublicId('webhookDelivery', row.replayOf) : null,
  };
}

export function attemptView(row: AttemptRow): z.infer<typeof WebhookAttempt> {
  return {
    attempt: row.attempt,
    startedAt: row.startedAt.toISOString(),
    durationMs: row.durationMs,
    statusCode: row.statusCode,
    outcome: row.outcome as Outcome,
    error: row.error,
    responseExcerpt: row.responseExcerpt,
  };
}
