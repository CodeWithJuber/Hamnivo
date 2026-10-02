import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { Label } from '@hamnivo/ui/components/label';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import { Switch } from '@hamnivo/ui/components/switch';
import { CircleCheckIcon, GlobeIcon, KeyRoundIcon, PlusIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog, DialogFooter } from '../../components/AppDialog';
import { CopyButton } from '../../components/CopyButton';
import { SelectField, TextField } from '../../components/Fields';
import { Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { accessKeys, usePermissionCatalog, useRoles, useSsoSettings } from '../../lib/access';
import { api, isApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import type { PermissionInfo, Role, SsoConnection, SsoDomain } from '../../lib/types';

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const ISSUER = /^https?:\/\/\S+$/;

const STATUS_TONE: Record<SsoConnection['status'], StatusTone> = {
  draft: 'neutral',
  active: 'success',
  disabled: 'warning',
};

function Copyable({ id, value, label }: { id: string; value: string; label: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code
          id={id}
          dir="ltr"
          className="min-w-0 flex-1 break-all rounded-md border border-border bg-surface-muted px-2 py-1 text-xs"
        >
          {value}
        </code>
        <CopyButton
          text={value}
          label={t('access.copyValue', { label })}
          copiedLabel={t('app.copied')}
          failedLabel={t('access.copyFailed')}
          selectTarget={() => document.getElementById(id)}
        />
      </div>
    </div>
  );
}

function DomainCard({
  domain,
  onChanged,
}: {
  domain: SsoDomain;
  onChanged: (text: string) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [removing, setRemoving] = useState(false);
  const verify = useStudioMutation(
    (id: string, tenant) =>
      api<SsoDomain>(`/v1/admin/sso/domains/${id}/verify`, { method: 'POST', tenant }),
    [accessKeys.sso, accessKeys.audit],
  );
  const remove = useStudioMutation(
    (id: string, tenant) => api<void>(`/v1/admin/sso/domains/${id}`, { method: 'DELETE', tenant }),
    [accessKeys.sso, accessKeys.audit],
  );
  const verified = domain.status === 'verified';
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
      data-domain={domain.domain}
      data-status={domain.status}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium text-text">
          <GlobeIcon className="size-4 text-text-muted" aria-hidden="true" />
          <bdi dir="ltr">{domain.domain}</bdi>
        </span>
        <StatusBadge tone={verified ? 'success' : 'warning'}>
          {verified ? t('access.security.sso.verified') : t('access.security.sso.pending')}
        </StatusBadge>
      </div>
      {verified ? null : (
        <>
          <p className="text-sm text-text-secondary">{t('access.security.sso.publish')}</p>
          <div className="grid gap-3">
            <Copyable
              id={`record-name-${domain.id}`}
              value={domain.verification.name}
              label={t('access.security.sso.recordName')}
            />
            <Copyable
              id={`record-value-${domain.id}`}
              value={domain.verification.value}
              label={t('access.security.sso.recordValue')}
            />
          </div>
        </>
      )}
      {domain.lastCheckResult ? (
        <p
          role="status"
          className="text-sm text-text"
          data-testid="domain-check"
          data-result={domain.lastCheckResult}
        >
          {t(`access.security.sso.results.${domain.lastCheckResult}`)}{' '}
          {domain.lastCheckedAt ? (
            <span className="text-text-secondary">
              {t('access.security.sso.checked', { time: formatDateTime(domain.lastCheckedAt) })}
            </span>
          ) : null}
        </p>
      ) : null}
      <ActionError error={isCancelled(verify.error) ? null : verify.error} />
      <div className="flex flex-wrap gap-2">
        {verified ? null : (
          <Button
            size="sm"
            busy={verify.isPending}
            onClick={async () => {
              try {
                const checked = await verify.mutateAsync(domain.id);
                if (checked.lastCheckResult) {
                  announce(t(`access.security.sso.results.${checked.lastCheckResult}`));
                }
              } catch {
                // Shown above.
              }
            }}
            data-testid="verify-domain"
          >
            {t('access.security.sso.check')}
          </Button>
        )}
        <Button
          size="sm"
          variant="destructive"
          aria-label={t('access.security.sso.removeDomainLabel', { domain: domain.domain })}
          onClick={() => setRemoving(true)}
        >
          {t('access.security.sso.removeDomain')}
        </Button>
      </div>
      {removing ? (
        <ConfirmDialog
          open
          onOpenChange={setRemoving}
          title={t('access.security.sso.removeDomainTitle', { domain: domain.domain })}
          confirmLabel={t('access.security.sso.removeDomain')}
          variant="destructive-solid"
          onConfirm={async () => {
            await remove.mutateAsync(domain.id);
            onChanged(t('access.security.sso.removeDomainLabel', { domain: domain.domain }));
          }}
        >
          <p>{t('access.security.sso.removeDomainBody')}</p>
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

function AddDomainForm() {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const add = useStudioMutation(
    (domain: string, tenant) =>
      api<SsoDomain>('/v1/admin/sso/domains', { method: 'POST', body: { domain }, tenant }),
    [accessKeys.sso, accessKeys.audit],
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const domain = value.trim().toLowerCase();
    if (!DOMAIN.test(domain)) {
      setError(t('access.security.sso.domainInvalid'));
      return;
    }
    setError(undefined);
    try {
      await add.mutateAsync(domain);
      setValue('');
    } catch (caught) {
      if (isApiError(caught, 'VALIDATION_FAILED') && caught.fields[0]) {
        setError(caught.fields[0].message);
      }
    }
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex-1">
        <TextField
          id="sso-domain"
          label={t('access.security.sso.domain')}
          hint={t('access.security.sso.domainHint')}
          value={value}
          dir="ltr"
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
          error={error}
        />
      </div>
      <Button type="submit" busy={add.isPending} className="sm:mt-7" data-testid="add-domain">
        <PlusIcon aria-hidden="true" />
        {t('access.security.sso.addDomain')}
      </Button>
      <ActionError error={isCancelled(add.error) || error ? null : add.error} />
    </form>
  );
}

function ConnectForm({ domain }: { domain: SsoDomain }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useStudioMutation(
    (body: Record<string, string>, tenant) =>
      api<SsoConnection>('/v1/admin/sso/connections', { method: 'POST', body, tenant }),
    [accessKeys.sso, accessKeys.audit],
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!ISSUER.test(issuer.trim())) next.issuer = t('access.security.sso.issuerInvalid');
    if (!clientId.trim()) next.clientId = t('access.security.sso.required');
    if (!clientSecret) next.clientSecret = t('access.security.sso.required');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      await create.mutateAsync({
        domainId: domain.id,
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        clientSecret,
      });
      setClientSecret('');
      announce(t('access.security.sso.created'));
    } catch (caught) {
      if (isApiError(caught, 'VALIDATION_FAILED')) {
        const fields: Record<string, string> = {};
        for (const field of caught.fields) fields[field.path] = field.message;
        if (Object.keys(fields).length > 0) setErrors(fields);
      }
    }
  };
  const prefix = `sso-${domain.id}`;
  return (
    <form
      onSubmit={submit}
      noValidate
      autoComplete="off"
      className="flex flex-col gap-4 rounded-lg border border-border p-4"
      data-testid="connect-form"
    >
      <div className="flex flex-col gap-1">
        <h3 className="font-semibold text-text">
          {t('access.security.sso.connection', { domain: domain.domain })}
        </h3>
        <p className="text-sm text-text-secondary">{t('access.security.sso.connectHint')}</p>
      </div>
      <FormErrorSummary
        title={t('auth.errorSummary')}
        errors={Object.entries(errors).map(([field, message]) => ({
          fieldId: `${prefix}-${field}`,
          message,
        }))}
      />
      <TextField
        id={`${prefix}-issuer`}
        type="url"
        label={t('access.security.sso.issuer')}
        hint={t('access.security.sso.issuerHint')}
        value={issuer}
        dir="ltr"
        spellCheck={false}
        onChange={(event) => setIssuer(event.target.value)}
        error={errors.issuer}
      />
      <TextField
        id={`${prefix}-clientId`}
        label={t('access.security.sso.clientId')}
        value={clientId}
        dir="ltr"
        spellCheck={false}
        onChange={(event) => setClientId(event.target.value)}
        error={errors.clientId}
      />
      <TextField
        id={`${prefix}-clientSecret`}
        type="password"
        label={t('access.security.sso.clientSecret')}
        hint={t('access.security.sso.clientSecretHint')}
        value={clientSecret}
        dir="ltr"
        autoComplete="new-password"
        data-1p-ignore
        onChange={(event) => setClientSecret(event.target.value)}
        error={errors.clientSecret}
      />
      <ActionError error={isCancelled(create.error) ? null : create.error} />
      <Button
        type="submit"
        busy={create.isPending}
        className="self-start"
        data-testid="save-connection"
      >
        {t('access.security.sso.save')}
      </Button>
    </form>
  );
}

function jitRoleOptions(roles: Role[], catalog: PermissionInfo[]) {
  const guarded = new Set(catalog.filter((p) => p.mfa).map((p) => p.key));
  const grantable = new Set(catalog.filter((p) => p.grantable).map((p) => p.key));
  const keys = catalog.map((p) => p.key);
  return roles.map((role) => {
    const held = keys.filter((key) =>
      role.permissions.some(
        (pattern) =>
          pattern === '*' ||
          pattern === key ||
          (pattern.endsWith('.*') && key.startsWith(pattern.slice(0, -1))),
      ),
    );
    return {
      value: role.id,
      label: role.name,
      disabled: held.some((key) => guarded.has(key) || !grantable.has(key)),
    };
  });
}

function ConnectionCard({ connection }: { connection: SsoConnection }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const roles = useRoles();
  const catalog = usePermissionCatalog();
  const [jitRole, setJitRole] = useState(connection.jitRole?.id ?? '');
  const [notice, setNotice] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [secret, setSecret] = useState('');
  const [removing, setRemoving] = useState(false);
  const update = useStudioMutation(
    (body: Record<string, unknown>, tenant) =>
      api<SsoConnection>(`/v1/admin/sso/connections/${connection.id}`, {
        method: 'PATCH',
        body: { ...body, version: connection.version },
        tenant,
      }),
    [accessKeys.sso, accessKeys.audit],
  );
  const remove = useStudioMutation(
    (id: string, tenant) =>
      api<void>(`/v1/admin/sso/connections/${id}`, { method: 'DELETE', tenant }),
    [accessKeys.sso, accessKeys.audit],
  );
  const change = async (body: Record<string, unknown>, message: string) => {
    setNotice(null);
    try {
      await update.mutateAsync(body);
      setNotice(message);
      announce(message);
      return true;
    } catch {
      return false;
    }
  };
  const on = connection.status === 'active';
  const prefix = `sso-connection-${connection.id}`;
  return (
    <div
      className="flex flex-col gap-4 rounded-lg border border-border p-4"
      data-testid="sso-connection"
      data-status={connection.status}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-text">
          {t('access.security.sso.connection', { domain: connection.domain })}
        </h3>
        <StatusBadge tone={STATUS_TONE[connection.status]} data-testid="connection-status">
          {t(`access.security.sso.status.${connection.status}`)}
        </StatusBadge>
      </div>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-text-secondary">{t('access.security.sso.issuer')}</dt>
        <dd>
          <bdi dir="ltr" className="break-all">
            {connection.issuer}
          </bdi>
        </dd>
        <dt className="text-text-secondary">{t('access.security.sso.clientId')}</dt>
        <dd>
          <bdi dir="ltr" className="break-all">
            {connection.clientId}
          </bdi>
        </dd>
        <dt className="text-text-secondary">{t('access.security.sso.clientSecret')}</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <KeyRoundIcon className="size-4 text-text-muted" aria-hidden="true" />
          <span className="sr-only">
            {t('access.security.sso.secretMasked', { masked: connection.clientSecret.masked })}
          </span>
          <bdi dir="ltr" aria-hidden="true" className="font-mono" data-testid="secret-masked">
            {connection.clientSecret.masked}
          </bdi>
          {connection.clientSecret.rotatedAt ? (
            <span className="text-text-secondary">
              {t('access.security.sso.rotated', {
                time: formatDateTime(connection.clientSecret.rotatedAt),
              })}
            </span>
          ) : null}
        </dd>
      </dl>
      <Copyable
        id={`${prefix}-callback`}
        value={connection.callbackUrl}
        label={t('access.security.sso.redirectUri')}
      />
      <p className="text-xs text-text-secondary">{t('access.security.sso.redirectUriHint')}</p>
      <details className="text-sm">
        <summary className="cursor-pointer text-link">{t('access.security.sso.endpoints')}</summary>
        <ul dir="ltr" className="mt-2 flex flex-col gap-1 break-all text-xs text-text-secondary">
          <li>{connection.endpoints.authorization}</li>
          <li>{connection.endpoints.token}</li>
          <li>{connection.endpoints.jwks}</li>
          {connection.endpoints.userInfo ? <li>{connection.endpoints.userInfo}</li> : null}
        </ul>
      </details>
      <div className="flex flex-wrap gap-2">
        {on ? (
          <Button
            variant="secondary"
            busy={update.isPending}
            onClick={() =>
              void change(
                { status: 'disabled' },
                t('access.security.sso.turnedOff', { domain: connection.domain }),
              )
            }
            data-testid="turn-off-sso"
          >
            {t('access.security.sso.turnOff')}
          </Button>
        ) : (
          <Button
            busy={update.isPending}
            onClick={() =>
              void change(
                { status: 'active' },
                t('access.security.sso.turnedOn', { domain: connection.domain }),
              )
            }
            data-testid="turn-on-sso"
          >
            {t('access.security.sso.turnOn')}
          </Button>
        )}
        <Button variant="secondary" onClick={() => setReplacing(true)}>
          {t('access.security.sso.replaceSecret')}
        </Button>
        <Button variant="destructive" onClick={() => setRemoving(true)}>
          {t('access.security.sso.removeConnection')}
        </Button>
      </div>
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${prefix}-sso-only`}>{t('access.security.sso.ssoOnly')}</Label>
          <p id={`${prefix}-sso-only-hint`} className="text-sm text-text-secondary">
            {on
              ? t('access.security.sso.ssoOnlyHint', { domain: connection.domain })
              : t('access.security.sso.ssoOnlyNeedsOn')}
          </p>
        </div>
        <Switch
          id={`${prefix}-sso-only`}
          checked={connection.ssoOnly}
          disabled={!on || update.isPending}
          aria-describedby={`${prefix}-sso-only-hint`}
          data-testid="sso-only"
          onCheckedChange={(checked) =>
            void change(
              { ssoOnly: checked },
              checked
                ? t('access.security.sso.ssoOnlySaved', { domain: connection.domain })
                : t('access.security.sso.ssoOnlyOff', { domain: connection.domain }),
            )
          }
        />
      </div>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          const role = roles.data?.items.find((r) => r.id === jitRole);
          void change(
            { jitRoleId: jitRole || null },
            role
              ? t('access.security.sso.jitSaved', { role: role.name })
              : t('access.security.sso.jitCleared'),
          );
        }}
      >
        <div className="flex-1">
          <SelectField
            id={`${prefix}-jit`}
            label={t('access.security.sso.jit')}
            hint={t('access.security.sso.jitHint')}
            value={jitRole}
            onChange={(event) => setJitRole(event.target.value)}
            placeholder={t('access.security.sso.jitOff')}
            options={jitRoleOptions(roles.data?.items ?? [], catalog.data?.items ?? [])}
          />
        </div>
        <Button type="submit" variant="secondary" busy={update.isPending} data-testid="save-jit">
          {t('access.security.sso.jitSave')}
        </Button>
      </form>
      {notice ? (
        <p
          role="status"
          className="flex items-start gap-2 text-sm text-text"
          data-testid="sso-notice"
        >
          <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          {notice}
        </p>
      ) : null}
      <ActionError error={isCancelled(update.error) || replacing ? null : update.error} />
      <AppDialog
        open={replacing}
        onOpenChange={(open) => {
          if (!update.isPending) setReplacing(open);
          if (!open) setSecret('');
        }}
        title={t('access.security.sso.replaceTitle')}
      >
        <form
          className="flex flex-col gap-4"
          autoComplete="off"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!secret) return;
            if (await change({ clientSecret: secret }, t('access.security.sso.replaced'))) {
              setSecret('');
              setReplacing(false);
            }
          }}
        >
          <TextField
            id={`${prefix}-new-secret`}
            type="password"
            label={t('access.security.sso.clientSecret')}
            hint={t('access.security.sso.clientSecretHint')}
            value={secret}
            dir="ltr"
            autoComplete="new-password"
            data-1p-ignore
            onChange={(event) => setSecret(event.target.value)}
          />
          <ActionError error={isCancelled(update.error) ? null : update.error} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setReplacing(false)}>
              {t('app.cancel')}
            </Button>
            <Button type="submit" busy={update.isPending} disabled={!secret}>
              {t('access.security.sso.replaceSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </AppDialog>
      {removing ? (
        <ConfirmDialog
          open
          onOpenChange={setRemoving}
          title={t('access.security.sso.removeConnectionTitle', { domain: connection.domain })}
          confirmLabel={t('access.security.sso.removeConnection')}
          variant="destructive-solid"
          onConfirm={async () => {
            await remove.mutateAsync(connection.id);
            announce(t('access.security.sso.removed', { domain: connection.domain }));
          }}
        >
          <p>{t('access.security.sso.removeConnectionBody', { domain: connection.domain })}</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** Single sign-on (A13): domain proof by DNS, the OpenID Connect connection and its rules. */
export function SsoSection() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const settings = useSsoSettings();
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <Section
      id="sso"
      title={t('access.security.sso.title')}
      description={t('access.security.sso.description')}
    >
      <QueryState
        query={settings}
        label={t('access.security.sso.loading')}
        permitted={can('security.manage')}
        forbidden={
          <p className="text-sm text-text-secondary">{t('access.security.sso.forbidden')}</p>
        }
      >
        {(data) => (
          <div className="flex flex-col gap-6">
            <p className="text-sm text-text">{t('access.security.sso.steps')}</p>
            {notice ? (
              <p role="status" className="text-sm text-text">
                {notice}
              </p>
            ) : null}
            <div className="flex flex-col gap-3">
              <h3 className="font-semibold text-text">{t('access.security.sso.domains')}</h3>
              {data.domains.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('access.security.sso.noDomains')}</p>
              ) : (
                <ul className="flex flex-col gap-3" data-testid="sso-domains">
                  {data.domains.map((domain) => (
                    <DomainCard key={domain.id} domain={domain} onChanged={setNotice} />
                  ))}
                </ul>
              )}
              <AddDomainForm />
            </div>
            {data.domains
              .filter((domain) => domain.status === 'verified')
              .map((domain) => {
                const connection = data.connections.find((c) => c.domainId === domain.id);
                return connection ? (
                  <ConnectionCard key={connection.id} connection={connection} />
                ) : (
                  <ConnectForm key={domain.id} domain={domain} />
                );
              })}
          </div>
        )}
      </QueryState>
    </Section>
  );
}
