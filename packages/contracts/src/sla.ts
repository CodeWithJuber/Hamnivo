import { z } from 'zod';
import { Timestamp } from './common.js';

/**
 * Reply-time targets (H12): per brand and priority, how soon a person should give the first reply
 * and each next reply. Minutes count only inside the brand's business hours; snoozing pauses the
 * clock, and resolving or handing the conversation to the AI ends it.
 */

/** Minutes, 1 minute to 7 days; null: no target. */
export const SlaMinutes = z.int().min(1).max(10_080).nullable();

export const SlaTarget = z
  .object({ firstReplyMinutes: SlaMinutes, nextReplyMinutes: SlaMinutes })
  .meta({ id: 'SlaTarget' });

/** Targets per priority; `medium` also applies to conversations without a priority. */
export const SlaTargets = z
  .object({ urgent: SlaTarget, high: SlaTarget, medium: SlaTarget, low: SlaTarget })
  .meta({ id: 'SlaTargets' });
export type SlaTargets = z.infer<typeof SlaTargets>;

export const SlaPolicy = z
  .object({
    enabled: z.boolean(),
    targets: SlaTargets,
    /** Null until someone saves targets for the brand. */
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: 'SlaPolicy' });
export type SlaPolicy = z.infer<typeof SlaPolicy>;

export const SetSlaPolicyRequest = z
  .object({ enabled: z.boolean(), targets: SlaTargets })
  .meta({ id: 'SetSlaPolicyRequest' });
export type SetSlaPolicyRequest = z.infer<typeof SetSlaPolicyRequest>;

/** The reply-time clock of a conversation, as it reads now. */
export const InboxSla = z
  .object({
    kind: z.enum(['first_reply', 'next_reply']),
    /** `outside_hours`: the brand is closed, so the clock waits (and no deadline when it never opens). */
    state: z.enum(['running', 'paused', 'outside_hours']),
    dueAt: Timestamp.nullable(),
    /** Working minutes until the deadline; negative once it has passed. */
    businessMinutesLeft: z.int(),
    breached: z.boolean(),
    targetMinutes: z.int().positive(),
  })
  .meta({ id: 'InboxSla' });
export type InboxSla = z.infer<typeof InboxSla>;
