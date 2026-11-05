import { schema, type TenantTx } from '@hamnivo/db';
import { and, eq, isNotNull } from 'drizzle-orm';
import { enqueueOutbox } from '../outbox/outbox.js';
import { queueWorkflowEvent } from '../workflows/workflow-events.js';

/** Outbox topic for chat automations (G21), handled by `AutomationRunner`. */
export const AUTOMATION_TOPIC = 'automation.event';

/**
 * What happened in a conversation, for the chat rules. `customer_message` is internal: each
 * customer message schedules the brand's "waiting for a reply" checks, which come back later as
 * `customer_waiting` for one rule.
 */
export type AutomationEventPayload =
  | {
      conversationId: string;
      event: 'chat_started' | 'chat_closed' | 'offline_message';
      /** What caused it (a message or a status change), for the logs. */
      ref: string;
    }
  | { conversationId: string; event: 'customer_message'; ref: string; ledgerId: string }
  | {
      conversationId: string;
      event: 'customer_waiting';
      ref: string;
      automationId: string;
      /** The customer's message in Chatwoot; anything said to them after it ends the wait. */
      afterMessage: number;
    };

/** Whether the brand has a chat rule that runs; nothing is queued for brands without one. */
export async function hasChatRules(tx: TenantTx, brandId: string): Promise<boolean> {
  const a = schema.automations;
  const [one] = await tx
    .select({ id: a.id })
    .from(a)
    .where(
      and(
        eq(a.brandId, brandId),
        eq(a.kind, 'conversation'),
        eq(a.enabled, true),
        isNotNull(a.publishedVersionId),
      ),
    )
    .limit(1);
  return one !== undefined;
}

/** Queues an event for the brand's chat rules, in the transaction that records what happened. */
export async function queueAutomationEvent(
  tx: TenantTx,
  tenantId: string,
  /** Null for a conversation Hamnivo did not start for a brand (imported), which has no rules. */
  brandId: string | null,
  payload: AutomationEventPayload,
  availableAt?: Date,
): Promise<void> {
  if (!brandId) return;
  if (payload.event !== 'customer_waiting') {
    await queueWorkflowEvent(tx, tenantId, payload);
  }
  if (!(await hasChatRules(tx, brandId))) return;
  await enqueueOutbox(tx, tenantId, {
    topic: AUTOMATION_TOPIC,
    aggregateType: 'conversation',
    aggregateId: payload.conversationId,
    payload: { ...payload },
    ...(availableAt ? { availableAt } : {}),
  });
}
