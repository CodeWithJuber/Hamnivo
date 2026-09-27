import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { Skeleton } from '@hamnivo/ui/components/skeleton';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { useRouterState } from '@tanstack/react-router';
import { GlobeIcon, PlugZapIcon, PlusIcon } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog, DialogFooter } from '../components/AppDialog';
import { ConnectionBadge } from '../components/Badges';
import { CopyButton } from '../components/CopyButton';
import { SelectField, TextareaField, TextField } from '../components/Fields';
import { PageHeader } from '../components/PageHeader';
import { ActionError, QueryState } from '../components/States';
import { api, newIdempotencyKey } from '../lib/api';
import { GATEWAY_ORIGIN, WIDGET_ORIGIN } from '../lib/config';
import {
  keys,
  useAuthorityConnections,
  useBrands,
  useStudioMutation,
  useWorkspaces,
} from '../lib/queries';
import { useTenant } from '../lib/tenant';
import type { AuthorityConnection, Brand } from '../lib/types';
import { connectionFor } from './OverviewPage';

const ORIGIN = /^https?:\/\/[^/?#\s]+$/;

/** Reads one website per line; a trailing slash is forgiven, a path is not. */
export function parseWebsites(value: string): { origins: string[]; invalid: string[] } {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const line of value.split(/[\n,]/)) {
    const entry = line.trim().replace(/\/$/, '');
    if (!entry) continue;
    if (ORIGIN.test(entry)) {
      try {
        origins.push(new URL(entry).origin);
        continue;
      } catch {
        // falls through to invalid
      }
    }
    invalid.push(line.trim());
  }
  return { origins: [...new Set(origins)], invalid };
}

/** The loader tag for a brand (packages/widget-loader); the widget ID is not a secret. */
export function installSnippet(widgetId: string): string {
  return `<script src="${WIDGET_ORIGIN}/loader.js" data-widget-id="${widgetId}" data-api="${GATEWAY_ORIGIN}" async></script>`;
}

function CreateBrandDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const workspaces = useWorkspaces();
  const [name, setName] = useState('');
  const [websites, setWebsites] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (!open) return;
    setName('');
    setWebsites('');
    setErrors({});
    setAttempted(false);
    setIdempotencyKey(newIdempotencyKey());
  }, [open]);

  const areas = workspaces.data?.items.filter((w) => w.status === 'active') ?? [];
  const chosenArea = workspaceId || areas[0]?.id || '';

  const create = useStudioMutation(
    (body: { workspaceId: string; name: string; allowedOrigins: string[] }, tenant) =>
      api<Brand>('/v1/admin/brands', { method: 'POST', body, tenant, idempotencyKey }),
    [keys.brands, keys.workspaces],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t('brands.nameRequired');
    const parsed = parseWebsites(websites);
    const invalid = parsed.invalid[0];
    if (invalid !== undefined) next.websites = t('brands.websiteInvalid', { value: invalid });
    setErrors(next);
    if (Object.keys(next).length > 0 || !chosenArea) return;
    try {
      const brand = await create.mutateAsync({
        workspaceId: chosenArea,
        name: name.trim(),
        allowedOrigins: parsed.origins,
      });
      announce(t('brands.created', { name: brand.name }));
      onOpenChange(false);
    } catch {
      // Shown below the form.
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({ fieldId: `brand-${field}`, message }))
    : [];

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next);
      }}
      title={t('brands.createTitle')}
      testId="create-brand-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        <TextField
          id="brand-name"
          label={t('brands.name')}
          hint={t('brands.nameHint')}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          error={errors.name}
        />
        <TextareaField
          id="brand-websites"
          label={t('brands.websites')}
          hint={t('brands.websitesHint')}
          value={websites}
          rows={3}
          dir="ltr"
          spellCheck={false}
          onChange={(event) => setWebsites(event.target.value)}
          error={errors.websites}
        />
        {areas.length > 1 ? (
          <SelectField
            id="brand-area"
            label={t('brands.area')}
            value={chosenArea}
            onChange={(event) => setWorkspaceId(event.target.value)}
            options={areas.map((w) => ({ value: w.id, label: w.name }))}
          />
        ) : null}
        <ActionError error={workspaces.error ?? create.error} />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={create.isPending} disabled={!chosenArea}>
            {t('brands.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function ChatConnection({
  brand,
  connection,
  connectionsState,
}: {
  brand: Brand;
  connection: AuthorityConnection | undefined;
  connectionsState: 'ready' | 'loading' | 'hidden';
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const [open, setOpen] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const connect = useStudioMutation(
    (_: undefined, tenant) =>
      api<AuthorityConnection>('/v1/admin/authority/connections', {
        method: 'POST',
        body: { brandId: brand.id },
        tenant,
        idempotencyKey,
      }),
    [keys.connections, keys.agents],
  );

  if (connectionsState === 'loading') return <Skeleton className="h-6 w-28 rounded-full" />;
  if (connectionsState === 'hidden') {
    return <p className="text-sm text-text-secondary">{t('brands.chat.statusHidden')}</p>;
  }
  if (connection) {
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="chat-connection">
        <ConnectionBadge status={connection.status} />
        <span className="text-sm text-text-secondary">
          {t('brands.chat.account', { id: connection.accountId })}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-3" data-testid="chat-connection">
      <ConnectionBadge status="none" />
      <ReasonedAction reason={can('integrations.manage') ? null : t('brands.chat.noPermission')}>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <PlugZapIcon aria-hidden="true" />
          {t('brands.chat.connect')}
        </Button>
      </ReasonedAction>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('brands.chat.connectTitle', { name: brand.name })}
        confirmLabel={t('brands.chat.connectSubmit')}
        testId="connect-chatwoot-dialog"
        onConfirm={async () => {
          await connect.mutateAsync(undefined);
          announce(t('brands.chat.connected', { name: brand.name }));
        }}
      >
        <p>{t('brands.chat.connectIntro')}</p>
        <ul className="list-disc ps-5 text-text">
          <li>{t('brands.chat.connectItem1')}</li>
          <li>{t('brands.chat.connectItem2')}</li>
          <li>{t('brands.chat.connectItem3')}</li>
        </ul>
        <p className="text-text-secondary">{t('brands.chat.connectNote')}</p>
      </ConfirmDialog>
    </div>
  );
}

