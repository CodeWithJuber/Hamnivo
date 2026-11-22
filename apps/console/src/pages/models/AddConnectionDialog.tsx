import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { SelectField, TextareaField, TextField } from '../../components/Fields';
import { ActionError } from '../../components/States';
import { PROVIDERS } from '../../lib/agent-form';
import { api, isApiError, newIdempotencyKey } from '../../lib/api';
import { type ListModelsRequest, useSettled } from '../../lib/provider-models';
import { keys, useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { setupKeys } from '../../lib/setup';
import { recommendedModel } from '../../lib/setup-data';
import type { CreateModelConnectionRequest, ModelConnection } from '../../lib/types';
import { ModelField } from './ModelPicker';

type Provider = CreateModelConnectionRequest['provider'];
type KeyedProvider = Exclude<Provider, 'mock'>;
const HTTP_URL = /^https?:\/\/\S+$/;

/**
 * The fields for adding an AI key. Once the key is pasted, the provider's own list of the models it
 * can use fills the model field (the recommended one starts chosen, and any name can be typed), and
 * the key is tested with one tiny message as soon as it is saved:
 * the caller shows what came back. Used in a dialog on the page and inline in the setup guide;
 * the form starts empty every time it appears.
 */
export function AddConnectionForm({
  onAdded,
  onCancel,
  submitLabel,
}: {
  /** Called once the key is stored, with the model chosen to test it with. */
  onAdded: (connection: ModelConnection, modelId: string | undefined) => void;
  onCancel?: (() => void) | undefined;
  submitLabel?: string | undefined;
}) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<KeyedProvider>('openai');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(() => recommendedModel('openai') ?? '');
  const [models, setModels] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);

  const add = useStudioMutation(
    (body: CreateModelConnectionRequest, tenant) =>
      api<ModelConnection>('/v1/admin/model-connections', {
        method: 'POST',
        body,
        tenant,
        idempotencyKey,
      }),
    [keys.modelConnections, setupKeys.modelStatus],
  );

  const compatible = provider === 'openai-compatible';
  const chosen = model.trim();

  // The pasted key reads the provider's model list once it looks whole and has stopped changing.
  // It is sent for that one request and kept by nobody until the form is saved.
  const typedKey = apiKey.trim();
  const typedUrl = baseUrl.trim();
  const urlOk = typedUrl ? HTTP_URL.test(typedUrl) : !compatible;
  const keyOk = compatible || typedKey.length >= 8;
  const listWith = useSettled<ListModelsRequest | null>(
    urlOk && keyOk
      ? {
          source: 'key',
          provider,
          ...(typedKey ? { apiKey: typedKey } : {}),
          ...(typedUrl ? { baseUrl: typedUrl } : {}),
        }
      : null,
    700,
  );

  const choose = (next: KeyedProvider) => {
    setProvider(next);
    setModel(recommendedModel(next) ?? '');
    setErrors({});
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    setCancelled(false);
    const next: Record<string, string> = {};
    if (baseUrl.trim() && !HTTP_URL.test(baseUrl.trim())) next.baseUrl = t('models.errors.baseUrl');
    if (compatible && !baseUrl.trim()) next.baseUrl = t('models.errors.baseUrlRequired');
    if (apiKey.trim().length < 8) next.apiKey = t('models.errors.apiKey');
    // The test needs a model. A server of your own names its own models, so there is no list to
    // start from and the name is typed.
    if (!chosen) next.model = t('setup.models.errors.model');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const allowedModels = models
      .split(/[\n,]/)
      .map((m) => m.trim())
      .filter(Boolean);
    try {
      const connection = await add.mutateAsync({
        provider,
        label: label.trim() || t(`editor.providers.${provider}`),
        apiKey: apiKey.trim(),
        allowedModels,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      // The key leaves the page as soon as it is stored.
      setApiKey('');
      onAdded(connection, chosen || undefined);
    } catch (error) {
      if (isCancelled(error)) setCancelled(true);
      if (isApiError(error, 'VALIDATION_FAILED')) {
        const fields: Record<string, string> = {};
        for (const field of error.fields) {
          if (field.path === 'baseUrl') fields.baseUrl = field.message;
          if (field.path === 'apiKey') fields.apiKey = field.message;
          if (field.path === 'label') fields.label = field.message;
        }
        if (Object.keys(fields).length > 0) setErrors(fields);
      }
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({
        fieldId: `mcn-${field}`,
        message,
      }))
    : [];

  const baseUrlField = (
    <TextField
      id="mcn-baseUrl"
      label={t(compatible ? 'setup.models.serverAddress' : 'models.baseUrl')}
      hint={t(compatible ? 'setup.models.serverAddressHint' : 'models.baseUrlHint')}
      labelNote={compatible ? undefined : t('app.optional')}
      value={baseUrl}
      type="url"
      dir="ltr"
      spellCheck={false}
      onChange={(event) => setBaseUrl(event.target.value)}
      error={errors.baseUrl}
    />
  );

  return (
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate autoComplete="off">
      <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
      <SelectField
        id="mcn-provider"
        label={t('models.provider')}
        value={provider}
        onChange={(event) => choose(event.target.value as KeyedProvider)}
        options={PROVIDERS.filter((p): p is KeyedProvider => p !== 'mock').map((p) => ({
          value: p,
          label: t(`editor.providers.${p}`),
        }))}
      />
      <TextField
        id="mcn-apiKey"
        label={t('models.apiKey')}
        hint={t('models.apiKeyHint')}
        value={apiKey}
        type="password"
        dir="ltr"
        autoComplete="new-password"
        spellCheck={false}
        data-1p-ignore
        onChange={(event) => setApiKey(event.target.value)}
        error={errors.apiKey}
      />
      {compatible ? baseUrlField : null}
      <ModelField
        id="mcn-model"
        label={t('setup.models.model')}
        hint={t('setup.models.modelHint')}
        provider={provider}
        value={model}
        onChange={setModel}
        // The settled request lags the form; a list for the provider just left is not shown.
        source={listWith?.source === 'key' && listWith.provider === provider ? listWith : null}
        waitingFor={compatible ? 'address' : 'key'}
        error={errors.model}
      />
      <TextField
        id="mcn-label"
        label={t('models.label')}
        hint={t('setup.models.labelHint')}
        labelNote={t('app.optional')}
        value={label}
        maxLength={80}
        onChange={(event) => setLabel(event.target.value)}
        error={errors.label}
      />
      <details className="group rounded-lg border border-border p-3" data-testid="more-options">
        <summary className="cursor-pointer text-sm font-medium text-text">
          {t('setup.models.moreOptions')}
        </summary>
        <div className="mt-4 flex flex-col gap-5">
          {compatible ? null : baseUrlField}
          <TextareaField
            id="mcn-models"
            label={t('models.allowedModels')}
            hint={t('models.allowedModelsHint')}
            labelNote={t('app.optional')}
            value={models}
            rows={3}
            dir="ltr"
            spellCheck={false}
            onChange={(event) => setModels(event.target.value)}
          />
        </div>
      </details>
      <p className="text-sm text-text-secondary">{t('setup.models.testNote')}</p>
      {cancelled ? (
        <p role="status" className="text-sm text-text-secondary">
          {t('app.cancelled')}
        </p>
      ) : null}
      <ActionError error={isCancelled(add.error) ? null : add.error} />
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={add.isPending}>
          {t('app.cancel')}
        </Button>
        <Button type="submit" busy={add.isPending}>
          {submitLabel ?? t('setup.models.saveAndTest')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The same form in a dialog, from the "Add connection" button. */
export function AddConnectionDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the key is stored, with the model chosen to test it with. */
  onAdded: (connection: ModelConnection, modelId: string | undefined) => void;
}) {
  const { t } = useTranslation();
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('models.addTitle')}
      description={t('setup.models.addDescription')}
      testId="add-connection-dialog"
    >
      <AddConnectionForm
        onAdded={(connection, modelId) => {
          onAdded(connection, modelId);
          onOpenChange(false);
        }}
        onCancel={() => onOpenChange(false)}
      />
    </AppDialog>
  );
}
