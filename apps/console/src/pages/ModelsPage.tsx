import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { CircleCheckIcon, KeyRoundIcon, PlusIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog, DialogFooter } from '../components/AppDialog';
import { SelectField, TextareaField, TextField } from '../components/Fields';
import { PageHeader } from '../components/PageHeader';
import { ActionError, QueryState } from '../components/States';
import { PROVIDERS } from '../lib/agent-form';
import { api, isApiError, newIdempotencyKey } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { keys, useModelConnections, useStudioMutation } from '../lib/queries';
import { isCancelled } from '../lib/reauth';
import { useTenant } from '../lib/tenant';
import type { CreateModelConnectionRequest, ModelConnection } from '../lib/types';

type Provider = CreateModelConnectionRequest['provider'];
const HTTP_URL = /^https?:\/\/\S+$/;

/** The key's last characters, the only part ever shown again. */
function KeyEnding({ hint }: { hint: string }) {
  return (
    <bdi dir="ltr" className="font-mono">
      ••••{hint}
    </bdi>
  );
}

function AddConnectionDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (connection: ModelConnection) => void;
}) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<Provider>('openai');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (!open) return;
    setProvider('openai');
    setLabel('');
    setBaseUrl('');
    setApiKey('');
    setModels('');
    setErrors({});
    setAttempted(false);
    setCancelled(false);
    setIdempotencyKey(newIdempotencyKey());
  }, [open]);

  const add = useStudioMutation(
    (body: CreateModelConnectionRequest, tenant) =>
      api<ModelConnection>('/v1/admin/model-connections', {
        method: 'POST',
        body,
        tenant,
        idempotencyKey,
      }),
    [keys.modelConnections],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    setCancelled(false);
    const next: Record<string, string> = {};
    if (!label.trim()) next.label = t('models.errors.label');
    if (baseUrl.trim() && !HTTP_URL.test(baseUrl.trim())) next.baseUrl = t('models.errors.baseUrl');
    if (provider === 'openai-compatible' && !baseUrl.trim()) {
      next.baseUrl = t('models.errors.baseUrlRequired');
    }
    if (apiKey.trim().length < 8) next.apiKey = t('models.errors.apiKey');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const allowedModels = models
      .split(/[\n,]/)
      .map((m) => m.trim())
      .filter(Boolean);
    try {
      const connection = await add.mutateAsync({
        provider,
        label: label.trim(),
        apiKey: apiKey.trim(),
        allowedModels,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      // The key leaves the page as soon as it is stored.
      setApiKey('');
      onAdded(connection);
      onOpenChange(false);
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
    ? Object.entries(errors).map(([field, message]) => ({ fieldId: `mcn-${field}`, message }))
    : [];

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!add.isPending) onOpenChange(next);
      }}
      title={t('models.addTitle')}
      description={t('models.description')}
      testId="add-connection-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate autoComplete="off">
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        <SelectField
          id="mcn-provider"
          label={t('models.provider')}
          value={provider}
          onChange={(event) => setProvider(event.target.value as Provider)}
          options={PROVIDERS.filter((p): p is Provider => p !== 'mock').map((p) => ({
            value: p,
            label: t(`editor.providers.${p}`),
          }))}
        />
        <TextField
          id="mcn-label"
          label={t('models.label')}
          hint={t('models.labelHint')}
          value={label}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
          error={errors.label}
        />
        <TextField
          id="mcn-baseUrl"
          label={t('models.baseUrl')}
          hint={t('models.baseUrlHint')}
          labelNote={provider === 'openai-compatible' ? undefined : t('app.optional')}
          value={baseUrl}
          type="url"
          dir="ltr"
          spellCheck={false}
          onChange={(event) => setBaseUrl(event.target.value)}
          error={errors.baseUrl}
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
        {cancelled ? (
          <p role="status" className="text-sm text-text-secondary">
            {t('app.cancelled')}
          </p>
        ) : null}
        <ActionError error={isCancelled(add.error) ? null : add.error} />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={add.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={add.isPending}>
            {t('models.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

/** Model provider credentials (the key is write-only; only its ending is shown). */
export function ModelsPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const connections = useModelConnections();
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<ModelConnection | null>(null);
  const [disabling, setDisabling] = useState<ModelConnection | null>(null);
  const disable = useStudioMutation(
    (id: string, tenant) =>
      api<ModelConnection>(`/v1/admin/model-connections/${id}/disable`, {
        method: 'POST',
        tenant,
      }),
    [keys.modelConnections],
  );

  const addButton = (
    <Button onClick={() => setAdding(true)}>
      <PlusIcon aria-hidden="true" />
      {t('models.add')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('models.title')}
        description={t('models.description')}
        actions={can('integrations.manage') ? addButton : null}
      />
      {added ? (
        <div
          role="status"
          data-testid="connection-added"
          className="flex items-start gap-3 rounded-lg border border-success/40 bg-success-subtle p-4 text-sm"
        >
          <CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
          <p className="text-text">{t('models.added', { hint: added.keyHint })}</p>
        </div>
      ) : null}
      <QueryState
        query={connections}
        label={t('models.loading')}
        permitted={can('integrations.manage')}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('models.empty.title')}
            description={t('models.empty.description')}
            icon={<KeyRoundIcon className="size-6 text-text-muted" aria-hidden="true" />}
            action={addButton}
          />
        }
      >
        {(data) => (
          <div className="rounded-xl border border-border bg-surface shadow-sm">
            <Table data-testid="connections-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-start">{t('models.columns.label')}</TableHead>
                  <TableHead className="text-start">{t('models.columns.provider')}</TableHead>
                  <TableHead className="text-start">{t('models.columns.key')}</TableHead>
                  <TableHead className="text-start">{t('models.columns.models')}</TableHead>
                  <TableHead className="text-start">{t('models.columns.status')}</TableHead>
                  <TableHead className="text-start">{t('models.columns.created')}</TableHead>
                  <TableHead className="text-start">{t('models.columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((connection) => (
                  <TableRow key={connection.id} data-connection={connection.label}>
                    <TableCell className="font-medium">
                      <bdi>{connection.label}</bdi>
                      {connection.baseUrl ? (
                        <bdi dir="ltr" className="block font-mono text-xs text-text-secondary">
                          {connection.baseUrl}
                        </bdi>
                      ) : null}
                    </TableCell>
                    <TableCell>{t(`editor.providers.${connection.provider}`)}</TableCell>
                    <TableCell data-testid="key-ending">
                      <span className="sr-only">
                        {t('models.keyEnding', { hint: connection.keyHint })}
                      </span>
                      <span aria-hidden="true">
                        <KeyEnding hint={connection.keyHint} />
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {connection.allowedModels.length === 0 ? (
                        <span className="text-text-secondary">{t('models.anyModel')}</span>
                      ) : (
                        <bdi dir="ltr" className="font-mono text-xs">
                          {connection.allowedModels.join(', ')}
                        </bdi>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={connection.status === 'active' ? 'success' : 'neutral'}>
                        {t(`models.status.${connection.status}`)}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>{formatDateTime(connection.createdAt)}</TableCell>
                    <TableCell>
                      {connection.status === 'active' ? (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setDisabling(connection)}
                          aria-label={t('models.disableLabel', { label: connection.label })}
                        >
                          {t('models.disable')}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryState>
      <AddConnectionDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={(connection) => {
          setAdded(connection);
          announce(t('models.added', { hint: connection.keyHint }));
        }}
      />
      {disabling ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDisabling(null);
          }}
          title={t('models.disableTitle', { label: disabling.label })}
          confirmLabel={t('models.disableSubmit')}
          variant="destructive-solid"
          onConfirm={async () => {
            await disable.mutateAsync(disabling.id);
            announce(t('models.disabled', { label: disabling.label }));
          }}
        >
          <p>{t('models.disableBody')}</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
