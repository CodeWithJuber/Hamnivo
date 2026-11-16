import { schema, type TenantTx } from '@hamnivo/db';

/**
 * Published after a commit that may have queued outbox work (JournalService.notify does it for
 * every journaled change), so the worker starts at once instead of on its next look.
 */
export const OUTBOX_SIGNAL = 'hamnivo:outbox';

export interface OutboxMessage {
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  headers?: Record<string, unknown>;
  /** Not relayed before this time (a delayed event); due at once when left out. */
  availableAt?: Date;
}

/**
 * Records an event in the same transaction as the change it announces (transactional outbox);
 * the worker relays it at least once. Consumers deduplicate with processed_events.
 */
export async function enqueueOutbox(
  tx: TenantTx,
  tenantId: string,
  message: OutboxMessage,
): Promise<void> {
  await tx.insert(schema.outboxEvents).values({
    tenantId,
    topic: message.topic,
    aggregateType: message.aggregateType,
    aggregateId: message.aggregateId,
    payload: message.payload,
    headers: message.headers ?? {},
    ...(message.availableAt ? { availableAt: message.availableAt } : {}),
  });
}
