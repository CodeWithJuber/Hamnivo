import { Button } from '@hamnivo/ui/components/button';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { recommendedModel } from '../../lib/setup-data';
import type { ModelConnection } from '../../lib/types';
import { ModelField } from './ModelPicker';
import { TestOutcome } from './ProbeResult';
import { useConnectionTest } from './use-connection-test';

function TestKeyBody({
  connection,
  onClose,
}: {
  connection: ModelConnection;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const provider = connection.provider;
  const [typed, setTyped] = useState(
    () => connection.allowedModels[0] ?? recommendedModel(provider) ?? '',
  );
  const { run, result, error, pending } = useConnectionTest();
  const model = typed.trim();
  const started = useRef(false);

  // One test starts as soon as the dialog opens: asking to test a key is the whole request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once, with the first model
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // A server of your own names its own models: with none to start from, wait for one to be typed.
    if (provider === 'openai-compatible' && !model) return;
    void run(connection.id, model || undefined);
  }, []);

  return (
    <div className="flex flex-col gap-5" data-testid="test-key-dialog-body">
      <TestOutcome pending={pending} result={result} error={error} modelId={model || undefined} />
      <ModelField
        id="tk-model"
        label={t('setup.models.model')}
        hint={t('setup.models.modelHint')}
        provider={provider}
        value={typed}
        onChange={setTyped}
        source={{ source: 'connection', connectionId: connection.id }}
      />
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('app.close')}
        </Button>
        <Button
          type="button"
          busy={pending}
          disabled={provider === 'openai-compatible' && !model}
          onClick={() => void run(connection.id, model || undefined)}
        >
          {t('setup.models.testAgain')}
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * Tests a connection's key: one real message of a few words to the provider, and what came back
 * in plain words. The model can be changed and the test repeated.
 */
export function TestKeyDialog({
  connection,
  onOpenChange,
}: {
  connection: ModelConnection | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <AppDialog
      open={connection !== null}
      onOpenChange={onOpenChange}
      title={t('setup.models.testTitle', { label: connection?.label ?? '' })}
      description={t('setup.models.testDescription')}
      testId="test-key-dialog"
    >
      {connection ? (
        <TestKeyBody
          key={connection.id}
          connection={connection}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </AppDialog>
  );
}
