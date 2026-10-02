import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { Input } from '@hamnivo/ui/components/input';
import { Label } from '@hamnivo/ui/components/label';
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
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { CircleCheckIcon, LockIcon, SearchIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { ConnectionBadge } from '../../components/Badges';
import { CheckboxField, SelectField, TextareaField } from '../../components/Fields';
import { ActionError, QueryState } from '../../components/States';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber } from '../../lib/format';
import {
  platformKeys,
  usePlatformMutation,
  usePlatformOverview,
  usePlatformTenant,
  usePlatformTenants,
} from '../../lib/platform';
import type {
  AuthorityConnection,
  PlatformOperator,
  PlatformTenant,
  PlatformTenantDetail,
  SupportGrant,
  SupportScope,
} from '../../lib/types';
import { canPlatform } from './PlatformPage';

const TENANT_TONE: Record<PlatformTenant['status'], StatusTone> = {
  active: 'success',
  suspended: 'warning',
  closing: 'neutral',
};
export const GRANT_TONE: Record<SupportGrant['state'], StatusTone> = {
  pending: 'warning',
  active: 'info',
  declined: 'danger',
  revoked: 'neutral',
  ended: 'neutral',
  expired: 'neutral',
};
const AREAS: SupportScope[] = ['configuration', 'conversations', 'audit'];
const MINUTES = [15, 30, 60, 120, 240];

