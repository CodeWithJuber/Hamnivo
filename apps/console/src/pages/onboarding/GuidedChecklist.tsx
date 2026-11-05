import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { SelectField } from '../../components/Fields';
import { ActionError } from '../../components/States';
import { useUpdateOnboarding } from '../../lib/onboarding';
import { useAgents, useAuthorityConnections, useSources } from '../../lib/queries';
import type { OnboardingProgress } from '../../lib/setup';
import { useTenant } from '../../lib/tenant';
export const USE_CASES = [
  'support',
  'lead',
  'billing',
  'service',
  'afterhours',
  'handoff',
] as const;
/** Readiness is computed from actual saved resources, independently from the legacy step tally. */
export function GuidedChecklist({
  progress,
  brandId,
}: {
  progress: OnboardingProgress;
  brandId: string | undefined;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const save = useUpdateOnboarding();
  const sources = useSources();
  const connections = useAuthorityConnections();
  const agents = useAgents();
  const knowledge = sources.data?.items
    .filter((s) => s.brandId === brandId && s.status === 'active' && s.visibility === 'public')
    .reduce((sum, s) => sum + s.documentCount, 0);
  const connected = connections.data?.items.some(
    (c) => c.status === 'active' && c.inboxes.some((i) => i.brandId === brandId),
  );
  const published = agents.data?.items.some(
    (a) =>
      a.brandId === brandId && a.isDefault && a.status === 'active' && a.publishedVersion !== null,
  );
  const state = (known: boolean | undefined) =>
    t(
      known === undefined
        ? 'agentic.checkUnknown'
        : known
          ? 'agentic.checkPresent'
          : 'agentic.checkMissing',
    );
  return (
    <section
      aria-labelledby="guided-title"
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 sm:p-6"
      data-testid="guided-checklist"
    >
      <h2 id="guided-title" className="text-lg font-semibold">
        {t('agentic.setup')}
      </h2>
      <p className="text-sm text-text-secondary">{t('agentic.notReady')}</p>
      <div className="grid gap-4 lg:grid-cols-[minmax(12rem,1fr)_2fr]">
        <SelectField
          id="guided-usecase"
          label={t('agentic.useCase')}
          value={progress.useCase ?? ''}
          disabled={save.isPending || !can('brands.manage')}
          placeholder="—"
          options={USE_CASES.map((value) => ({ value, label: t(`agentic.${value}`) }))}
          onChange={(e) => {
            if (e.target.value)
              save.mutate({ useCase: e.target.value as (typeof USE_CASES)[number] });
          }}
        />
        <ol className="grid gap-3 text-sm sm:grid-cols-2">
          <li>
            <Link
              to="/onboarding"
              search={{ step: 'brand' }}
              className="font-medium text-link underline"
            >
              {t('setup.onboarding.steps.brand.name')}
            </Link>
            <p>{state(!!brandId)}</p>
          </li>
          <li>
            <Link to="/knowledge" className="font-medium text-link underline">
              {t('agentic.knowledge')}
            </Link>
            <p>
              {state(knowledge === undefined ? undefined : knowledge > 0)}
              {knowledge !== undefined ? ` · ${knowledge}` : ''}
            </p>
          </li>
          <li>
            <Link to="/connectors" className="font-medium text-link underline">
              {t('agentic.permissions')}
            </Link>
            <p>
              {t('agentic.chatRoute')}: {state(connected)}
            </p>
          </li>
          <li>
            <Link
              to="/onboarding"
              search={{ step: 'testchat' }}
              className="font-medium text-link underline"
            >
              {t('agentic.testPublish')}
            </Link>
            <p>
              {t('agentic.publishedAgent')}: {state(published)}
            </p>
          </li>
        </ol>
      </div>
      <ActionError error={save.error} />
    </section>
  );
}
