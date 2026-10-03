import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { TextField } from '../../components/Fields';
import { ActionError } from '../../components/States';
import { isApiError } from '../../lib/api';
import { isCancelled } from '../../lib/reauth';
import { type ModelProbeResult, useReplaceKey } from '../../lib/setup';
import type { ModelConnection } from '../../lib/types';
import { TestOutcome } from './ProbeResult';
import { useConnectionTest } from './use-connection-test';

const MIN_KEY = 8;

function ReplaceKeyBody({
  connection,
  onClose,
  onResult,
}: {
  connection: ModelConnection;
  onClose: () => void;
  onResult?: ((result: ModelProbeResult) => void) | undefined;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const replace = useReplaceKey();
  const test = useConnectionTest();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [attempted, setAttempted] = useState(false);
  const [replaced, setReplaced] = useState<ModelConnection | null>(null);
  const report = useRef(onResult);
  report.current = onResult;
  const found = test.result;
  useEffect(() => {
    if (found) report.current?.(found);
  }, [found]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (apiKey.trim().length < MIN_KEY) {
      setError(t('models.errors.apiKey'));
      return;
    }
    setError(undefined);
    try {
      const updated = await replace.mutateAsync({
        connectionId: connection.id,
        apiKey: apiKey.trim(),
      });
      // The key leaves the page as soon as it is stored.
      setApiKey('');
      setReplaced(updated);
      announce(t('setup.models.replace.replaced', { label: connection.label }));
      void test.run(connection.id, connection.allowedModels[0]);
    } catch (caught) {
      if (isApiError(caught, 'VALIDATION_FAILED')) {
        const field = caught.fields.find((f) => f.path === 'apiKey');
        if (field) setError(field.message);
      }
    }
  };

  const summary = attempted && error ? [{ fieldId: 'rk-apiKey', message: error }] : [];

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={submit}
      noValidate
      autoComplete="off"
      data-testid="replace-key-form"
    >
      <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
      {replaced ? (
        <div className="flex flex-col gap-3" data-testid="replace-key-done">
          <p role="status" className="text-sm text-text">
            {t('setup.models.replace.done', { hint: replaced.keyHint })}
          </p>
          <TestOutcome
            pending={test.pending}
            result={test.result}
            error={test.error}
            modelId={connection.allowedModels[0]}
          />
        </div>
      ) : (
        <TextField
          id="rk-apiKey"
          label={t('setup.models.replace.newKey')}
          hint={t('setup.models.replace.newKeyHint', { hint: connection.keyHint })}
          value={apiKey}
          type="password"
          dir="ltr"
          autoComplete="new-password"
          spellCheck={false}
          data-1p-ignore
          onChange={(event) => setApiKey(event.target.value)}
          error={error}
        />
      )}
      <ActionError error={isCancelled(replace.error) ? null : replace.error} />
      {isCancelled(replace.error) ? (
        <p role="status" className="text-sm text-text-secondary">
          {t('app.cancelled')}
        </p>
      ) : null}
      <DialogFooter>
        {replaced ? (
          <Button type="button" onClick={onClose}>
            {t('app.close')}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={replace.isPending}
            >
              {t('app.cancel')}
            </Button>
            <Button type="submit" busy={replace.isPending}>
              {t('setup.models.replace.submit')}
            </Button>
          </>
        )}
      </DialogFooter>
    </form>
  );
}

/**
 * Puts a new key in an existing connection. The agents that use it carry on with the new key; the
 * old one is revoked. The new key is tested straight away so the owner knows it works.
 */
export function ReplaceKeyDialog({
  connection,
  onOpenChange,
  onResult,
}: {
  connection: ModelConnection | null;
  onOpenChange: (open: boolean) => void;
  /** Called with what the test of the new key found. */
  onResult?: ((result: ModelProbeResult) => void) | undefined;
}) {
  const { t } = useTranslation();
  return (
    <AppDialog
      open={connection !== null}
      onOpenChange={onOpenChange}
      title={t('setup.models.replace.title', { label: connection?.label ?? '' })}
      description={t('setup.models.replace.description')}
      testId="replace-key-dialog"
    >
      {connection ? (
        <ReplaceKeyBody
          key={connection.id}
          connection={connection}
          onClose={() => onOpenChange(false)}
          onResult={onResult}
        />
      ) : null}
    </AppDialog>
  );
}
