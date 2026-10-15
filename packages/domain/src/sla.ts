import {
  addBusinessMinutes,
  type BusinessHours,
  businessMinutesBetween,
  isOpen,
} from './business-hours.js';

/**
 * Reply-time targets (H12). Each brand sets, per priority, how soon a person should give the first
 * reply and each next reply. The clock only runs while a customer is waiting for a person, inside
 * the brand's business hours; snoozing pauses it, and resolving or handing the conversation back
 * to the AI ends it. Hamnivo keeps the clock itself (Chatwoot CE has no SLA).
 */

export const SLA_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type SlaPriority = (typeof SLA_PRIORITIES)[number];
export type SlaKind = 'first_reply' | 'next_reply';

/** Minutes for each kind of reply; null means no target. */
export interface SlaTarget {
  firstReplyMinutes: number | null;
  nextReplyMinutes: number | null;
}
export type SlaTargets = Record<SlaPriority, SlaTarget>;

/** The clock as it is stored with the conversation. */
export interface SlaClock {
  kind: SlaKind;
  startedAt: Date;
  targetMinutes: number;
  /** Set while the conversation is snoozed. */
  pausedAt: Date | null;
  /** Whole working minutes spent snoozed so far (rounded up); the deadline moves out by as much. */
  pausedMinutes: number;
  /** Null while paused, or when the schedule never opens again. */
  dueAt: Date | null;
  /** When the deadline passed; kept until the clock ends. */
  breachedAt: Date | null;
}

export type SlaOwnerMode = 'AI_ACTIVE' | 'WAITING_HUMAN' | 'HUMAN_ACTIVE' | 'PAUSED';
export type SlaStatus = 'open' | 'pending' | 'snoozed' | 'resolved';

/** What the clock is derived from. */
export interface SlaFacts {
  ownerMode: SlaOwnerMode;
  status: SlaStatus;
  priority: SlaPriority | null;
  lastCustomerMessageAt: Date | null;
  /** The last public reply a person wrote; AI and automation replies never count. */
  lastHumanReplyAt: Date | null;
  ownerChangedAt: Date | null;
  createdAt: Date;
}

/** A conversation without a priority is held to the "normal" (medium) targets. */
export function slaPriorityOf(priority: SlaPriority | null): SlaPriority {
  return priority ?? 'medium';
}

const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

/**
 * The clock after something changed. It is recomputed from the stored facts every time, so a
 * missed update is put right by the next one.
 * - No clock while the conversation is resolved, or while the AI has it (and then the next
 *   hand-off starts a first reply again: `resetHumanReply`).
 * - It runs while the customer's last message is newer than the last reply a person wrote: a
 *   first reply when no person has replied yet, otherwise a next reply.
 * - A running clock of the same kind keeps its start; a first reply otherwise starts when the
 *   customer wrote or the conversation came to people, whichever is later.
 * - Snoozing pauses it; the working minutes spent paused move the deadline out.
 */
export function nextSlaClock(input: {
  clock: SlaClock | null;
  facts: SlaFacts;
  policy: SlaTargets | null;
  hours: BusinessHours | null;
  now: Date;
}): { clock: SlaClock | null; resetHumanReply: boolean } {
  const { clock, facts, policy, hours, now } = input;
  if (facts.status === 'resolved') return { clock: null, resetHumanReply: false };
  if (facts.ownerMode === 'AI_ACTIVE') {
    return { clock: null, resetHumanReply: facts.lastHumanReplyAt !== null };
  }
  const customerAt = facts.lastCustomerMessageAt;
  const waiting =
    customerAt !== null &&
    (facts.lastHumanReplyAt === null || customerAt.getTime() > facts.lastHumanReplyAt.getTime());
  if (!waiting || !policy) return { clock: null, resetHumanReply: false };
  const kind: SlaKind = facts.lastHumanReplyAt ? 'next_reply' : 'first_reply';
  const target = policy[slaPriorityOf(facts.priority)];
  const targetMinutes = kind === 'first_reply' ? target.firstReplyMinutes : target.nextReplyMinutes;
  if (targetMinutes === null || targetMinutes === undefined) {
    return { clock: null, resetHumanReply: false };
  }
  const same = clock?.kind === kind ? clock : null;
  const startedAt =
    same?.startedAt ??
    (kind === 'first_reply'
      ? later(customerAt, facts.ownerChangedAt ?? facts.createdAt)
      : customerAt);
  let pausedAt = same?.pausedAt ?? null;
  let pausedMinutes = same?.pausedMinutes ?? 0;
  if (facts.status === 'snoozed') {
    pausedAt ??= now;
  } else if (pausedAt) {
    pausedMinutes += Math.ceil(businessMinutesBetween(hours, pausedAt, now));
    pausedAt = null;
  }
  const dueAt = pausedAt
    ? null
    : addBusinessMinutes(hours, startedAt, targetMinutes + pausedMinutes);
  const overdue = dueAt !== null && dueAt.getTime() <= now.getTime();
  const breachedAt = pausedAt
    ? (same?.breachedAt ?? null)
    : overdue
      ? (same?.breachedAt ?? now)
      : null;
  return {
    clock: { kind, startedAt, targetMinutes, pausedAt, pausedMinutes, dueAt, breachedAt },
    resetHumanReply: false,
  };
}

export type SlaState = 'running' | 'paused' | 'outside_hours';

/**
 * How the clock reads now: running, paused (snoozed) or outside the working hours, the deadline,
 * and the working minutes left (negative once overdue), so a screen can count down only while the
 * clock really runs.
 */
export function slaView(
  clock: SlaClock,
  hours: BusinessHours | null,
  now: Date,
): { state: SlaState; dueAt: Date | null; businessMinutesLeft: number; breached: boolean } {
  const state: SlaState = clock.pausedAt
    ? 'paused'
    : clock.dueAt === null || (hours !== null && !isOpen(hours, now))
      ? 'outside_hours'
      : 'running';
  const due = clock.dueAt;
  const breached = due !== null && due.getTime() <= now.getTime();
  const left = due
    ? breached
      ? -businessMinutesBetween(hours, due, now)
      : businessMinutesBetween(hours, now, due)
    : 0;
  return { state, dueAt: due, businessMinutesLeft: Math.round(left), breached };
}
