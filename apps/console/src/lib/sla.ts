/**
 * Reply-time targets (H12) in Studio: each brand's targets, the clock a conversation shows, and the
 * urgent conversations nobody has taken (HNV-08-02). The gateway keeps the clocks in business time;
 * Studio only counts down the wall-clock time to the deadline it was given.
 */
import type * as C from '@hamnivo/contracts';
import { useEffect, useState } from 'react';
import { api } from './api';
import { inboxKeys } from './inbox';
import { keys, useStudioMutation, useStudioQuery } from './queries';
import { useTenant } from './tenant';

export type InboxSla = C.InboxSla;
export type SlaPolicy = C.SlaPolicy;
export type SlaTargets = C.SlaPolicy['targets'];
export type SlaPriority = keyof SlaTargets;
export type UrgentList = C.UrgentList;
export type ProblemOwner = C.ProblemOwner;

/** The priorities a brand sets targets for, most urgent first. */
export const SLA_PRIORITIES: readonly SlaPriority[] = ['urgent', 'high', 'medium', 'low'];
/** The longest target the gateway accepts: seven days, in minutes. */
export const MAX_TARGET_MINUTES = 10_080;

/** How a clock reads: its words, its tone, and the minutes those words count. */
export type SlaReading =
  | { kind: 'paused' }
  | { kind: 'outsideHours' }
  | { kind: 'overdue'; minutes: number }
  | { kind: 'dueNow' }
  | { kind: 'dueSoon'; minutes: number }
  | { kind: 'dueIn'; minutes: number };

/**
 * What a clock says now. A running clock counts the wall-clock time to its deadline; it is
 * "soon" in its last fifth (at least the last five minutes), and overdue once the deadline passed
 * or the gateway says so.
 */
export function readSla(sla: InboxSla, now = Date.now()): SlaReading {
  if (sla.state === 'paused') return { kind: 'paused' };
  if (sla.state === 'outside_hours' || !sla.dueAt) {
    return sla.breached ? { kind: 'overdue', minutes: 0 } : { kind: 'outsideHours' };
  }
  const left = (new Date(sla.dueAt).getTime() - now) / 60_000;
  if (sla.breached || left < 0) return { kind: 'overdue', minutes: Math.max(0, Math.round(-left)) };
  const minutes = Math.ceil(left);
  if (minutes <= 0) return { kind: 'dueNow' };
  return minutes <= Math.max(5, sla.targetMinutes / 5)
    ? { kind: 'dueSoon', minutes }
    : { kind: 'dueIn', minutes };
}

/** The time now, again every `everyMs` while a running clock is shown. */
export function useNow(active: boolean, everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}

// ------------------------------------------------------------------ brand targets

export const slaKeys = {
  policy: (brandId: string) => ['brands', brandId, 'sla-policy'] as const,
  urgent: ['inbox', 'list', 'urgent'] as const,
};

const policyPath = (brandId: string) =>
  `/v1/admin/brands/${encodeURIComponent(brandId)}/sla-policy`;

export function useSlaPolicy(brandId: string) {
  const { can } = useTenant();
  return useStudioQuery<SlaPolicy>(slaKeys.policy(brandId), policyPath(brandId), {
    enabled: brandId !== '' && can('inbox.manage'),
  });
}

export function useSaveSlaPolicy(brandId: string) {
  return useStudioMutation<C.SetSlaPolicyRequest, SlaPolicy>(
    (body, tenant) => api<SlaPolicy>(policyPath(brandId), { method: 'PUT', tenant, body }),
    // New targets move every open clock of the brand: the inbox reloads with them.
    [slaKeys.policy(brandId), keys.brands, inboxKeys.lists],
  );
}

// ------------------------------------------------------------------ urgent, nobody has it

/**
 * Urgent conversations waiting for a person, soonest deadline first (HNV-08-02). Under the inbox
 * lists' key, so the live stream reloads it with them.
 */
export const useUrgent = (enabled: boolean) =>
  useStudioQuery<UrgentList>(slaKeys.urgent, '/v1/inbox/urgent', { enabled });

// ------------------------------------------------------------------ the targets form

export type SlaColumn = 'firstReplyMinutes' | 'nextReplyMinutes';
export const SLA_COLUMNS: readonly SlaColumn[] = ['firstReplyMinutes', 'nextReplyMinutes'];
export type SlaUnit = 'minutes' | 'hours';

/** One target as typed: an amount (empty for no target) and its unit. */
export interface TargetDraft {
  amount: string;
  unit: SlaUnit;
}
export type TargetsDraft = Record<SlaPriority, Record<SlaColumn, TargetDraft>>;

/** A stored target as the form shows it: whole hours in hours, anything else in minutes. */
export function draftOfTarget(minutes: number | null): TargetDraft {
  if (minutes === null) return { amount: '', unit: 'minutes' };
  return minutes >= 60 && minutes % 60 === 0
    ? { amount: String(minutes / 60), unit: 'hours' }
    : { amount: String(minutes), unit: 'minutes' };
}

export function draftOfTargets(targets: SlaTargets): TargetsDraft {
  const draft = {} as TargetsDraft;
  for (const priority of SLA_PRIORITIES) {
    draft[priority] = {
      firstReplyMinutes: draftOfTarget(targets[priority].firstReplyMinutes),
      nextReplyMinutes: draftOfTarget(targets[priority].nextReplyMinutes),
    };
  }
  return draft;
}

/**
 * A typed target in minutes: null when empty, `undefined` when it is not a whole number from one
 * minute to seven days.
 */
export function minutesOfTarget(target: TargetDraft): number | null | undefined {
  const text = target.amount.trim();
  if (text === '') return null;
  if (!/^\d+$/.test(text)) return undefined;
  const minutes = Number(text) * (target.unit === 'hours' ? 60 : 1);
  return minutes >= 1 && minutes <= MAX_TARGET_MINUTES ? minutes : undefined;
}

/** The cells that cannot be saved, in the order the form shows them. */
export function problemsOfTargets(
  draft: TargetsDraft,
): { priority: SlaPriority; column: SlaColumn }[] {
  return SLA_PRIORITIES.flatMap((priority) =>
    SLA_COLUMNS.filter((column) => minutesOfTarget(draft[priority][column]) === undefined).map(
      (column) => ({ priority, column }),
    ),
  );
}

/** The targets to save; call only when there are no problems. */
export function bodyOfTargets(draft: TargetsDraft): SlaTargets {
  const body = {} as SlaTargets;
  for (const priority of SLA_PRIORITIES) {
    body[priority] = {
      firstReplyMinutes: minutesOfTarget(draft[priority].firstReplyMinutes) ?? null,
      nextReplyMinutes: minutesOfTarget(draft[priority].nextReplyMinutes) ?? null,
    };
  }
  return body;
}
