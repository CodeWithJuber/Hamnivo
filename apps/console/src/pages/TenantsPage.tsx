import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearch } from '@tanstack/react-router';
import { BuildingIcon, LogOutIcon } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from '../components/AuthLayout';
import { SelectField, TextField } from '../components/Fields';
import { ActionError, QueryState } from '../components/States';
import { LANGUAGE_NAMES, LOCALES } from '../i18n';
import { ApiError, api, newIdempotencyKey } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { usePlatformMe } from '../lib/platform';
import { meQuery } from '../lib/queries';
import { reauth } from '../lib/reauth';
import { reasonOf, useSignupSettings } from '../lib/saas';
import { activeTenantId, chooseTenant } from '../lib/tenant';
import type { Membership } from '../lib/types';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** A URL-safe address from a name: "Noor Books" → "noor-books". */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** Workspaces that open: active ones, and suspended ones (read-only). */
const usable = (m: Membership) =>
  m.status === 'active' && (m.tenant.status === 'active' || m.tenant.status === 'suspended');

/** Tenant choice after sign-in: pick one of yours or create one; the choice is remembered. */
export function TenantsPage() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const search = useSearch({ from: '/tenants' });
  const client = useQueryClient();
  const announce = useAnnouncer();
  const me = useQuery(meQuery());
  const signup = useSignupSettings();
  const operator = usePlatformMe();
  const current = activeTenantId();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [locale, setLocale] = useState<string>(i18n.language);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [closedNotice, setClosedNotice] = useState(false);
  // One key per creation attempt, so a retry after a lost response can't create a second tenant.
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);

  const open = async (tenantId: string) => {
    chooseTenant(tenantId);
    // Nothing from another tenant may stay on screen (HNV-03-06).
    client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    await router.navigate({ href: search.redirect ?? '/overview' });
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t('tenants.create.nameRequired');
    if (!SLUG.test(slug)) next.slug = t('tenants.create.slugInvalid');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const membership = await api<Membership>('/v1/tenants', {
        method: 'POST',
        body: { name: name.trim(), slug, defaultLocale: locale },
        idempotencyKey,
      });
      announce(t('tenants.create.created'));
      await client.invalidateQueries({ queryKey: ['me'] });
      await open(membership.tenant.id);
    } catch (error) {
      if (error instanceof ApiError && error.fields.some((f) => f.path === 'slug')) {
        setErrors({ slug: t('tenants.create.slugTaken') });
      } else if (reasonOf(error) === 'signup_closed') {
        setFailure(null);
        setClosedNotice(true);
      } else {
        setFailure(error);
      }
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    reauth.pause();
    await authClient.signOut().catch(() => undefined);
    client.clear();
    chooseTenant(null);
    await router.navigate({ to: '/sign-in' });
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({ fieldId: `tenant-${field}`, message }))
    : [];
  // With public sign-up closed, workspaces come from the provider (platform operators, and the
  // first person on a new server, may still create one: the gateway decides).
  const closed =
    closedNotice ||
    (signup.data?.open === false && !operator.data && (me.data?.memberships.length ?? 0) > 0);

  return (
    <AuthLayout title={t('tenants.title')} description={t('tenants.description')} wide>
      <div className="flex flex-col gap-8">
        <QueryState query={me} label={t('app.loading')}>
          {(data) => (
            <div className="flex flex-col gap-6">
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <p className="text-text-secondary">
                  {t('nav.signedInAs')}{' '}
                  <bdi dir="ltr" className="font-medium text-text">
                    {data.user.email}
                  </bdi>
                </p>
                <Button variant="ghost" size="sm" onClick={signOut}>
                  <LogOutIcon aria-hidden="true" className="rtl:-scale-x-100" />
                  {t('nav.signOut')}
                </Button>
              </div>
              <section aria-labelledby="tenants-yours" className="flex flex-col gap-3">
                <h2 id="tenants-yours" className="text-md font-semibold text-text">
                  {t('tenants.yours')}
                </h2>
                {data.memberships.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-4 text-sm">
                    <p className="font-medium text-text">{t('tenants.empty.title')}</p>
                    <p className="text-text-secondary">{t('tenants.empty.description')}</p>
                  </div>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {data.memberships.map((m) => (
                      <li
                        key={m.tenant.id}
                        className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
                      >
                        <BuildingIcon className="size-5 text-text-muted" aria-hidden="true" />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="font-medium text-text">
                            <bdi>{m.tenant.name}</bdi>
                          </span>
                          <bdi dir="ltr" className="font-mono text-xs text-text-secondary">
                            {m.tenant.slug}
                          </bdi>
                        </div>
                        {m.tenant.id === current ? (
                          <StatusBadge tone="info">{t('tenants.current')}</StatusBadge>
                        ) : null}
                        {usable(m) && m.tenant.status === 'suspended' ? (
                          <StatusBadge tone="warning">{t('billing.tenants.suspended')}</StatusBadge>
                        ) : null}
                        {usable(m) ? (
                          <Button
                            variant={m.tenant.id === current ? 'default' : 'secondary'}
                            size="sm"
                            onClick={() => open(m.tenant.id)}
                            aria-label={`${t('tenants.open')}: ${m.tenant.name}`}
                          >
                            {t('tenants.open')}
                          </Button>
                        ) : (
                          <span className="flex flex-col items-end gap-1 text-end">
                            <StatusBadge tone="warning">
                              {m.status !== 'active'
                                ? t(`tenants.status.${m.status}`)
                                : t(`tenants.status.${m.tenant.status}`)}
                            </StatusBadge>
                            <span className="text-xs text-text-secondary">
                              {t('tenants.unavailable')}
                            </span>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </QueryState>

        <section aria-labelledby="tenants-create" className="flex flex-col gap-4">
          <h2 id="tenants-create" className="text-md font-semibold text-text">
            {t('tenants.create.title')}
          </h2>
          {closed ? (
            <p
              className="rounded-lg border border-border bg-surface-muted p-4 text-sm text-text"
              data-testid="create-closed"
            >
              {t('billing.tenants.createClosed')}
            </p>
          ) : (
            <form className="flex flex-col gap-5" onSubmit={create} noValidate>
              <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
              <ActionError error={failure} />
              <TextField
                id="tenant-name"
                label={t('tenants.create.name')}
                hint={t('tenants.create.nameHint')}
                value={name}
                error={errors.name}
                autoComplete="organization"
                onChange={(event) => {
                  setName(event.target.value);
                  if (!slugEdited) setSlug(slugify(event.target.value));
                }}
              />
              <TextField
                id="tenant-slug"
                label={t('tenants.create.slug')}
                hint={t('tenants.create.slugHint')}
                value={slug}
                error={errors.slug}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setSlugEdited(true);
                  setSlug(event.target.value.toLowerCase());
                }}
              />
              <SelectField
                id="tenant-locale"
                label={t('tenants.create.language')}
                value={locale}
                onChange={(event) => setLocale(event.target.value)}
                options={LOCALES.map((l) => ({ value: l, label: LANGUAGE_NAMES[l] }))}
              />
              <Button type="submit" busy={busy} className="self-start">
                {t('tenants.create.submit')}
              </Button>
            </form>
          )}
        </section>
      </div>
    </AuthLayout>
  );
}
