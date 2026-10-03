import { createFileRoute } from '@tanstack/react-router';
import { isStep } from '../../lib/onboarding';
import type { OnboardingStep } from '../../lib/setup';
import { OnboardingPage } from '../../pages/onboarding/OnboardingPage';

export interface OnboardingSearch {
  /** The step being shown; without it, the first step still open. `finished` is the closing page. */
  step?: OnboardingStep | 'finished';
}

export const Route = createFileRoute('/_studio/onboarding')({
  validateSearch: (search: Record<string, unknown>): OnboardingSearch =>
    isStep(search.step) || search.step === 'finished'
      ? { step: search.step as OnboardingStep | 'finished' }
      : {},
  component: OnboardingPage,
});
