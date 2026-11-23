import { Button } from '@hamnivo/ui/components/button';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandPicker, useChosenBrand } from '../components/BrandPicker';
import { CheckboxField, SelectField, TextField } from '../components/Fields';
import { PageHeader } from '../components/PageHeader';
import { ActionError, QueryState } from '../components/States';
import { permissionOf, useMcpServers, useTools } from '../lib/actions';
import { api, newIdempotencyKey } from '../lib/api';
import { DOCS } from '../lib/docs';
import { useIdentityKeys } from '../lib/identity';
import { useStudioMutation, useStudioQuery } from '../lib/queries';
import { useTenant } from '../lib/tenant';
import { SecretReveal } from './developer/SecretReveal';
import { CreateKeyDialog } from './settings/IdentityPage';

type Kind = 'whmcs' | 'shopify' | 'woocommerce';
const KINDS: readonly Kind[] = ['whmcs', 'shopify', 'woocommerce'];
const PRODUCT: Record<Kind, string> = {
  whmcs: 'WHMCS',
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
};
interface Capability {
  /** Left out by older gateways, which only offered WHMCS. */
  kind?: Kind;
  key: string;
  title: string;
  description: string;
  risk: 'read' | 'write' | 'money' | 'irreversible';
  approver: 'customer' | 'staff';
}
interface Connection {
  id: string;
  brandId: string;
  kind: Kind;
  label: string;
  baseUrl: string;
  status: 'active' | 'disabled';
  capabilities: string[];
  grantVersion: number;
  lastTestedAt: string | null;
  lastError: string | null;
  identityKeyId: string | null;
}
interface A2A {
  id: string;
  name: string;
  endpoint: string;
  enabled: boolean;
  hasCredential: boolean;
  protocolVersion: '1.0';
}
/** What each kind of connection calls its address and its keys. */
function useFieldLabels(kind: Kind) {
  const { t } = useTranslation();
  switch (kind) {
    case 'shopify':
      return {
        baseUrl: t('agentic.shopifyShop'),
        identifier: null,
        secret: t('agentic.shopifyToken'),
        hint: t('agentic.shopifyHint'),
      };
    case 'woocommerce':
      return {
        baseUrl: t('agentic.wooSite'),
        identifier: t('agentic.wooKey'),
        secret: t('agentic.wooSecret'),
        hint: t('agentic.wooHint'),
      };
    default:
      return {
        baseUrl: t('agentic.baseUrl'),
        identifier: t('agentic.identifier'),
        secret: t('agentic.secret'),
        hint: null,
      };
  }
}
/** A details box whose content is only drawn while it is open. */
function Disclosure(props: { summary: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={props.className} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">{props.summary}</summary>
      {open ? props.children : null}
    </details>
  );
}
function CapabilityChoices({
  items,
  value,
  onChange,
  idPrefix = 'capability',
}: {
  items: Capability[];
  value: string[];
  onChange: (value: string[]) => void;
  idPrefix?: string;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-3 font-medium">{t('agentic.capabilities')}</legend>
      {items.map((c) => (
        <CheckboxField
          key={c.key}
          id={`${idPrefix}-${c.key}`}
          label={c.title}
          hint={`${c.description} · ${t(`agentic.risks.${c.risk}`)} · ${t(`agentic.approvers.${c.approver}`)}`}
          checked={value.includes(c.key)}
          onCheckedChange={(checked) =>
            onChange(checked ? [...value, c.key] : value.filter((k) => k !== c.key))
          }
        />
      ))}
    </fieldset>
  );
}
interface PermissionTestResult {
  ok: boolean;
  checkedAt: string;
  userId: number;
  clientId: number;
  items: {
    capability: string;
    configured: boolean;
    requiredPermission: string;
    allowed: boolean;
    reason:
      | 'allowed'
      | 'grant_disabled'
      | 'connection_disabled'
      | 'permission_denied'
      | 'permission_unverified';
  }[];
}
function PermissionTest({
  connectionId,
  catalog,
}: {
  connectionId: string;
  catalog: Capability[];
}) {
  const { t } = useTranslation();
  const [userId, setUserId] = useState('');
  const [clientId, setClientId] = useState('');
  const test = useStudioMutation((_: undefined, tenant) =>
    api<PermissionTestResult>(`/v1/admin/connectors/${connectionId}/permissions/test`, {
      tenant,
      method: 'POST',
      body: { userId: Number(userId), clientId: Number(clientId) },
    }),
  );
  return (
    <details>
      <summary className="cursor-pointer text-sm text-link">
        {t('agentic.permissionPreview')}
      </summary>
      <form
        className="my-3 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          test.mutate(undefined);
        }}
      >
        <p className="text-sm text-text-secondary">{t('agentic.permissionPreviewHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            id={`${connectionId}-user`}
            label={t('agentic.whmcsUser')}
            type="number"
            min={1}
            step={1}
            required
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          />
          <TextField
            id={`${connectionId}-client`}
            label={t('agentic.whmcsClient')}
            type="number"
            min={1}
            step={1}
            required
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" busy={test.isPending}>
          {t('agentic.checkPermissions')}
        </Button>
        <ActionError error={test.error} />
        {test.data ? (
          <section aria-live="polite" className="flex flex-col gap-2 text-sm">
            <p className="font-medium">
              {t('agentic.whmcsUser')}: {test.data.userId} · {t('agentic.whmcsClient')}:{' '}
              {test.data.clientId}
            </p>
            <p>
              {t(test.data.ok ? 'agentic.permissionsVerified' : 'agentic.permissionsUnverified')} ·{' '}
              {new Date(test.data.checkedAt).toLocaleString()}
            </p>
            <ul className="flex flex-col gap-2">
              {test.data.items.map((item) => (
                <li key={item.capability} className="rounded-md border border-border p-2">
                  <p>
                    <bdi>
                      {catalog.find((capability) => capability.key === item.capability)?.title ??
                        item.capability}
                    </bdi>{' '}
                    · <strong>{t(`agentic.permissionReasons.${item.reason}`)}</strong>
                  </p>
                  <p className="text-text-secondary">
                    <bdi>{item.requiredPermission}</bdi>
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </form>
    </details>
  );
}
function ConnectorCard({
  row,
  catalog,
  onChange,
}: {
  row: Connection;
  catalog: Capability[];
  onChange: (path: string, body?: unknown, method?: 'POST' | 'PUT') => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const labels = useFieldLabels(row.kind);
  const [identifier, setIdentifier] = useState('');
  const [secret, setSecret] = useState('');
  const [capabilities, setCapabilities] = useState(row.capabilities);
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4">
      <h3 className="font-semibold">
        <bdi>{row.label}</bdi>
      </h3>
      <p className="break-all text-sm">
        <bdi dir="ltr">{row.baseUrl}</bdi>
      </p>
      <p className="text-sm">
        {t(`agentic.connectionStates.${row.status}`)}
        {row.lastTestedAt ? ` · ${new Date(row.lastTestedAt).toLocaleString()}` : ''}
      </p>
      {row.lastError ? <p className="text-sm text-danger">{row.lastError}</p> : null}
      <div className="flex flex-wrap gap-2">
        {can('tools.manage') ? (
          <Button variant="secondary" onClick={() => onChange(`/${row.id}/test`)}>
            {t('agentic.test')}
          </Button>
        ) : null}
        {can('tools.manage') && row.status === 'active' ? (
          <Button variant="ghost" onClick={() => onChange(`/${row.id}/disable`)}>
            {t('agentic.disable')}
          </Button>
        ) : null}
      </div>
      {can('tools.manage') ? (
        <>
          {row.kind === 'whmcs' ? <PermissionTest connectionId={row.id} catalog={catalog} /> : null}
          <details>
            <summary className="cursor-pointer text-sm text-link">
              {t('agentic.capabilities')}
            </summary>
            <div className="flex flex-col gap-3 py-3">
              <CapabilityChoices
                items={catalog}
                value={capabilities}
                onChange={setCapabilities}
                idPrefix={`${row.id}-capability`}
              />
              <Button
                variant="secondary"
                onClick={() =>
                  onChange(
                    `/${row.id}/grants`,
                    { capabilities, expectedVersion: row.grantVersion },
                    'PUT',
                  )
                }
              >
                {t('agentic.save')}
              </Button>
            </div>
          </details>
          <details>
            <summary className="cursor-pointer text-sm text-link">{t('agentic.reconnect')}</summary>
            <form
              className="flex flex-col gap-3 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                onChange(
                  `/${row.id}/reconnect`,
                  labels.identifier ? { identifier, secret } : { secret },
                );
                setIdentifier('');
                setSecret('');
              }}
            >
              {labels.identifier ? (
                <TextField
                  id={`${row.id}-identifier`}
                  label={labels.identifier}
                  required
                  value={identifier}
                  autoComplete="off"
                  onChange={(e) => setIdentifier(e.target.value)}
                />
              ) : null}
              <TextField
                id={`${row.id}-secret`}
                label={labels.secret}
                type="password"
                required
                value={secret}
                autoComplete="new-password"
                onChange={(e) => setSecret(e.target.value)}
              />
              <Button>{t('agentic.reconnect')}</Button>
            </form>
          </details>
        </>
      ) : null}
    </li>
  );
}
/** The three things to do for WHMCS, in order, each with where to do it. */
function WhmcsSteps() {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby="whmcs-steps-title"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm"
      data-testid="whmcs-steps"
    >
      <h4 id="whmcs-steps-title" className="font-medium text-text">
        {t('setup.whmcsForm.stepsTitle')}
      </h4>
      <ol className="flex list-decimal flex-col gap-1.5 ps-5 text-text-secondary">
        <li>{t('setup.whmcsForm.step1')}</li>
        <li>
          {t('setup.whmcsForm.step2')}{' '}
          <a
            href={`${DOCS.integration('whmcs')}#signed-in-clients-optional`}
            target="_blank"
            rel="noreferrer"
            className="text-link underline"
          >
            {t('setup.whmcsForm.guide')}
          </a>
        </li>
        <li>{t('setup.whmcsForm.step3')}</li>
      </ol>
    </section>
  );
}

/**
 * The customer sign-in key a WHMCS connection trusts: picked from the brand's active keys (the
 * only one is picked for you), or made here, with its secret shown once. Someone who cannot read
 * the keys types the key name instead.
 */
function IdentityKeyField({
  id,
  brandId,
  value,
  onChange,
}: {
  id: string;
  brandId: string;
  value: string;
  onChange: (kid: string) => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const keys = useIdentityKeys(brandId);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ value: string; kid: string } | null>(null);
  const usable = (keys.data?.items ?? []).filter((key) => key.status === 'active');
  const only = usable.length === 1 ? usable[0]?.kid : undefined;
  useEffect(() => {
    if (!value && only) onChange(only);
  }, [value, only, onChange]);
  const mayCreate = can('widget.identity_keys');

  const dialogs = (
    <>
      <CreateKeyDialog
        brandId={brandId}
        open={creating}
        replacing={null}
        onOpenChange={setCreating}
        onCreated={({ key }) => {
          onChange(key.kid);
          if (key.secret) setSecret({ value: key.secret, kid: key.kid });
        }}
      />
      <SecretReveal
        secret={secret?.value ?? null}
        title={t('setup.identity.reveal.title')}
        label={t('setup.identity.reveal.label', { kid: secret?.kid ?? '' })}
        onDone={() => setSecret(null)}
        testId="whmcs-identity-secret"
      />
    </>
  );

  if (!keys.data) {
    return (
      <TextField
        id={id}
        label={t('agentic.identityKeyId')}
        hint={t('setup.whmcsForm.keyTyped')}
        required
        dir="ltr"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {usable.length > 0 ? (
        <SelectField
          id={id}
          label={t('setup.whmcsForm.keyLabel')}
          hint={t('setup.whmcsForm.keyHint')}
          required
          value={value}
          placeholder="—"
          options={usable.map((key) => ({
            value: key.kid,
            label: `${key.kid} (${t(`setup.identity.algs.${key.alg}`)})`,
          }))}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <p className="text-sm text-text" role="status" data-testid="whmcs-no-key">
          {t('setup.whmcsForm.noKey')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {mayCreate ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => setCreating(true)}>
            {usable.length > 0 ? t('setup.whmcsForm.createAnother') : t('setup.whmcsForm.create')}
          </Button>
        ) : (
          <span className="text-sm text-text-secondary">{t('setup.identity.noPermission')}</span>
        )}
        <Link
          to="/customer-identity"
          search={{ brand: brandId }}
          className="text-sm text-link underline"
        >
          {t('setup.whmcsForm.manage')}
        </Link>
      </div>
      {dialogs}
    </div>
  );
}

/** The form that connects one more WHMCS, Shopify or WooCommerce of the brand. */
function CreateConnection({
  kind,
  brandId,
  catalog,
  busy,
  onCreate,
}: {
  kind: Kind;
  brandId: string;
  catalog: Capability[];
  busy: boolean;
  onCreate: (body: Record<string, unknown>, done: () => void) => void;
}) {
  const { t } = useTranslation();
  const labels = useFieldLabels(kind);
  const [label, setLabel] = useState('');
  const [baseUrl, setUrl] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [secret, setSecret] = useState('');
  const [identityKeyId, setIdentity] = useState('');
  // Store connections only read: both reads are offered ticked; WHMCS actions are chosen one by one.
  const [capabilities, setCapabilities] = useState<string[]>(
    kind === 'whmcs' ? [] : catalog.map((c) => c.key),
  );
  const id = (field: string) => (kind === 'whmcs' ? `connector-${field}` : `${kind}-${field}`);
  return (
    <form
      className="mt-4 grid gap-4 lg:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate(
          {
            brandId,
            kind,
            label,
            baseUrl,
            ...(labels.identifier ? { identifier } : {}),
            secret,
            ...(kind === 'whmcs' ? { identityKeyId } : {}),
            capabilities,
          },
          () => {
            setLabel('');
            setUrl('');
            setIdentifier('');
            setSecret('');
            setIdentity('');
            setCapabilities(kind === 'whmcs' ? [] : catalog.map((c) => c.key));
          },
        );
      }}
    >
      <div className="flex flex-col gap-3">
        {kind === 'whmcs' ? <WhmcsSteps /> : null}
        {labels.hint ? <p className="text-sm text-text-secondary">{labels.hint}</p> : null}
        <TextField
          id={id('label')}
          label={t('agentic.name')}
          required
          maxLength={120}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <TextField
          id={id('url')}
          label={labels.baseUrl}
          type="url"
          pattern={
            kind === 'shopify' ? 'https://[a-z0-9][a-z0-9\\-]*\\.myshopify\\.com/?' : 'https://.*'
          }
          placeholder={kind === 'shopify' ? 'https://your-shop.myshopify.com' : undefined}
          dir="ltr"
          required
          value={baseUrl}
          onChange={(e) => setUrl(e.target.value)}
        />
        {labels.identifier ? (
          <TextField
            id={id('identifier')}
            label={labels.identifier}
            required
            autoComplete="off"
            dir="ltr"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
        ) : null}
        <TextField
          id={id('secret')}
          label={labels.secret}
          required
          type="password"
          autoComplete="new-password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        {kind === 'whmcs' ? (
          <IdentityKeyField
            id={id('identity')}
            brandId={brandId}
            value={identityKeyId}
            onChange={setIdentity}
          />
        ) : null}
        <p className="text-sm text-text-secondary">{t('agentic.credentials')}</p>
      </div>
      <CapabilityChoices
        items={catalog}
        value={capabilities}
        onChange={setCapabilities}
        idPrefix={`${kind}-new`}
      />
      <Button busy={busy} disabled={capabilities.length === 0}>
        {kind === 'whmcs'
          ? t('agentic.create')
          : t('agentic.connectStore', { name: PRODUCT[kind] })}
      </Button>
    </form>
  );
}
function NativeConnectors({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const catalog = useStudioQuery<{ items: Capability[] }>(
    ['connectors', 'catalog'],
    '/v1/admin/connectors/catalog',
    { enabled: can('tools.read') },
  );
  const list = useStudioQuery<{ items: Connection[] }>(
    ['connectors', brandId],
    `/v1/admin/connectors?brandId=${encodeURIComponent(brandId)}`,
    { enabled: can('tools.read') && !!brandId },
  );
  const [attempt, setAttempt] = useState(newIdempotencyKey);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const change = useStudioMutation(
    (v: { path: string; body?: unknown; method?: 'POST' | 'PUT' }, tenant) =>
      api<unknown>(`/v1/admin/connectors${v.path}`, {
        tenant,
        method: v.method ?? 'POST',
        body: v.body,
        ...(v.path === '' ? { idempotencyKey: attempt } : {}),
      }),
    [['connectors'], ['tools']],
  );
  const action = (path: string, body?: unknown, method?: 'POST' | 'PUT') => {
    setResult(null);
    change.mutate(
      { path, body, ...(method ? { method } : {}) },
      {
        onSuccess: (data) => {
          if (data && typeof data === 'object' && 'ok' in data && 'message' in data)
            setResult(data as { ok: boolean; message: string });
        },
      },
    );
  };
  return (
    <section className="flex flex-col gap-6">
      <ActionError error={change.error} />
      {result ? (
        <p role="status" className={result.ok ? 'text-success' : 'text-danger'}>
          {result.message}
        </p>
      ) : null}
      <QueryState query={catalog} label={t('app.loading')} permitted={can('tools.read')}>
        {(data) => (
          <QueryState query={list} label={t('app.loading')}>
            {(rows) => (
              <>
                {KINDS.map((kind) => {
                  const offered = data.items.filter((c) => (c.kind ?? 'whmcs') === kind);
                  const mine = rows.items.filter((row) => row.kind === kind);
                  if (offered.length === 0) return null;
                  return (
                    <section
                      key={kind}
                      className="flex flex-col gap-4"
                      aria-labelledby={`${kind}-title`}
                    >
                      <h2 id={`${kind}-title`} className="text-lg font-semibold">
                        {PRODUCT[kind]}
                      </h2>
                      {kind !== 'whmcs' ? (
                        <p className="text-sm text-text-secondary">{t('agentic.storeHint')}</p>
                      ) : null}
                      <ul className="grid gap-4 md:grid-cols-2">
                        {mine.map((row) => (
                          <ConnectorCard
                            key={`${row.id}-${row.grantVersion}-${row.status}`}
                            row={row}
                            catalog={offered}
                            onChange={action}
                          />
                        ))}
                        {mine.length === 0 ? <li>{t('agentic.empty')}</li> : null}
                      </ul>
                      {can('tools.manage') && brandId ? (
                        <Disclosure
                          className="rounded-xl border border-border bg-surface p-4"
                          summary={
                            kind === 'whmcs'
                              ? `${t('agentic.create')} WHMCS`
                              : t('agentic.connectStore', { name: PRODUCT[kind] })
                          }
                        >
                          <CreateConnection
                            kind={kind}
                            brandId={brandId}
                            catalog={offered}
                            busy={change.isPending}
                            onCreate={(body, done) =>
                              change.mutate(
                                { path: '', body },
                                {
                                  onSuccess: () => {
                                    done();
                                    setAttempt(newIdempotencyKey());
                                  },
                                },
                              )
                            }
                          />
                        </Disclosure>
                      ) : null}
                    </section>
                  );
                })}
              </>
            )}
          </QueryState>
        )}
      </QueryState>
    </section>
  );
}
function AgentConnections({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const list = useStudioQuery<{ items: A2A[] }>(
    ['a2a', brandId],
    `/v1/admin/brands/${brandId}/a2a-connections`,
    { enabled: !!brandId && can('automations.read') },
  );
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [credentialSecretId, setCredential] = useState('');
  const change = useStudioMutation(
    (v: { id?: string; enabled?: boolean }, tenant) =>
      api(
        v.id
          ? `/v1/admin/a2a-connections/${v.id}/enabled`
          : `/v1/admin/brands/${brandId}/a2a-connections`,
        {
          tenant,
          method: v.id ? 'PUT' : 'POST',
          body: v.id
            ? { enabled: v.enabled }
            : { name, endpoint, credentialSecretId: credentialSecretId || null },
        },
      ),
    [['a2a']],
  );
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{t('agentic.agents')}</h2>
      <ActionError error={change.error} />
      <QueryState query={list} label={t('app.loading')} permitted={can('automations.read')}>
        {(data) => (
          <ul className="flex flex-col gap-3">
            {data.items.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4"
              >
                <bdi className="font-medium">{row.name}</bdi>
                <bdi className="min-w-0 break-all text-sm">{row.endpoint}</bdi>
                <span className="text-sm">
                  A2A {row.protocolVersion} ·{' '}
                  {t(
                    row.enabled
                      ? 'agentic.connectionStates.active'
                      : 'agentic.connectionStates.disabled',
                  )}
                </span>
                {can('automations.manage') ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    busy={change.isPending}
                    onClick={() => change.mutate({ id: row.id, enabled: !row.enabled })}
                  >
                    {t(row.enabled ? 'agentic.disable' : 'agentic.resume')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {can('automations.manage') && brandId ? (
        <details className="rounded-xl border border-border p-4">
          <summary className="cursor-pointer">{t('agentic.create')}</summary>
          <form
            className="mt-4 flex max-w-xl flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              change.mutate(
                {},
                {
                  onSuccess: () => {
                    setName('');
                    setEndpoint('');
                    setCredential('');
                  },
                },
              );
            }}
          >
            <TextField
              id="a2a-name"
              label={t('agentic.name')}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <TextField
              id="a2a-endpoint"
              label={t('agentic.endpoint')}
              required
              type="url"
              pattern="https://.*"
              dir="ltr"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
            <TextField
              id="a2a-credential"
              label={t('agentic.credentialSecretId')}
              disabled={!can('secrets.manage')}
              value={credentialSecretId}
              onChange={(e) => setCredential(e.target.value)}
            />
            <Button busy={change.isPending}>{t('agentic.create')}</Button>
          </form>
        </details>
      ) : null}
    </section>
  );
}
function ToolConnections({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const servers = useMcpServers(brandId);
  const tools = useTools(brandId);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{t('agentic.tools')}</h2>
      <QueryState query={servers} label={t('app.loading')} permitted={can('tools.read')}>
        {(data) => (
          <ul className="grid gap-3 md:grid-cols-2">
            {data.items.map((server) => (
              <li
                key={server.id}
                className="flex flex-col gap-2 rounded-xl border border-border p-4"
              >
                <h3 className="font-medium">
                  <bdi>{server.label}</bdi> · MCP
                </h3>
                <p className="break-all text-sm text-text-secondary">
                  <bdi>{server.url}</bdi>
                </p>
                <p className="text-sm">
                  {t(`agentic.connectionStates.${server.status}`)} ·{' '}
                  {t('tools.servers.toolCount', { total: server.toolCount })}
                </p>
                {server.auth.status === 'needs_reconnect' ? (
                  <p className="text-sm text-warning">{t('aiPower.mcp.auth.needsReconnect')}</p>
                ) : null}
                {server.lastError ? (
                  <p className="text-sm text-danger">{server.lastError}</p>
                ) : null}
                <Link to="/tools" search={{ brand: brandId }} className="text-link underline">
                  {t('agentic.capabilities')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <QueryState query={tools} label={t('app.loading')} permitted={can('tools.read')}>
        {(data) => (
          <ul className="grid gap-3 md:grid-cols-2">
            {data.items
              .filter((tool) => tool.source === 'http')
              .map((tool) => (
                <li
                  key={tool.id}
                  className="flex flex-col gap-2 rounded-xl border border-border p-4"
                >
                  <h3 className="font-medium">
                    <bdi>{tool.title}</bdi> · HTTP
                  </h3>
                  <p className="text-sm">{t(`tools.permission.${permissionOf(tool)}`)}</p>
                  <p className="text-sm text-text-secondary">
                    <bdi>{tool.description}</bdi>
                  </p>
                  <Link
                    to="/tools"
                    search={{ brand: brandId, tool: tool.id }}
                    className="text-link underline"
                  >
                    {t('agentic.capabilities')}
                  </Link>
                </li>
              ))}
          </ul>
        )}
      </QueryState>
    </section>
  );
}
export function ConnectorsPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const { brands, active, chosen } = useChosenBrand(undefined);
  const [selected, setSelected] = useState<string>();
  const brandId = selected ?? chosen?.id ?? '';
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('agentic.connectors')}
        description={t('agentic.connectionsDescription')}
      />
      <QueryState
        query={{
          data: brands.items,
          error: brands.error,
          isPending: brands.pending,
          isRefetching: brands.isRefetching,
          refetch: brands.refetch,
        }}
        label={t('app.loading')}
        permitted={can('tools.read') || can('integrations.manage') || can('automations.read')}
        isEmpty={() => !brandId}
        empty={<p>{t('tools.noBrands')}</p>}
      >
        {() => (
          <>
            <BrandPicker
              id="connector-brand"
              label={t('nav.brands')}
              brands={active}
              value={brandId}
              onChange={setSelected}
            />
            <p className="text-sm text-text-secondary">{t('agentic.permissionTest')}</p>
            <div className="flex flex-wrap gap-3">
              {can('tools.read') ? (
                <Button asChild variant="secondary">
                  <Link to="/tools">{t('agentic.tools')}</Link>
                </Button>
              ) : null}
              {can('integrations.manage') ? (
                <Button asChild variant="secondary">
                  <Link to="/channels">{t('channels.nav')}</Link>
                </Button>
              ) : null}
            </div>
            <NativeConnectors key={brandId} brandId={brandId} />
            <ToolConnections key={`tools-${brandId}`} brandId={brandId} />
            <AgentConnections key={`a2a-${brandId}`} brandId={brandId} />
          </>
        )}
      </QueryState>
    </div>
  );
}
