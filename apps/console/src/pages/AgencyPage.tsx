import { Button } from '@hamnivo/ui/components/button';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextField } from '../components/Fields';
import { PageHeader } from '../components/PageHeader';
import { ActionError, QueryState } from '../components/States';
import { type AgencyClient, agencyRequest, useAgency } from '../lib/agency';
import { api, newIdempotencyKey } from '../lib/api';
import { useStudioMutation, useStudioQuery } from '../lib/queries';
import { chooseTenant, useTenant } from '../lib/tenant';
export function AgencyPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const agency = useAgency();
  const mode = useStudioMutation(
    (enabled: boolean, tenant) =>
      api('/v1/admin/agency', { tenant, method: 'PATCH', body: { enabled } }),
    [['agency']],
  );
  const directory = useStudioQuery<{ items: AgencyClient[] }>(
    ['agency', 'clients'],
    '/v1/admin/agency/clients',
    { enabled: can('agency.read') && agency.data?.enabled === true },
  );
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [child, setChild] = useState('');
  const [attemptKey, setAttemptKey] = useState(newIdempotencyKey);
  const client = useQueryClient();
  const router = useRouter();
  const change = useStudioMutation(
    async (v: { path: string; body?: unknown; remove?: boolean }, tenant) =>
      agencyRequest(
        v.path,
        tenant,
        v.body,
        v.remove ? 'DELETE' : 'POST',
        v.path === '' ? attemptKey : undefined,
      ),
    [['agency', 'clients']],
  );
  const create = async () => {
    await change.mutateAsync({ path: '', body: { name: name.trim(), slug } });
    setName('');
    setSlug('');
    setAttemptKey(newIdempotencyKey());
    await client.invalidateQueries({ queryKey: ['me'] });
  };
  const open = async (id: string) => {
    chooseTenant(id);
    client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    await router.navigate({ to: '/overview' });
  };
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('agentic.clients')} description={t('agentic.directory')} />
      <ActionError error={change.error ?? mode.error} />
      <QueryState query={agency} label={t('app.loading')} permitted={can('agency.read')}>
        {(data) =>
          data.enabled ? (
            <>
              <QueryState query={directory} label={t('app.loading')}>
                {(list) => (
                  <ul className="grid gap-3 md:grid-cols-2">
                    {list.items.map((row) => (
                      <li
                        key={row.tenant.id}
                        className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
                      >
                        <h2 className="font-semibold">
                          <bdi>{row.tenant.name}</bdi>
                        </h2>
                        <p className="text-sm text-text-secondary">
                          <bdi>{row.tenant.slug}</bdi> · {row.tenant.status}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {row.canAccess ? (
                            <Button variant="secondary" onClick={() => void open(row.tenant.id)}>
                              {t('agentic.switch')}
                            </Button>
                          ) : (
                            <p>{t('agentic.noAccess')}</p>
                          )}
                          {can('agency.manage') ? (
                            <Button
                              variant="ghost"
                              busy={change.isPending}
                              onClick={() =>
                                change.mutate({ path: `/${row.tenant.id}`, remove: true })
                              }
                            >
                              {t('agentic.unlink')}
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                    {list.items.length === 0 ? <li>{t('agentic.empty')}</li> : null}
                  </ul>
                )}
              </QueryState>
              {can('agency.manage') ? (
                <div className="grid gap-6 md:grid-cols-2">
                  <form
                    className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void create().catch(() => undefined);
                    }}
                  >
                    <TextField
                      id="client-name"
                      label={t('agentic.name')}
                      value={name}
                      required
                      maxLength={120}
                      onChange={(e) => setName(e.target.value)}
                    />
                    <TextField
                      id="client-slug"
                      label={t('agentic.slug')}
                      value={slug}
                      required
                      pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
                      dir="ltr"
                      onChange={(e) => setSlug(e.target.value)}
                    />
                    <Button busy={change.isPending}>{t('agentic.create')}</Button>
                  </form>
                  <form
                    className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      change.mutate(
                        { path: '/link', body: { tenantId: child.trim() } },
                        { onSuccess: () => setChild('') },
                      );
                    }}
                  >
                    <TextField
                      id="client-link"
                      label={t('agentic.tenantId')}
                      value={child}
                      required
                      dir="ltr"
                      onChange={(e) => setChild(e.target.value)}
                    />
                    <p className="text-sm text-text-secondary">{t('agentic.directory')}</p>
                    <Button variant="secondary" busy={change.isPending}>
                      {t('agentic.link')}
                    </Button>
                  </form>
                </div>
              ) : null}
            </>
          ) : (
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
              <p>{t('agentic.agencyDisabled')}</p>
              {can('agency.manage') ? (
                <div>
                  <Button busy={mode.isPending} onClick={() => mode.mutate(true)}>
                    {t('agentic.enableAgency')}
                  </Button>
                </div>
              ) : null}
            </div>
          )
        }
      </QueryState>
    </div>
  );
}
