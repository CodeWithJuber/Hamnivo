import type { TenantTx } from '@hamnivo/db';
import { enqueueOutbox } from '../outbox/outbox.js';
export const WORKFLOW_TOPIC = 'workflow.run';
export const WORKFLOW_EVENT_TOPIC = 'workflow.event';
export interface WorkflowEvent {
  conversationId: string;
  event: 'chat_started' | 'customer_message' | 'chat_closed' | 'offline_message';
  ref: string;
}
/** Call in the same transaction as the authoritative conversation event. */
export async function queueWorkflowEvent(
  tx: TenantTx,
  tenantId: string,
  event: WorkflowEvent,
): Promise<void> {
  await enqueueOutbox(tx, tenantId, {
    topic: WORKFLOW_EVENT_TOPIC,
    aggregateType: 'conversation',
    aggregateId: event.conversationId,
    payload: { ...event },
  });
}
