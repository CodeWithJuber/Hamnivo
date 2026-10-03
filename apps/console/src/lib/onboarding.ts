/**
 * The guided setup (A01, board 01): seven steps an owner can do in order, skip, leave and come
 * back to. What was done or skipped is kept at the gateway, so a person who leaves and returns
 * (or opens Studio on another computer) carries on where they stopped. Nothing here blocks
 * anything: every step is skippable and the workspace works whatever was skipped.
 */

import { api } from './api';
import { useStudioMutation } from './queries';
import type { OnboardingProgress, OnboardingStep } from './setup';
import { setupKeys } from './setup';
import { ONBOARDING_STEPS } from './setup-data';

export type StepState = 'done' | 'skipped' | 'todo';

export const isStep = (value: unknown): value is OnboardingStep =>
  typeof value === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(value);

export const stateOf = (
  progress: Pick<OnboardingProgress, 'steps'> | undefined,
  step: OnboardingStep,
): StepState => progress?.steps[step] ?? 'todo';

/** The first step not yet dealt with, or null when every step is done or skipped. */
export function firstOpen(
  progress: Pick<OnboardingProgress, 'steps'> | undefined,
): OnboardingStep | null {
  return ONBOARDING_STEPS.find((step) => stateOf(progress, step) === 'todo') ?? null;
}

export function nextStep(step: OnboardingStep): OnboardingStep | null {
  return ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(step) + 1] ?? null;
}

export function previousStep(step: OnboardingStep): OnboardingStep | null {
  const index = ONBOARDING_STEPS.indexOf(step);
  return index > 0 ? (ONBOARDING_STEPS[index - 1] ?? null) : null;
}

export interface Tally {
  done: number;
  skipped: number;
  todo: number;
  total: number;
}

export function tally(progress: Pick<OnboardingProgress, 'steps'> | undefined): Tally {
  const out: Tally = { done: 0, skipped: 0, todo: 0, total: ONBOARDING_STEPS.length };
  for (const step of ONBOARDING_STEPS) out[stateOf(progress, step)] += 1;
  return out;
}

/** The step to show: the one in the address, else the first still open, else the closing page. */
export function currentStep(
  requested: unknown,
  progress: Pick<OnboardingProgress, 'steps'> | undefined,
): OnboardingStep | 'finished' {
  if (isStep(requested) || requested === 'finished') return requested;
  return firstOpen(progress) ?? 'finished';
}

export interface ProgressChange {
  steps?: Partial<Record<OnboardingStep, 'done' | 'skipped' | null>>;
  brandId?: string | null;
  finished?: boolean;
}

/** Marks steps done or skipped (or back to "not yet"), sets the brand being set up, or finishes. */
export function useUpdateOnboarding() {
  return useStudioMutation(
    (change: ProgressChange, tenant) =>
      api<OnboardingProgress>('/v1/admin/onboarding', { method: 'PUT', tenant, body: change }),
    [setupKeys.onboarding],
  );
}
