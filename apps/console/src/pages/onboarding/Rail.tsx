import { Link } from '@tanstack/react-router';
import { CheckIcon, MinusIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { stateOf, tally } from '../../lib/onboarding';
import type { OnboardingProgress, OnboardingStep } from '../../lib/setup';
import { ONBOARDING_STEPS } from '../../lib/setup-data';

/**
 * Where the owner is in the guided setup: every step in order, each marked done, skipped or still
 * to do, and the one being shown. Any step can be opened; nothing has to be done first.
 */
export function Rail({
  progress,
  current,
}: {
  progress: Pick<OnboardingProgress, 'steps'> | undefined;
  current: OnboardingStep | 'finished';
}) {
  const { t } = useTranslation();
  const counts = tally(progress);
  return (
    <nav aria-label={t('setup.onboarding.railLabel')} data-testid="onboarding-rail">
      <p className="mb-3 text-sm text-text-secondary" data-testid="onboarding-count">
        {t('setup.onboarding.count', { done: counts.done + counts.skipped, total: counts.total })}
      </p>
      <ol className="flex flex-col gap-1">
        {ONBOARDING_STEPS.map((step, index) => {
          const state = stateOf(progress, step);
          const isCurrent = step === current;
          return (
            <li key={step}>
              <Link
                to="/onboarding"
                search={{ step }}
                data-step={step}
                data-state={state}
                aria-current={isCurrent ? 'step' : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-surface-sunken ${
                  isCurrent ? 'bg-surface-sunken font-semibold text-text' : 'text-text'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                    state === 'done'
                      ? 'border-success bg-success-subtle text-success'
                      : state === 'skipped'
                        ? 'border-border bg-surface-sunken text-text-secondary'
                        : 'border-border text-text-secondary'
                  }`}
                >
                  {state === 'done' ? (
                    <CheckIcon className="size-3.5" />
                  ) : state === 'skipped' ? (
                    <MinusIcon className="size-3.5" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="min-w-0 flex-1">{t(`setup.onboarding.steps.${step}.name`)}</span>
                <span className="sr-only">
                  {state === 'done'
                    ? t('setup.onboarding.state.done')
                    : state === 'skipped'
                      ? t('setup.onboarding.state.skipped')
                      : t('setup.onboarding.state.todo')}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
