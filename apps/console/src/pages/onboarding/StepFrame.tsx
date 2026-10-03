import { Button } from '@hamnivo/ui/components/button';
import { ArrowLeftIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { OnboardingStep } from '../../lib/setup';
import { ONBOARDING_STEPS } from '../../lib/setup-data';

/**
 * One step of the guided setup: what it is for, the step's own content and the two ways out that
 * every step has: back to the one before, and skip (nothing is lost; the step stays open in the
 * list and can be done later).
 */
export function StepFrame({
  step,
  children,
  onBack,
  onSkip,
  busy = false,
}: {
  step: OnboardingStep;
  children: ReactNode;
  onBack: (() => void) | null;
  onSkip: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const index = ONBOARDING_STEPS.indexOf(step) + 1;
  return (
    <section
      aria-labelledby="onboarding-step-title"
      data-testid="onboarding-step"
      data-step={step}
      className="flex min-w-0 flex-col gap-6 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
    >
      <header className="flex flex-col gap-1">
        <p className="text-sm text-text-secondary">
          {t('setup.onboarding.stepOf', { n: index, total: ONBOARDING_STEPS.length })}
        </p>
        <h2
          id="onboarding-step-title"
          tabIndex={-1}
          className="text-xl font-semibold text-text"
          data-testid="onboarding-step-title"
        >
          {t(`setup.onboarding.steps.${step}.title`)}
        </h2>
        <p className="max-w-prose text-sm text-text-secondary">
          {t(`setup.onboarding.steps.${step}.description`)}
        </p>
      </header>
      {children}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        {onBack ? (
          <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
            <ArrowLeftIcon aria-hidden="true" className="rtl:-scale-x-100" />
            {t('setup.onboarding.back')}
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="button"
          variant="ghost"
          onClick={onSkip}
          disabled={busy}
          data-testid="onboarding-skip"
        >
          {t('setup.onboarding.skip')}
        </Button>
      </footer>
    </section>
  );
}
