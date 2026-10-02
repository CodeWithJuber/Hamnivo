import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { KeyRoundIcon, PlusIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog, DialogFooter } from '../../components/AppDialog';
import { CheckboxField, SelectField, TextField } from '../../components/Fields';
import { Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { api, isApiError } from '../../lib/api';
import {
  type ApiKey,
  type ApiKeyPermission,
  type CreatedApiKey,
  developerKeys,
  useApiKeyPermissions,
  useApiKeys,
} from '../../lib/developer';
import { formatDateTime, formatRelative } from '../../lib/format';
import { useBrands, useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import { SecretReveal } from './SecretReveal';

const EXPIRY_DAYS = [7, 30, 90, 180, 365] as const;
const OVERLAPS = [0, 60, 1440, 10080] as const;

const STATUS_TONE: Record<ApiKey['status'], StatusTone> = {
  active: 'success',
  rotating: 'info',
  expired: 'neutral',
  revoked: 'neutral',
};

function useKeyChange<TVars, TResult>(run: (vars: TVars, tenant: string) => Promise<TResult>) {
  return useStudioMutation(run, [developerKeys.apiKeys]);
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: CreatedApiKey) => void;
}) {
  const { t } = useTranslation();
  const options = useApiKeyPermissions();
  const brands = useBrands();
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState<ApiKeyPermission[]>([]);
  const [scope, setScope] = useState('tenant');
  const [days, setDays] = useState('30');
  const create = useKeyChange((body: object, tenant) =>
    api<CreatedApiKey>('/v1/admin/api-keys', { method: 'POST', tenant, body }),
  );
  const fields = new Map(
    isApiError(create.error) ? create.error.fields.map((f) => [f.path, f.message]) : [],
  );
  const reset = () => {
    setName('');
    setPermissions([]);
    setScope('tenant');
    setDays('30');
    create.reset();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        permissions,
        scope: scope === 'tenant' ? { type: 'tenant' } : { type: 'brand', id: scope },
        expiresInDays: Number(days),
      });
      reset();
      onOpenChange(false);
      onCreated(created);
    } catch (caught) {
      if (isCancelled(caught)) return;
    }
  };
  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title={t('developer.keys.create.title')}
      description={t('developer.keys.create.description')}
      testId="create-key-dialog"
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          id="key-name"
          label={t('developer.keys.create.name')}
          hint={t('developer.keys.create.nameHint')}
          value={name}
          maxLength={80}
          required
          error={fields.get('name')}
          onChange={(event) => setName(event.target.value)}
        />
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium text-text">
            {t('developer.keys.create.permissions')}
          </legend>
          {(options.data?.items ?? []).map((option) => (
            <CheckboxField
              key={option.permission}
              id={`key-permission-${option.permission}`}
              label={t(`developer.permissions.${option.permission}.name`)}
              hint={
                option.grantable
                  ? t(`developer.permissions.${option.permission}.hint`)
                  : t('developer.keys.create.notYours')
              }
              disabled={!option.grantable}
              checked={permissions.includes(option.permission)}
              onCheckedChange={(checked) =>
                setPermissions((current) =>
                  checked
                    ? [...current, option.permission]
                    : current.filter((p) => p !== option.permission),
                )
              }
            />
          ))}
          {fields.get('permissions') ? (
            <p className="text-sm text-danger" id="key-permissions-error">
              {fields.get('permissions')}
            </p>
          ) : null}
        </fieldset>
        <SelectField
          id="key-scope"
          label={t('developer.keys.create.scope')}
          hint={t('developer.keys.create.scopeHint')}
          value={scope}
          error={fields.get('scope') ?? fields.get('scope.id')}
          onChange={(event) => setScope(event.target.value)}
          options={[
            { value: 'tenant', label: t('developer.keys.scopeTenant') },
            ...(brands.data?.items ?? []).map((brand) => ({
              value: brand.id,
              label: t('developer.keys.scopeBrand', { brand: brand.name }),
            })),
          ]}
        />
        <SelectField
          id="key-expiry"
          label={t('developer.keys.create.expiry')}
          hint={t('developer.keys.create.expiryHint')}
          value={days}
          error={fields.get('expiresInDays')}
          onChange={(event) => setDays(event.target.value)}
          options={EXPIRY_DAYS.map((value) => ({
            value: String(value),
            label: t('developer.keys.create.days', { count: value }),
          }))}
        />
        <ActionError error={create.error && !fields.size ? create.error : null} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button
            type="submit"
            busy={create.isPending}
            disabled={name.trim() === '' || permissions.length === 0}
          >
            {t('developer.keys.create.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function RotateKeyDialog({
  apiKey,
  onClose,
  onRotated,
}: {
  apiKey: ApiKey | null;
  onClose: () => void;
  onRotated: (key: CreatedApiKey) => void;
}) {
  const { t } = useTranslation();
  const [overlap, setOverlap] = useState('60');
  const rotate = useKeyChange((vars: { id: string; overlapMinutes: number }, tenant) =>
    api<CreatedApiKey>(`/v1/admin/api-keys/${encodeURIComponent(vars.id)}/rotate`, {
      method: 'POST',
      tenant,
      body: { overlapMinutes: vars.overlapMinutes },
    }),
  );
  return (
    <ConfirmDialog
      open={apiKey !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('developer.keys.rotate.title', { name: apiKey?.name ?? '' })}
      confirmLabel={t('developer.keys.rotate.confirm')}
      testId="rotate-key-dialog"
      failureNote={t('developer.keys.rotate.unchanged')}
      onConfirm={async () => {
        if (!apiKey) return;
        const created = await rotate.mutateAsync({
          id: apiKey.id,
          overlapMinutes: Number(overlap),
        });
        onRotated(created);
      }}
    >
      <p>{t('developer.keys.rotate.description')}</p>
      <SelectField
        id="rotate-overlap"
        label={t('developer.keys.rotate.overlap')}
        value={overlap}
        onChange={(event) => setOverlap(event.target.value)}
        options={OVERLAPS.map((minutes) => ({
          value: String(minutes),
          label: t(`developer.keys.rotate.overlaps.${minutes}`),
        }))}
      />
    </ConfirmDialog>
  );
}

