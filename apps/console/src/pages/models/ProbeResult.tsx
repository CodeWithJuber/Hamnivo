import { Spinner } from '@hamnivo/ui/components/spinner';
import { CircleCheckIcon, CircleXIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ActionError } from '../../components/States';
import { isCancelled } from '../../lib/reauth';
import type { ModelProbeKind, ModelProbeResult } from '../../lib/setup';

/** What a test found out, in plain words: a mark, a title and what to do about it. */
export function ProbeResult({
  result,
  testId = 'probe-result',
}: {
  result: Pick<ModelProbeResult, 'ok' | 'kind' | 'modelId'>;
  testId?: string;
}) {
  const { t } = useTranslation();
  const Icon = result.ok ? CircleCheckIcon : CircleXIcon;
  return (
    <div
      role="status"
      data-testid={testId}
      data-kind={result.kind}
      className={`flex items-start gap-3 rounded-lg border p-4 text-sm ${
        result.ok ? 'border-success/40 bg-success-subtle' : 'border-danger/30 bg-danger-subtle'
      }`}
    >
      <Icon
        className={`mt-0.5 size-5 shrink-0 ${result.ok ? 'text-success' : 'text-danger'}`}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <p className={`font-semibold ${result.ok ? 'text-success' : 'text-danger'}`}>
          {t(`setup.models.probe.${result.kind}.title`)}
        </p>
        <p className="text-text">{t(`setup.models.probe.${result.kind}.body`)}</p>
        <p className="text-text-secondary">
          {t('setup.models.testedWith')} <bdi dir="ltr">{result.modelId}</bdi>
        </p>
      </div>
    </div>
  );
}

/**
 * A test as it goes: a line saying it is running, then what it found out, or why it could not be
 * run at all (a request for a fresh sign-in that was dismissed, a missing permission).
 */
export function TestOutcome({
  pending,
  result,
  error,
  modelId,
}: {
  pending: boolean;
  result: ModelProbeResult | null;
  error: unknown;
  /** The model the running test uses, named while it runs. */
  modelId?: string | undefined;
}) {
  const { t } = useTranslation();
  if (pending) {
    return (
      <p
        role="status"
        data-testid="probe-running"
        className="flex items-center gap-2 text-sm text-text-secondary"
      >
        <Spinner aria-hidden="true" role="presentation" />
        {modelId ? t('setup.models.testingWith', { model: modelId }) : t('setup.models.testing')}
      </p>
    );
  }
  if (error) {
    return isCancelled(error) ? (
      <p role="status" className="text-sm text-text-secondary">
        {t('app.cancelled')}
      </p>
    ) : (
      <ActionError error={error} />
    );
  }
  return result ? <ProbeResult result={result} /> : null;
}

/** The kinds, in the order the test can end. */
export const PROBE_KINDS: readonly ModelProbeKind[] = [
  'ok',
  'wrong_key',
  'no_credit',
  'model_not_found',
  'network',
  'blocked',
  'rate_limited',
  'unavailable',
  'unknown',
];
