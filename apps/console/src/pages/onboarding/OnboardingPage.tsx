import { Button } from '@hamnivo/ui/components/button';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import {
  currentStep,
  nextStep,
  type ProgressChange,
  previousStep,
  stateOf,
  tally,
  useUpdateOnboarding,
} from '../../lib/onboarding';
import { useBrands } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { useOnboarding } from '../../lib/setup';
import {
  type ChatLanguage,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_RADIUS,
  DEFAULT_WIDGET_TEXT,
  ONBOARDING_STEPS,
} from '../../lib/setup-data';
import { useTenant } from '../../lib/tenant';
import type { Brand } from '../../lib/types';
import { WidgetPreview } from '../settings/WidgetPreview';
import { AiKeyStep } from './AiKeyStep';
import { BrandStep } from './BrandStep';
import { EngineStep } from './EngineStep';
import { InstallStep } from './InstallStep';
import { Rail } from './Rail';
import { StepFrame } from './StepFrame';
import { TeamStep } from './TeamStep';
import { TestChatStep } from './TestChatStep';

function NeedsBrand({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3" data-testid="onboarding-needs-brand">
      <p className="text-sm text-text">{t('setup.onboarding.needsBrand')}</p>
      <div>
        <Button type="button" variant="secondary" onClick={onAdd}>
          {t('setup.onboarding.toBrand')}
        </Button>
      </div>
    </div>
  );
}

