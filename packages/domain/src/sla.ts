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
 * - A running clock of the same kind keeps its start, unless a person replied since it started; a
 *   first reply otherwise starts when the customer wrote or the conversation came to people,
 *   whichever is later.
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
  // A clock a person has replied to since it started has ended, even when the customer wrote
  // again before the reply was recorded: the next wait starts afresh.
  const answered =
    clock !== null &&
    facts.lastHumanReplyAt !== null &&
    facts.lastHumanReplyAt.getTime() > clock.startedAt.getTime();
  const same = clock?.kind === kind && !answered ? clock : null;
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

export type SlaOutcome = 'met' | 'missed' | 'stopped';

/**
 * How a clock that has just ended turned out (H12, O04), for reports. A person's reply after the
 * clock started ends it: met, or missed when more working time than the target went by (time
 * snoozed left out) or it had already gone overdue. Without such a reply it was stopped: the AI
 * took the chat back, it was resolved, or the targets were turned off.
 */
export function slaOutcomeOf(input: {
  clock: SlaClock;
  lastHumanReplyAt: Date | null;
  hours: BusinessHours | null;
  now: Date;
}): { outcome: SlaOutcome; endedAt: Date; businessMinutes: number } {
  const { clock, lastHumanReplyAt, hours, now } = input;
  const replied =
    lastHumanReplyAt !== null && lastHumanReplyAt.getTime() > clock.startedAt.getTime();
  const endedAt = replied && lastHumanReplyAt.getTime() < now.getTime() ? lastHumanReplyAt : now;
  const paused =
    clock.pausedMinutes +
    (clock.pausedAt ? Math.ceil(businessMinutesBetween(hours, clock.pausedAt, endedAt)) : 0);
  const working = Math.max(0, businessMinutesBetween(hours, clock.startedAt, endedAt) - paused);
  const overdue =
    working > clock.targetMinutes ||
    (clock.breachedAt !== null && clock.breachedAt.getTime() <= endedAt.getTime());
  return {
    outcome: replied ? (overdue ? 'missed' : 'met') : 'stopped',
    endedAt,
    businessMinutes: Math.round(working),
  };
}

/**
 * When an overdue conversation is moved (ADR 0016): `afterMinutes` working minutes after it went
 * overdue. Null when the schedule never opens again, so it is never moved.
 */
export function slaMoveAt(
  hours: BusinessHours | null,
  breachedAt: Date,
  afterMinutes: number,
): Date | null {
  return addBusinessMinutes(hours, breachedAt, afterMinutes);
}

export type SlaMoveDecision =
  | {
      kind: 'skip';
      why: 'policy_off' | 'clock_ended' | 'paused' | 'handled' | 'in_queue' | 'never_opens';
    }
  | { kind: 'wait'; until: Date }
  /** `requeue`: a waiting conversation becomes a new hand-off; `teamId`: the team it goes to. */
  | { kind: 'move'; requeue: boolean; teamId: string | null };

/**
 * Whether an overdue conversation is moved now (ADR 0016). Only the same overdue clock is moved,
 * and only while nobody has acted on it since it went overdue: a reply, the AI taking it back or
 * resolving ends the clock; snoozing pauses it; claiming, reassigning or another team changes its
 * owner (epoch) or team. A conversation someone has goes back to the queue (and to the team when
 * one is set); one already waiting moves only to another team, as a new hand-off, so the next
 * person is offered it. A team that can no longer take the brand's conversations means the queue.
 */
export function decideSlaMove(input: {
  /** As it was when it went overdue. */
  queued: { breachedAt: Date; epoch: number; teamId: string | null };
  current: {
    status: SlaStatus;
    ownerMode: SlaOwnerMode;
    epoch: number;
    teamId: string | null;
    clock: SlaClock | null;
  };
  /** The brand's setting now; null when the targets or the move are off. */
  move: { afterMinutes: number; teamId: string | null; teamUsable: boolean } | null;
  hours: BusinessHours | null;
  now: Date;
}): SlaMoveDecision {
  const { queued, current, move, hours, now } = input;
  if (!move) return { kind: 'skip', why: 'policy_off' };
  const clock = current.clock;
  if (
    (current.status !== 'open' && current.status !== 'pending') ||
    !clock?.breachedAt ||
    clock.breachedAt.getTime() !== queued.breachedAt.getTime()
  ) {
    return { kind: 'skip', why: 'clock_ended' };
  }
  if (clock.pausedAt) return { kind: 'skip', why: 'paused' };
  if (current.epoch !== queued.epoch || current.teamId !== queued.teamId) {
    return { kind: 'skip', why: 'handled' };
  }
  const at = slaMoveAt(hours, queued.breachedAt, move.afterMinutes);
  if (!at) return { kind: 'skip', why: 'never_opens' };
  if (at.getTime() > now.getTime()) return { kind: 'wait', until: at };
  const destination = move.teamId && move.teamUsable ? move.teamId : null;
  const otherTeam = destination !== null && destination !== current.teamId ? destination : null;
  if (current.ownerMode === 'HUMAN_ACTIVE') {
    return { kind: 'move', requeue: false, teamId: otherTeam };
  }
  if (current.ownerMode === 'AI_ACTIVE') return { kind: 'skip', why: 'clock_ended' };
  if (!otherTeam) return { kind: 'skip', why: 'in_queue' };
  return { kind: 'move', requeue: current.ownerMode === 'WAITING_HUMAN', teamId: otherTeam };
}