function KeyRow({
  apiKey,
  onRotate,
  onRevoke,
}: {
  apiKey: ApiKey;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const live = apiKey.status === 'active';
  return (
    <TableRow data-testid="api-key-row" data-key-id={apiKey.id}>
      <TableCell className="font-medium text-text">
        <bdi>{apiKey.name}</bdi>
      </TableCell>
      <TableCell>
        <bdi dir="ltr" className="font-mono text-xs">
          {apiKey.prefix}_…
        </bdi>
      </TableCell>
      <TableCell className="whitespace-normal">
        {apiKey.permissions.map((p) => t(`developer.permissions.${p}.name`)).join(', ')}
        <span className="block text-xs text-text-secondary">
          {apiKey.scope.type === 'tenant'
            ? t('developer.keys.scopeTenant')
            : t(`developer.keys.scopeType.${apiKey.scope.type}`)}
        </span>
      </TableCell>
      <TableCell>
        <StatusBadge tone={STATUS_TONE[apiKey.status]}>
          {t(`developer.keys.status.${apiKey.status}`)}
        </StatusBadge>
      </TableCell>
      <TableCell title={formatDateTime(apiKey.lastUsedAt)}>
        {apiKey.lastUsedAt ? formatRelative(apiKey.lastUsedAt) : t('developer.keys.neverUsed')}
      </TableCell>
      <TableCell>{formatDateTime(apiKey.revokedAt ?? apiKey.expiresAt)}</TableCell>
      <TableCell>
        {can('api_keys.manage') && live ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={onRotate}
              aria-label={t('developer.keys.rotate.label', { name: apiKey.name })}
            >
              {t('developer.keys.rotate.button')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={onRevoke}
              aria-label={t('developer.keys.revoke.label', { name: apiKey.name })}
            >
              {t('developer.keys.revoke.button')}
            </Button>
          </div>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/** API keys (board 19): create with explicit permissions, reveal once, rotate, revoke. */
export function ApiKeysTab() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const keys = useApiKeys();
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<CreatedApiKey | null>(null);
  const [rotating, setRotating] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const revoke = useKeyChange((id: string, tenant) =>
    api<ApiKey>(`/v1/admin/api-keys/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
      tenant,
    }),
  );
  const manage = can('api_keys.manage');
  return (
    <Section
      id="api-keys"
      title={t('developer.keys.title')}
      description={t('developer.keys.description')}
      actions={
        manage ? (
          <Button onClick={() => setCreating(true)} data-testid="create-key">
            <PlusIcon aria-hidden="true" />
            {t('developer.keys.create.open')}
          </Button>
        ) : null
      }
    >
      {!manage && can('api_keys.read') ? (
        <p className="text-sm text-text-secondary">{t('developer.keys.readOnly')}</p>
      ) : null}
      <QueryState
        query={keys}
        label={t('developer.keys.loading')}
        permitted={can('api_keys.read')}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-center">
            <KeyRoundIcon className="size-6 text-text-muted" aria-hidden="true" />
            <p className="text-sm text-text-secondary">{t('developer.keys.empty')}</p>
          </div>
        }
      >
        {(data) => (
          <div className="overflow-x-auto">
            <Table data-testid="api-keys">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('developer.keys.columns.name')}</TableHead>
                  <TableHead>{t('developer.keys.columns.key')}</TableHead>
                  <TableHead>{t('developer.keys.columns.access')}</TableHead>
                  <TableHead>{t('developer.keys.columns.status')}</TableHead>
                  <TableHead>{t('developer.keys.columns.lastUsed')}</TableHead>
                  <TableHead>{t('developer.keys.columns.expires')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('developer.keys.columns.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((apiKey) => (
                  <KeyRow
                    key={apiKey.id}
                    apiKey={apiKey}
                    onRotate={() => setRotating(apiKey)}
                    onRevoke={() => setRevoking(apiKey)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryState>
      <CreateKeyDialog open={creating} onOpenChange={setCreating} onCreated={setRevealed} />
      <RotateKeyDialog
        apiKey={rotating}
        onClose={() => setRotating(null)}
        onRotated={(created) => {
          setRotating(null);
          setRevealed(created);
        }}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t('developer.keys.revoke.title', { name: revoking?.name ?? '' })}
        confirmLabel={t('developer.keys.revoke.confirm')}
        variant="destructive"
        testId="revoke-key-dialog"
        onConfirm={async () => {
          if (!revoking) return;
          await revoke.mutateAsync(revoking.id);
          announce(t('developer.keys.revoke.done', { name: revoking.name }));
        }}
      >
        <p>{t('developer.keys.revoke.description')}</p>
      </ConfirmDialog>
      <SecretReveal
        secret={revealed?.secret ?? null}
        title={t('developer.keys.reveal.title')}
        label={t('developer.keys.reveal.label', { name: revealed?.name ?? '' })}
        onDone={() => setRevealed(null)}
        testId="key-reveal"
      />
    </Section>
  );
}
