import { Button } from '@hamnivo/ui/components/button';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { PencilIcon, PlusIcon, Trash2Icon, UploadIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toolKeys } from '../../lib/actions';
import type { HttpToolEndpoint, HttpToolSource } from '../../lib/ai-power';
import { api } from '../../lib/api';
import { useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { ActionError } from '../States';
import { HttpEndpointDialog } from './HttpEndpointDialog';
import { HttpImportDialog } from './HttpImportDialog';
import { EditHttpSourceDialog, RemoveHttpSourceDialog } from './HttpSourceDialogs';
import { isolate, RequestLine } from './HttpToolForms';

const STATUS_TONES = { review: 'warning', enabled: 'success', disabled: 'neutral' } as const;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function SourceCard({
  source,
  manage,
  onOpenTool,
}: {
  source: HttpToolSource;
  manage: boolean;
  onOpenTool: (toolId: string) => void;
}) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<'edit' | 'remove' | 'import' | 'add' | null>(null);
  const [editing, setEditing] = useState<HttpToolEndpoint | null>(null);
  const toggle = useStudioMutation(
    (status: 'active' | 'disabled', tenant) =>
      api<HttpToolSource>(`/v1/admin/http-tools/sources/${source.id}`, {
        method: 'PATCH',
        body: { status },
        tenant,
      }),
    [toolKeys.tools],
  );
  const review = source.endpoints.filter((endpoint) => endpoint.status === 'review').length;
  const auth =
    source.auth.kind === 'none'
      ? t('aiPower.http.source.auth.none')
      : source.auth.kind === 'bearer'
        ? t('aiPower.http.source.auth.bearer', { masked: source.auth.masked ?? '' })
        : t('aiPower.http.source.auth.header', {
            header: source.auth.header ?? '',
            masked: source.auth.masked ?? '',
          });

  return (
    <li
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
      data-http-source={source.name}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <p className="font-medium text-text">
            <bdi>{source.name}</bdi>
          </p>
          <p className="text-xs text-text-secondary">
            <bdi dir="ltr" className="font-mono break-all">
              {hostOf(source.baseUrl)}
            </bdi>
            {' · '}
            {t(`aiPower.http.source.kinds.${source.kind}`)}
          </p>
        </div>
        <StatusBadge tone={source.status === 'active' ? 'success' : 'neutral'}>
          {t(`aiPower.http.source.status.${source.status}`)}
        </StatusBadge>
      </div>
      <p className="text-sm text-text">
        {t('aiPower.http.source.tools', { total: source.endpoints.length })}
        {review > 0 ? ` · ${t('aiPower.http.source.review', { total: review })}` : ''}
      </p>
      <p className="text-xs text-text-secondary" data-testid="http-source-auth">
        <bdi>{auth}</bdi>
        {source.specTitle
          ? ` · ${t('aiPower.http.source.spec', {
              title: isolate(source.specTitle),
              version: isolate(source.specVersion ?? ''),
            })}`
          : ''}
      </p>
      {source.status === 'disabled' ? (
        <p className="text-sm text-text-secondary">{t('aiPower.http.source.off')}</p>
      ) : null}

      <ul
        className="flex flex-col divide-y divide-border rounded-lg border border-border"
        aria-label={t('aiPower.http.source.requests', { name: source.name })}
      >
        {source.endpoints.map((endpoint) => (
          <li
            key={endpoint.toolId}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            data-endpoint={endpoint.toolName}
          >
            <div className="flex min-w-0 flex-col gap-1">
              <RequestLine method={endpoint.method} path={endpoint.path} />
              <span className="flex flex-wrap items-center gap-2 text-sm text-text">
                <bdi>{endpoint.title}</bdi>
                <StatusBadge tone={STATUS_TONES[endpoint.status]}>
                  {t(`aiPower.http.source.toolStatus.${endpoint.status}`)}
                </StatusBadge>
              </span>
              {endpoint.editable ? null : (
                <span className="text-xs text-text-secondary">
                  {t('aiPower.http.source.imported')}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenTool(endpoint.toolId)}
                aria-label={t('aiPower.http.source.openLabel', { tool: endpoint.title })}
              >
                {t('aiPower.http.source.open')}
              </Button>
              {manage && endpoint.editable ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(endpoint);
                    setDialog('add');
                  }}
                  aria-label={t('aiPower.http.source.editRequestLabel', { tool: endpoint.title })}
                  data-testid="edit-request"
                >
                  <PencilIcon aria-hidden="true" />
                  {t('aiPower.http.source.editRequest')}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <ActionError error={isCancelled(toggle.error) ? null : toggle.error} />
      {manage ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={source.status !== 'active'}
            onClick={() => {
              setEditing(null);
              setDialog('add');
            }}
            data-testid="add-request"
          >
            <PlusIcon aria-hidden="true" />
            {t('aiPower.http.source.addRequest')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={source.status !== 'active'}
            onClick={() => setDialog('import')}
          >
            <UploadIcon aria-hidden="true" />
            {t('aiPower.http.source.importMore')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            busy={toggle.isPending}
            onClick={() =>
              void toggle
                .mutateAsync(source.status === 'active' ? 'disabled' : 'active')
                .catch(() => undefined)
            }
          >
            {source.status === 'active'
              ? t('aiPower.http.source.turnOff')
              : t('aiPower.http.source.turnOn')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDialog('edit')}
            aria-label={t('aiPower.http.source.editLabel', { name: source.name })}
            data-testid="edit-http-source"
          >
            <PencilIcon aria-hidden="true" />
            {t('aiPower.http.source.edit')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDialog('remove')}
            aria-label={t('aiPower.http.source.removeLabel', { name: source.name })}
            data-testid="remove-http-source"
          >
            <Trash2Icon aria-hidden="true" />
            {t('aiPower.http.source.remove')}
          </Button>
        </div>
      ) : null}

      <EditHttpSourceDialog
        source={source}
        open={dialog === 'edit'}
        onOpenChange={(open) => setDialog(open ? 'edit' : null)}
      />
      <RemoveHttpSourceDialog
        source={source}
        open={dialog === 'remove'}
        onOpenChange={(open) => setDialog(open ? 'remove' : null)}
      />
      <HttpImportDialog
        open={dialog === 'import'}
        onOpenChange={(open) => setDialog(open ? 'import' : null)}
        brandId={source.brandId}
        source={source}
      />
      <HttpEndpointDialog
        mode={
          dialog === 'add'
            ? editing
              ? { kind: 'edit', source, endpoint: editing }
              : { kind: 'add', source }
            : null
        }
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      />
    </li>
  );
}

/** The brand's services of custom HTTP tools: what each is, how it signs in, and its tools. */
export function HttpToolSources({
  sources,
  manage,
  onOpenTool,
}: {
  sources: HttpToolSource[];
  manage: boolean;
  onOpenTool: (toolId: string) => void;
}) {
  return (
    <ul className="grid gap-3 md:grid-cols-2" data-testid="http-sources">
      {sources.map((source) => (
        <SourceCard key={source.id} source={source} manage={manage} onOpenTool={onOpenTool} />
      ))}
    </ul>
  );
}
