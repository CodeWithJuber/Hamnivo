import { Button } from '@hamnivo/ui/components/button';
import { CircleCheckIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelProbeResult } from '../../lib/setup';
import type { ModelConnection } from '../../lib/types';
import { TestOutcome } from './ProbeResult';
import { useConnectionTest } from './use-connection-test';

/**
 * What the owner sees right after saving a key: it was stored, and it is being tested with one
 * tiny message. If the test fails, the fix (a different key) is one button away.
 */
export function AddedBanner({
  connection,
  modelId,
  onReplace,
  onResult,
}: {
  connection: ModelConnection;
  /** The model chosen to test with; left out, the server picks the provider's recommended one. */
  modelId: string | undefined;
  onReplace: (connection: ModelConnection) => void;
  /** Called with what the test found, each time a test ends. */
  onResult?: ((result: ModelProbeResult) => void) | undefined;
}) {
  const { t } = useTranslation();
  const { run, result, error, pending } = useConnectionTest();
  const started = useRef(false);
  const report = useRef(onResult);
  report.current = onResult;
  useEffect(() => {
    if (result) report.current?.(result);
  }, [result]);

  // The test is part of saving: it starts once, as the banner appears.
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once for this connection
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run(connection.id, modelId);
  }, []);

  const failed = result !== null && !result.ok;
  return (
    <div
      data-testid="connection-added"
      className="flex flex-col gap-3 rounded-lg border border-success/40 bg-success-subtle p-4 text-sm"
    >
      <div className="flex items-start gap-3">
        <CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
        <p className="text-text">{t('models.added', { hint: connection.keyHint })}</p>
      </div>
      <div className="ps-8">
        <TestOutcome pending={pending} result={result} error={error} modelId={modelId} />
      </div>
      {result || error ? (
        <div className="flex flex-wrap gap-2 ps-8">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            busy={pending}
            onClick={() => void run(connection.id, modelId)}
          >
            {t('setup.models.testAgain')}
          </Button>
          {failed ? (
            <Button type="button" size="sm" onClick={() => onReplace(connection)}>
              {t('setup.models.replace.action')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