function BrandCard({
  brand,
  connection,
  connectionsState,
}: {
  brand: Brand;
  connection: AuthorityConnection | undefined;
  connectionsState: 'ready' | 'loading' | 'hidden';
}) {
  const { t } = useTranslation();
  const snippet = installSnippet(brand.widgetId);
  const codeRef = useRef<HTMLElement>(null);
  const titleId = `brand-${brand.id}-title`;
  return (
    <section
      id={`brand-${brand.id}`}
      aria-labelledby={titleId}
      data-testid="brand-card"
      data-brand={brand.name}
      className="flex scroll-mt-24 flex-col gap-6 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={titleId} tabIndex={-1} className="text-lg font-semibold text-text">
            <bdi>{brand.name}</bdi>
          </h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
            {t('brands.widgetId')}:{' '}
            <bdi dir="ltr" className="font-mono text-text">
              {brand.widgetId}
            </bdi>
          </p>
        </div>
        {brand.status === 'disabled' ? (
          <StatusBadge tone="neutral">{t('status.connection.disabled')}</StatusBadge>
        ) : null}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-text">{t('brands.allowed')}</h3>
            {brand.allowedOrigins.length === 0 ? (
              <p className="text-sm text-warning">{t('brands.noWebsites')}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {brand.allowedOrigins.map((origin) => (
                  <li
                    key={origin}
                    className="inline-flex items-center gap-1.5 rounded-md bg-surface-sunken px-2 py-1 text-sm"
                  >
                    <GlobeIcon className="size-3.5 text-text-muted" aria-hidden="true" />
                    <bdi dir="ltr">{origin}</bdi>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-text-secondary">{t('brands.editNote')}</p>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-text">{t('brands.chat.title')}</h3>
            <ChatConnection
              brand={brand}
              connection={connection}
              connectionsState={connectionsState}
            />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <h3 className="text-sm font-semibold text-text">{t('brands.install.title')}</h3>
          <p className="text-sm text-text-secondary">{t('brands.install.description')}</p>
          {/* The snippet wraps (see .hv-code), so it never needs scrolling to be read. */}
          <pre className="rounded-lg border border-border bg-surface-sunken p-3 text-sm">
            <code ref={codeRef} className="hv-code" data-testid="install-snippet">
              {snippet}
            </code>
          </pre>
          <CopyButton
            text={snippet}
            label={t('brands.install.copy')}
            copiedLabel={t('brands.install.copied')}
            failedLabel={t('brands.install.copyFailed')}
            selectTarget={() => codeRef.current}
            testId="copy-snippet"
          />
          <p className="text-xs text-text-secondary">{t('brands.install.note')}</p>
        </div>
      </div>
    </section>
  );
}

/** Brands and install (boards 04 and 17: HNV-17-02 review, 17-03 connected, 17-05 install). */
export function BrandsPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const brands = useBrands();
  const connections = useAuthorityConnections();
  const [creating, setCreating] = useState(false);
  const hash = useRouterState({ select: (state) => state.location.hash });

  const connectionsState: 'ready' | 'loading' | 'hidden' = connections.data
    ? 'ready'
    : can('integrations.manage') && connections.isPending
      ? 'loading'
      : 'hidden';

  // "Install" on the overview links to a brand; bring it into view once the list has loaded.
  useEffect(() => {
    if (!hash || !brands.data) return;
    const target = document.getElementById(hash);
    target?.scrollIntoView({ block: 'start' });
    target?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, [hash, brands.data]);

  const create = can('brands.manage') ? (
    <Button onClick={() => setCreating(true)}>
      <PlusIcon aria-hidden="true" />
      {t('brands.create')}
    </Button>
  ) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('brands.title')}
        description={t('brands.description')}
        actions={create}
      />
      <QueryState
        query={brands}
        label={t('brands.loading')}
        permitted={can('brands.manage')}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('brands.empty.title')}
            description={t('brands.empty.description')}
            action={
              <Button onClick={() => setCreating(true)}>
                <PlusIcon aria-hidden="true" />
                {t('brands.create')}
              </Button>
            }
          />
        }
      >
        {(data) => (
          <div className="flex flex-col gap-6">
            {data.items.map((brand) => (
              <BrandCard
                key={brand.id}
                brand={brand}
                connection={connectionFor(connections.data?.items, brand.id)}
                connectionsState={connectionsState}
              />
            ))}
          </div>
        )}
      </QueryState>
      <CreateBrandDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
