import { useTranslation } from 'react-i18next';
import { Section } from '../../components/PageHeader';
import { QueryState } from '../../components/States';
import { formatDate, formatNumber } from '../../lib/format';
import { useStudioQuery } from '../../lib/queries';
import { useTenant } from '../../lib/tenant';

interface AiUsage {
  period: { key: string; start: string; end: string };
  managed: { settledTokens: number; reservedTokens: number; creditsMilli: number };
  byok: { tokens: number };
}
export function AiUsageCard() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const query = useStudioQuery<AiUsage>(['ai-usage'], '/v1/admin/ai/usage', {
    enabled: can('billing.read'),
  });
  if (!can('billing.read')) return null;
  return (
    <Section id="ai-usage" title={t('agentic.aiUsage')}>
      <QueryState query={query} label={t('app.loading')}>
        {(data) => (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary">
              {formatDate(data.period.start)} – {formatDate(data.period.end)}
            </p>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(
                [
                  ['managedTokens', data.managed.settledTokens],
                  ['reservedTokens', data.managed.reservedTokens],
                  ['managedCredits', data.managed.creditsMilli / 1000],
                  ['byokTokens', data.byok.tokens],
                ] as const
              ).map(([key, value]) => (
                <div key={key} className="rounded-lg border border-border p-3">
                  <dt className="text-sm text-text-secondary">{t(`agentic.${key}`)}</dt>
                  <dd className="mt-1 text-xl font-semibold">{formatNumber(value)}</dd>
                </div>
              ))}
            </dl>
            <p className="text-sm text-text-secondary">{t('agentic.creditNote')}</p>
          </div>
        )}
      </QueryState>
    </Section>
  );
}
