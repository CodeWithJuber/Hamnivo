import { Button } from '@hamnivo/ui/components/button';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckboxField, SelectField, TextField } from '../components/Fields';
import { PageHeader } from '../components/PageHeader';
import { ActionError, QueryState } from '../components/States';
import { api } from '../lib/api';
import type { BrandingSettings, EmailBranding, PortalBranding } from '../lib/branding';
import { useStudioMutation, useStudioQuery } from '../lib/queries';
import { useTenant } from '../lib/tenant';
import { LeaveGuard } from './settings/DiscardChangesDialog';

function BrandingEditor({ settings }: { settings: BrandingSettings }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const [portal, setPortal] = useState(settings.portal);
  const [email, setEmail] = useState(settings.email);
  const [hostname, setHostname] = useState('');
  const [saved, setSaved] = useState(false);
  const dirty =
    JSON.stringify(portal) !== JSON.stringify(settings.portal) ||
    JSON.stringify(email) !== JSON.stringify(settings.email);
  const update = useStudioMutation(
    (_: undefined, tenant) =>
      api<BrandingSettings>('/v1/admin/branding', {
        tenant,
        method: 'PUT',
        body: { portal, email },
      }),
    [['branding']],
  );
  const domains = useStudioMutation(
    (v: { path: string; body?: unknown }, tenant) =>
      api(`/v1/admin/branding/domains${v.path}`, { tenant, method: 'POST', body: v.body }),
    [['branding']],
  );
  const setPortalField = <K extends keyof PortalBranding>(key: K, value: PortalBranding[K]) => {
    setPortal({ ...portal, [key]: value });
    setSaved(false);
  };
  const setEmailField = <K extends keyof EmailBranding>(key: K, value: EmailBranding[K]) => {
    setEmail({ ...email, [key]: value });
    setSaved(false);
  };
  return (
    <div className="flex flex-col gap-6">
      <LeaveGuard dirty={dirty} />
      <ActionError error={update.error ?? domains.error} />
      {saved ? (
        <p role="status" className="text-success">
          {t('agentic.brandingSaved')}
        </p>
      ) : null}
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate(undefined, { onSuccess: () => setSaved(true) });
        }}
      >
        <fieldset
          disabled={!can('branding.manage') || update.isPending}
          className="grid min-w-0 gap-6 lg:grid-cols-2"
        >
          <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
            <h2 className="font-semibold">{t('agentic.portal')}</h2>
            <TextField
              id="portal-name"
              label={t('agentic.name')}
              required
              maxLength={120}
              value={portal.displayName}
              onChange={(e) => setPortalField('displayName', e.target.value)}
            />
            <TextField
              id="portal-logo"
              label={t('setup.appearance.logo.label')}
              type="url"
              pattern="https://.*"
              value={portal.logoUrl ?? ''}
              onChange={(e) => setPortalField('logoUrl', e.target.value || null)}
            />
            <TextField
              id="portal-favicon"
              label={t('agentic.favicon')}
              type="url"
              pattern="https://.*"
              value={portal.faviconUrl ?? ''}
              onChange={(e) => setPortalField('faviconUrl', e.target.value || null)}
            />
            <TextField
              id="portal-color"
              label={t('setup.appearance.colour.label')}
              value={portal.accentColor}
              pattern="#[0-9a-fA-F]{6}"
              required
              dir="ltr"
              onChange={(e) => setPortalField('accentColor', e.target.value)}
            />
            <SelectField
              id="portal-font"
              label={t('agentic.font')}
              value={portal.fontFamily}
              onChange={(e) =>
                setPortalField('fontFamily', e.target.value as PortalBranding['fontFamily'])
              }
              options={[
                { value: 'system', label: 'System' },
                { value: 'dm-sans', label: 'DM Sans' },
                { value: 'noto-sans', label: 'Noto Sans' },
              ]}
            />
            <CheckboxField
              id="portal-branding"
              label={t('agentic.showBranding')}
              checked={portal.showBranding}
              onCheckedChange={(v) => setPortalField('showBranding', v)}
            />
          </section>
          <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
            <h2 className="font-semibold">{t('agentic.customerEmail')}</h2>
            <p className="text-sm text-text-secondary">{t('agentic.emailLimits')}</p>
            <TextField
              id="email-name"
              label={t('agentic.senderName')}
              value={email.senderName ?? ''}
              maxLength={80}
              onChange={(e) => setEmailField('senderName', e.target.value || null)}
            />
            <TextField
              id="email-reply"
              label={t('agentic.replyTo')}
              type="email"
              value={email.replyTo ?? ''}
              onChange={(e) => setEmailField('replyTo', e.target.value || null)}
            />
            <TextField
              id="email-logo"
              label={t('setup.appearance.logo.label')}
              type="url"
              pattern="https://.*"
              value={email.logoUrl ?? ''}
              onChange={(e) => setEmailField('logoUrl', e.target.value || null)}
            />
          </section>
        </fieldset>
        {can('branding.manage') ? (
          <div>
            <Button busy={update.isPending} disabled={!dirty}>
              {t('agentic.saveBranding')}
            </Button>
          </div>
        ) : null}
      </form>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">{t('agentic.domains')}</h2>
        <p className="text-sm text-text-secondary">{t('agentic.domainReadiness')}</p>
        <ul className="grid gap-3 lg:grid-cols-2">
          {settings.domains.map((domain) => (
            <li
              key={domain.id}
              className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4"
            >
              <h3 className="font-semibold">
                <bdi>{domain.hostname}</bdi>
              </h3>
              <p className="text-sm">{t(`agentic.domainStates.${domain.status}`)}</p>
              <dl className="grid gap-2 text-sm">
                <div>
                  <dt>{t('agentic.dnsName')}</dt>
                  <dd className="select-all break-all font-mono" dir="ltr">
                    {domain.verification.name}
                  </dd>
                </div>
                <div>
                  <dt>{t('agentic.dnsValue')}</dt>
                  <dd className="select-all break-all font-mono" dir="ltr">
                    {domain.verification.value}
                  </dd>
                </div>
              </dl>
              <p className="text-sm">
                {t('agentic.routing')}: {t(domain.routingReady ? 'agentic.yes' : 'agentic.no')} ·
                TLS: {t(domain.tlsReady ? 'agentic.yes' : 'agentic.no')}
              </p>
              {domain.lastCheckResult ? (
                <p className="text-sm">
                  {t(`agentic.domainChecks.${domain.lastCheckResult}`)}
                  {domain.lastCheckedAt
                    ? ` · ${new Date(domain.lastCheckedAt).toLocaleString()}`
                    : ''}
                </p>
              ) : null}
              {can('branding.manage') ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    busy={domains.isPending}
                    disabled={domain.status === 'disabled'}
                    onClick={() => domains.mutate({ path: `/${domain.id}/verify` })}
                  >
                    {t('agentic.verify')}
                  </Button>
                  <Button
                    variant="ghost"
                    busy={domains.isPending}
                    disabled={domain.status === 'disabled'}
                    onClick={() => domains.mutate({ path: `/${domain.id}/disable` })}
                  >
                    {t('agentic.disable')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {can('branding.manage') ? (
          <form
            className="flex max-w-xl flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              domains.mutate(
                { path: '', body: { hostname: hostname.trim().toLowerCase() } },
                { onSuccess: () => setHostname('') },
              );
            }}
          >
            <TextField
              id="branding-hostname"
              label={t('agentic.hostname')}
              required
              value={hostname}
              dir="ltr"
              onChange={(e) => setHostname(e.target.value)}
            />
            <div>
              <Button variant="secondary" busy={domains.isPending}>
                {t('agentic.addDomain')}
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}
export function BrandingPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const query = useStudioQuery<BrandingSettings>(['branding'], '/v1/admin/branding', {
    enabled: can('branding.read'),
  });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('agentic.branding')} description={t('agentic.brandingDescription')} />
      {can('agency.read') ? (
        <div>
          <Button asChild variant="secondary">
            <Link to="/agency">{t('agentic.clients')}</Link>
          </Button>
        </div>
      ) : null}
      <QueryState query={query} label={t('app.loading')} permitted={can('branding.read')}>
        {(data) => <BrandingEditor key={JSON.stringify(data)} settings={data} />}
      </QueryState>
    </div>
  );
}
