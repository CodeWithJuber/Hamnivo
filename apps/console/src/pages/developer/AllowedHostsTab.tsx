import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { PlusIcon, ShieldCheckIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextField } from '../../components/Fields';
import { Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { api, isApiError } from '../../lib/api';
import { type EgressPolicy, useEgressPolicy, useWebhookChange } from '../../lib/developer';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';

interface Row {
  key: number;
  pattern: string;
  note: string;
}

let nextKey = 0;
const rowsOf = (policy: EgressPolicy): Row[] =>
  policy.hosts.map((host) => ({ key: nextKey++, pattern: host.pattern, note: host.note ?? '' }));

function HostsForm({ policy }: { policy: EgressPolicy }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const [rows, setRows] = useState<Row[]>(() => rowsOf(policy));
  useEffect(() => setRows(rowsOf(policy)), [policy]);
  const save = useWebhookChange((body: object, tenant) =>
    api<EgressPolicy>('/v1/admin/network/egress', { method: 'PUT', tenant, body }),
  );
  const manage = can('network.manage');
  const fields = new Map(
    isApiError(save.error) ? save.error.fields.map((f) => [f.path, f.message]) : [],
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const saved = await save.mutateAsync({
        hosts: rows
          .filter((row) => row.pattern.trim() !== '')
          .map((row) => ({
            pattern: row.pattern.trim(),
            ...(row.note.trim() ? { note: row.note.trim() } : {}),
          })),
        version: policy.version,
      });
      announce(
        saved.mode === 'allowlist'
          ? t('developer.hosts.savedList', { count: saved.hosts.length })
          : t('developer.hosts.savedAny'),
      );
    } catch (caught) {
      if (isCancelled(caught)) return;
    }
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <p className="text-sm text-text" data-testid="egress-mode">
        {policy.mode === 'allowlist' ? t('developer.hosts.modeList') : t('developer.hosts.modeAny')}
      </p>
      <fieldset disabled={!manage} className="flex flex-col gap-3">
        <legend className="sr-only">{t('developer.hosts.title')}</legend>
        {rows.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('developer.hosts.empty')}</p>
        ) : null}
        <ul className="flex flex-col gap-3" data-testid="egress-hosts">
          {rows.map((row, index) => (
            <li
              key={row.key}
              className="grid items-start gap-3 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
            >
              <TextField
                id={`host-${row.key}`}
                label={t('developer.hosts.pattern')}
                hint={index === 0 ? t('developer.hosts.patternHint') : undefined}
                value={row.pattern}
                dir="ltr"
                autoComplete="off"
                error={fields.get(`hosts.${index}.pattern`)}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((r) =>
                      r.key === row.key ? { ...r, pattern: event.target.value } : r,
                    ),
                  )
                }
              />
              <TextField
                id={`host-note-${row.key}`}
                label={t('developer.hosts.note')}
                labelNote={t('app.optional')}
                value={row.note}
                maxLength={200}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((r) =>
                      r.key === row.key ? { ...r, note: event.target.value } : r,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                className="sm:mt-7"
                onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                aria-label={t('developer.hosts.remove', { host: row.pattern || '…' })}
              >
                <Trash2Icon aria-hidden="true" />
                <span className="sm:sr-only">{t('developer.hosts.removeShort')}</span>
              </Button>
            </li>
          ))}
        </ul>
        <div>
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              setRows((current) => [...current, { key: nextKey++, pattern: '', note: '' }])
            }
          >
            <PlusIcon aria-hidden="true" />
            {t('developer.hosts.add')}
          </Button>
        </div>
      </fieldset>
      {policy.blockedEndpoints.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm text-text">
          <p className="font-medium">{t('developer.hosts.blocked')}</p>
          <ul className="flex flex-col gap-1" data-testid="blocked-endpoints">
            {policy.blockedEndpoints.map((endpoint) => (
              <li key={endpoint.id}>
                <bdi dir="ltr" className="break-all font-mono text-xs">
                  {endpoint.url}
                </bdi>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ActionError error={save.error && fields.size === 0 ? save.error : null} />
      {manage ? (
        <div>
          <Button type="submit" busy={save.isPending} data-testid="save-hosts">
            {t('developer.hosts.save')}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-text-secondary">{t('developer.hosts.readOnly')}</p>
      )}
    </form>
  );
}

/** The workspace's network allowlist (X05). */
export function AllowedHostsTab() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const policy = useEgressPolicy();
  return (
    <Section
      id="allowed-hosts"
      title={t('developer.hosts.title')}
      description={t('developer.hosts.description')}
    >
      <p className="flex items-start gap-2 text-sm text-text-secondary">
        <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t('developer.hosts.always')}
      </p>
      <QueryState
        query={policy}
        label={t('developer.hosts.loading')}
        permitted={can('webhooks.read') || can('network.manage')}
      >
        {(data) => <HostsForm policy={data} />}
      </QueryState>
    </Section>
  );
}
