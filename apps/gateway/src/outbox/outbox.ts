import { schema, type TenantTx } from '@hamnivo/db';

export interface OutboxMessage {
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  headers?: Record<string, unknown>;
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
  });
}