/** The closing page: what was done, what was skipped, and a way back into each skipped step. */
function Finished({ progress }: { progress: Parameters<typeof tally>[0] }) {
  const { t } = useTranslation();
  const counts = tally(progress);
  const open = counts.skipped + counts.todo;
  return (
    <section
      aria-labelledby="onboarding-step-title"
      data-testid="onboarding-finished"
      className="flex min-w-0 flex-col gap-5 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
    >
      <header className="flex flex-col gap-1">
        <h2 id="onboarding-step-title" tabIndex={-1} className="text-xl font-semibold text-text">
          {open === 0
            ? t('setup.onboarding.finished.title')
            : t('setup.onboarding.finished.titleOpen')}
        </h2>
        <p className="max-w-prose text-sm text-text-secondary">
          {open === 0
            ? t('setup.onboarding.finished.description')
            : t('setup.onboarding.finished.descriptionOpen', { n: open })}
        </p>
      </header>
      <ul className="flex flex-col gap-2">
        {ONBOARDING_STEPS.map((step) => {
          const state = stateOf(progress, step);
          return (
            <li
              key={step}
              data-step={step}
              data-state={state}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span className="text-text">{t(`setup.onboarding.steps.${step}.name`)}</span>
              {state === 'done' ? (
                <span className="text-success">{t('setup.onboarding.state.done')}</span>
              ) : (
                <Link
                  to="/onboarding"
                  search={{ step }}
                  className="text-link underline underline-offset-4 hover:no-underline"
                >
                  {state === 'skipped'
                    ? t('setup.onboarding.finished.doSkipped')
                    : t('setup.onboarding.finished.doTodo')}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <div>
        <Button asChild>
          <Link to="/overview">{t('setup.onboarding.finished.go')}</Link>
        </Button>
      </div>
    </section>
  );
}

/**
 * The guided setup (board 01): workspace, brand and website, chat engine, AI key, test chat,
 * install and team, with the owner's place kept at the gateway. One next action at a time, every
 * step skippable, and "Finish later" always in reach: leaving never throws away what was done.
 */
export function OnboardingPage() {
  const { t, i18n } = useTranslation();
  const { can, tenant } = useTenant();
  const progress = useOnboarding();
  const update = useUpdateOnboarding();
  const brands = useBrands();
  const search = useSearch({ from: '/_studio/onboarding' });
  const navigate = useNavigate({ from: '/onboarding' });
  const first = useRef(true);

  const active = (brands.data?.items ?? []).filter((brand) => brand.status === 'active');
  const brand: Brand | undefined =
    active.find((candidate) => candidate.id === progress.data?.brandId) ?? active[0];
  const step = currentStep(search.step, progress.data);

  // Focus follows the step, so a screen reader starts at its title (the page itself does not
  // change, only what is in it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the step changes
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.getElementById('onboarding-step-title')?.focus();
  }, [step]);

  const go = (to: (typeof ONBOARDING_STEPS)[number] | 'finished') =>
    navigate({ search: { step: to } });

  /** Records the step as done or skipped and shows the next one (or the closing page). */
  const advance = async (state: 'done' | 'skipped', extra: ProgressChange = {}) => {
    if (step === 'finished') return;
    const next = nextStep(step);
    try {
      await update.mutateAsync({
        steps: { [step]: state },
        ...extra,
        ...(next ? {} : { finished: true }),
      });
    } catch {
      return; // the reason is shown above the step
    }
    await go(next ?? 'finished');
  };

  const back = step === 'finished' ? null : previousStep(step);
  const lang = (['en', 'ar', 'hi', 'ur'] as const).includes(i18n.language as ChatLanguage)
    ? (i18n.language as ChatLanguage)
    : 'en';

  const content = (() => {
    if (step === 'finished') return <Finished progress={progress.data} />;
    const frame = (children: React.ReactNode) => (
      <StepFrame
        step={step}
        onBack={back ? () => go(back) : null}
        onSkip={() => void advance('skipped')}
        busy={update.isPending}
      >
        {children}
      </StepFrame>
    );
    const done = () => advance('done');
    switch (step) {
      case 'workspace':
        return frame(
          <div className="flex flex-col gap-4">
            <p className="text-sm text-text" data-testid="workspace-ready">
              {t('setup.onboarding.workspace.ready', { name: tenant.name })}
            </p>
            <div>
              <Button type="button" onClick={() => void done()} busy={update.isPending}>
                {t('setup.onboarding.continue')}
              </Button>
            </div>
          </div>,
        );
      case 'brand':
        return frame(
          <BrandStep
            brands={active}
            chosenId={brand?.id}
            onChoose={(brandId) => update.mutate({ brandId })}
            onDone={(brandId) => advance('done', { brandId })}
          />,
        );
      case 'engine':
        return frame(
          brand ? (
            <EngineStep key={brand.id} brand={brand} onDone={done} />
          ) : (
            <NeedsBrand onAdd={() => go('brand')} />
          ),
        );
      case 'aikey':
        return frame(<AiKeyStep onDone={done} />);
      case 'testchat':
        return frame(
          brand ? (
            <TestChatStep brand={brand} onDone={done} />
          ) : (
            <NeedsBrand onAdd={() => go('brand')} />
          ),
        );
      case 'install':
        return frame(
          brand ? (
            <InstallStep brand={brand} onDone={done} />
          ) : (
            <NeedsBrand onAdd={() => go('brand')} />
          ),
        );
      case 'team':
        return frame(<TeamStep onDone={done} />);
    }
  })();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('setup.onboarding.title')}
        description={t('setup.onboarding.description')}
        actions={
          <Button asChild variant="ghost">
            <Link to="/overview" data-testid="finish-later">
              {t('setup.onboarding.later')}
            </Link>
          </Button>
        }
      />
      <QueryState
        query={progress}
        label={t('setup.onboarding.loading')}
        permitted={can('brands.manage')}
      >
        {(data) => (
          <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)_18rem]">
            <Rail progress={data} current={step} />
            <div className="flex min-w-0 flex-col gap-4">
              <ActionError error={isCancelled(update.error) ? null : update.error} />
              {content}
            </div>
            <aside
              aria-label={t('setup.appearance.previewTitle')}
              className="hidden min-w-0 lg:block"
              data-testid="onboarding-preview"
            >
              <WidgetPreview
                look={{
                  name: brand?.name ?? tenant.name,
                  colour: DEFAULT_PRIMARY_COLOR,
                  on: '#FFFFFF',
                  radius: DEFAULT_RADIUS,
                  logoUrl: null,
                  greeting: DEFAULT_WIDGET_TEXT.greeting[lang],
                  away: '',
                  showAway: false,
                  csat: false,
                  privacyUrl: null,
                  lang,
                }}
              />
            </aside>
          </div>
        )}
      </QueryState>
    </div>
  );
}