function Overview() {
  const { t } = useTranslation();
  const overview = usePlatformOverview(true);
  const data = overview.data;
  if (!data) return null;
  const cards: [string, string][] = [
    [
      t('platform.overview.tenants'),
      `${formatNumber(data.tenants.total)} · ${t('platform.overview.active', { n: formatNumber(data.tenants.active) })}`,
    ],
    [t('platform.overview.supportActive'), formatNumber(data.activeSupportGrants)],
    [t('platform.overview.supportPending'), formatNumber(data.pendingSupportRequests)],
    [t('platform.overview.aiStops'), formatNumber(data.aiStops)],
    [t('platform.overview.providersOff'), formatNumber(data.providersOff)],
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" data-testid="platform-overview">
      {cards.map(([label, value]) => (
        <div
          key={label}
          className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4"
        >
          <dt className="text-sm text-text-secondary">{label}</dt>
          <dd className="text-xl font-semibold text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RequestDialog({
  tenant,
  onOpenChange,
  onSent,
}: {
  tenant: PlatformTenantDetail;
  onOpenChange: (open: boolean) => void;
  onSent: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [areas, setAreas] = useState<SupportScope[]>(['configuration']);
  const [minutes, setMinutes] = useState(30);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const request = usePlatformMutation(
    (body: Record<string, unknown>) =>
      api<SupportGrant>('/v1/platform/support-grants', { method: 'POST', body }),
    [platformKeys.grants, platformKeys.tenant(tenant.id), platformKeys.overview],
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (reason.trim().length < 10) next.reason = t('platform.request.reasonShort');
    if (areas.length === 0) next.areas = t('access.security.support.pickArea');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      await request.mutateAsync({
        tenantId: tenant.id,
        reason: reason.trim(),
        scopes: areas,
        durationMinutes: minutes,
      });
      onSent(t('platform.request.sent'));
      onOpenChange(false);
    } catch {
      // Shown in the dialog.
    }
  };
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!request.isPending) onOpenChange(open);
      }}
      title={t('platform.request.title', { name: tenant.name })}
      description={t('platform.request.description')}
      testId="request-access-dialog"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary
          title={t('auth.errorSummary')}
          errors={Object.entries(errors).map(([field, message]) => ({
            fieldId: field === 'areas' ? 'request-area-configuration' : `request-${field}`,
            message,
          }))}
        />
        <TextareaField
          id="request-reason"
          label={t('platform.request.reason')}
          hint={t('platform.request.reasonHint')}
          value={reason}
          rows={3}
          maxLength={400}
          onChange={(event) => setReason(event.target.value)}
          error={errors.reason}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-text">
            {t('platform.request.areas')}
          </legend>
          {AREAS.map((area) => (
            <CheckboxField
              key={area}
              id={`request-area-${area}`}
              label={t(`access.security.support.scopes.${area}`)}
              checked={areas.includes(area)}
              onCheckedChange={(checked) =>
                setAreas((current) =>
                  checked ? [...current, area] : current.filter((a) => a !== area),
                )
              }
            />
          ))}
          {errors.areas ? <p className="text-sm text-danger">{errors.areas}</p> : null}
        </fieldset>
        <SelectField
          id="request-minutes"
          label={t('platform.request.minutes')}
          value={String(minutes)}
          onChange={(event) => setMinutes(Number(event.target.value))}
          options={MINUTES.map((m) => ({
            value: String(m),
            label: t('access.security.support.duration', { minutes: m }),
          }))}
        />
        <ActionError error={request.error} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={request.isPending} data-testid="send-access-request">
            {t('platform.request.submit')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

function TenantDetail({ id, operator }: { id: string; operator: PlatformOperator }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const detail = usePlatformTenant(id);
  const [requesting, setRequesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <section
      aria-labelledby="tenant-detail-title"
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
      data-testid="tenant-detail"
    >
      <QueryState query={detail} label={t('platform.tenants.detail')}>
        {(tenant) => (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="tenant-detail-title" className="text-xl font-semibold text-text">
                <bdi>{tenant.name}</bdi>
              </h2>
              <StatusBadge tone={TENANT_TONE[tenant.status]}>
                {t(`platform.tenants.status.${tenant.status}`)}
              </StatusBadge>
            </div>
            <p className="text-sm text-text-secondary">{t('platform.tenants.contentNote')}</p>
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-text-secondary">{t('platform.tenants.id')}</dt>
              <dd>
                <bdi dir="ltr" className="font-mono text-xs">
                  {tenant.id}
                </bdi>
              </dd>
              <dt className="text-text-secondary">{t('platform.tenants.created')}</dt>
              <dd>{formatDateTime(tenant.createdAt)}</dd>
              <dt className="text-text-secondary">{t('platform.tenants.region')}</dt>
              <dd>{tenant.region}</dd>
              <dt className="text-text-secondary">{t('platform.tenants.locale')}</dt>
              <dd>{tenant.defaultLocale}</dd>
            </dl>
            <p className="text-sm text-text">
              {t('platform.tenants.counts', {
                workspaces: formatNumber(tenant.workspaces),
                brands: formatNumber(tenant.brands),
              })}
            </p>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold text-text">{t('platform.tenants.connectors')}</h3>
                {tenant.connectorList.length === 0 ? (
                  <p className="text-sm text-text-secondary">
                    {t('platform.tenants.noConnectors')}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {tenant.connectorList.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center gap-2">
                        <span className="text-text">{c.kind}</span>
                        <ConnectionBadge status={c.status as AuthorityConnection['status']} />
                        {c.lastHealthAt ? (
                          <span className="text-text-secondary">
                            {t('platform.tenants.connectorHealth', {
                              time: formatDateTime(c.lastHealthAt),
                            })}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold text-text">{t('platform.tenants.aiStops')}</h3>
                {tenant.aiStopList.length === 0 ? (
                  <p className="text-sm text-text-secondary">{t('platform.tenants.noAiStops')}</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm" data-testid="ai-stops">
                    {tenant.aiStopList.map((stop) => (
                      <li key={stop.id}>
                        {t(`platform.tenants.aiStopScope.${stop.scope}`)} ·{' '}
                        {t('shell.since', { time: formatDateTime(stop.since) })}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold text-text">{t('platform.tenants.providers')}</h3>
                {tenant.providerList.length === 0 ? (
                  <p className="text-sm text-text-secondary">{t('platform.tenants.noProviders')}</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {tenant.providerList.map((p, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: providers repeat by kind
                      <li key={`${p.provider}-${index}`} className="flex items-center gap-2">
                        <span>{p.provider}</span>
                        <StatusBadge tone={p.status === 'active' ? 'success' : 'warning'}>
                          {t(`platform.tenants.providerStatus.${p.status}`)}
                        </StatusBadge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-muted p-4">
                <h3 className="flex items-center gap-2 font-semibold text-text">
                  <LockIcon className="size-4" aria-hidden="true" />
                  {t('platform.tenants.noAccess')}
                </h3>
                <p className="text-sm text-text-secondary">{t('platform.tenants.noAccessHint')}</p>
                {canPlatform(operator, 'platform.support.request') ? (
                  <Button
                    className="self-start"
                    onClick={() => setRequesting(true)}
                    disabled={!operator.mfa || tenant.status !== 'active'}
                    data-testid="request-access"
                  >
                    {t('platform.tenants.requestAccess')}
                  </Button>
                ) : null}
              </div>
            </div>
            {notice ? (
              <p role="status" className="flex items-start gap-2 text-sm text-text">
                <CircleCheckIcon
                  className="mt-0.5 size-4 shrink-0 text-success"
                  aria-hidden="true"
                />
                {notice}
              </p>
            ) : null}
            {tenant.supportGrants.length > 0 ? (
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold text-text">{t('platform.tenants.grants')}</h3>
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                  {tenant.supportGrants.map((grant) => (
                    <li key={grant.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                      <bdi className="font-medium">{grant.operator.name}</bdi>
                      <span className="text-text-secondary">
                        {t('access.security.support.asked', {
                          time: formatDateTime(grant.requestedAt),
                        })}
                      </span>
                      <StatusBadge tone={GRANT_TONE[grant.state]} className="ms-auto">
                        {t(`access.security.support.states.${grant.state}`)}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {requesting ? (
              <RequestDialog
                tenant={tenant}
                onOpenChange={setRequesting}
                onSent={(message) => {
                  setNotice(message);
                  announce(message);
                }}
              />
            ) : null}
          </div>
        )}
      </QueryState>
    </section>
  );
}

/** Tenants, their state and health, with metadata only (A17). */
export function TenantsView({ operator }: { operator: PlatformOperator }) {
  const { t } = useTranslation();
  const search = useSearch({ from: '/platform' });
  const navigate = useNavigate({ from: '/platform' });
  const [query, setQuery] = useState(search.q ?? '');
  const tenants = usePlatformTenants(search.q ?? '', true);
  return (
    <div className="flex flex-col gap-6">
      <Overview />
      <form
        className="flex max-w-md flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void navigate({ search: (prev) => ({ ...prev, q: query.trim() || undefined }) });
        }}
      >
        <Label htmlFor="tenant-search">{t('platform.tenants.search')}</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon
              className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-text-muted"
              aria-hidden="true"
            />
            <Input
              id="tenant-search"
              type="search"
              className="ps-9"
              value={query}
              placeholder={t('platform.tenants.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Button type="submit" variant="secondary">
            {t('platform.tenants.search')}
          </Button>
        </div>
      </form>
      <QueryState
        query={tenants}
        label={t('platform.tenants.loading')}
        isEmpty={(data) => data.items.length === 0}
        empty={<p className="text-sm text-text-secondary">{t('platform.tenants.empty')}</p>}
      >
        {(data) => (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
            <Table data-testid="tenants-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-start">{t('platform.tenants.columns.name')}</TableHead>
                  <TableHead className="text-start">
                    {t('platform.tenants.columns.status')}
                  </TableHead>
                  <TableHead className="text-start">
                    {t('platform.tenants.columns.region')}
                  </TableHead>
                  <TableHead className="text-start">
                    {t('platform.tenants.columns.aiStops')}
                  </TableHead>
                  <TableHead className="text-start">
                    {t('platform.tenants.columns.support')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((tenant) => (
                  <TableRow
                    key={tenant.id}
                    data-tenant={tenant.slug}
                    aria-current={search.tenant === tenant.id ? 'true' : undefined}
                  >
                    <TableCell>
                      <Link
                        to="/platform"
                        search={(prev) => ({ ...prev, tenant: tenant.id })}
                        className="font-medium text-link underline underline-offset-4 hover:no-underline"
                        aria-label={t('platform.tenants.open', { name: tenant.name })}
                      >
                        <bdi>{tenant.name}</bdi>
                      </Link>
                      <bdi dir="ltr" className="block text-xs text-text-secondary">
                        {tenant.slug}
                      </bdi>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={TENANT_TONE[tenant.status]}>
                        {t(`platform.tenants.status.${tenant.status}`)}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>{tenant.region}</TableCell>
                    <TableCell>{formatNumber(tenant.aiStops)}</TableCell>
                    <TableCell>{formatNumber(tenant.activeSupportGrants)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryState>
      {search.tenant ? <TenantDetail id={search.tenant} operator={operator} /> : null}
    </div>
  );
}
