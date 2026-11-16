import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { KeyRoundIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/AppDialog';
import { GoLiveNotices } from '../components/agent/GoLiveNotices';
import { PageHeader } from '../components/PageHeader';
import { QueryState } from '../components/States';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { keys, useModelConnections, useStudioMutation } from '../lib/queries';
import { type ModelConnectionTest, setupKeys, useModelStatus } from '../lib/setup';
import { useTenant } from '../lib/tenant';
import type { ModelConnection } from '../lib/types';
import { AddConnectionDialog } from './models/AddConnectionDialog';
import { AddedBanner } from './models/AddedBanner';
import { ReplaceKeyDialog } from './models/ReplaceKeyDialog';
import { ServerKeys } from './models/ServerKeys';
import { TestKeyDialog } from './models/TestKeyDialog';

/** The key's last characters, the only part ever shown again. */
function KeyEnding({ hint }: { hint: string }) {
  return (
    <bdi dir="ltr" className="font-mono">
      ••••{hint}
    </bdi>
  );
}

/** What the last test of a connection found, or that none was made yet. */
function LastTest({ test }: { test: ModelConnectionTest | undefined }) {
  const { t } = useTranslation();
  if (!test) {
    return <span className="text-text-secondary">{t('setup.models.lastTest.never')}</span>;
  }
  return (
    <div className="flex flex-col items-start gap-1" data-testid="last-test" data-kind={test.kind}>
      <StatusBadge tone={test.ok ? 'success' : 'danger'}>
        {test.ok ? t('setup.models.lastTest.ok') : t(`setup.models.probe.${test.kind}.title`)}
      </StatusBadge>
      <span className="text-xs text-text-secondary">
        <bdi dir="ltr">{test.modelId}</bdi> · {formatDateTime(test.testedAt)}
      </span>
    </div>
  );
}

/** Model provider credentials (the key is write-only; only its ending is shown). */
export function ModelsPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const connections = useModelConnections();
  const status = useModelStatus();
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<{ connection: ModelConnection; modelId?: string } | null>(
    null,
  );
  const [testing, setTesting] = useState<ModelConnection | null>(null);
  const [replacing, setReplacing] = useState<ModelConnection | null>(null);
  const [disabling, setDisabling] = useState<ModelConnection | null>(null);
  const disable = useStudioMutation(
    (id: string, tenant) =>
      api<ModelConnection>(`/v1/admin/model-connections/${id}/disable`, {
        method: 'POST',
        tenant,
      }),
    [keys.modelConnections, setupKeys.modelStatus],
  );
  const tests = new Map((status.data?.tests ?? []).map((test) => [test.connectionId, test]));

  const addButton = (
    <Button onClick={() => setAdding(true)}>
      <PlusIcon aria-hidden="true" />
      {t('models.add')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('models.title')}
        description={t('setup.models.intro')}
        actions={can('integrations.manage') ? addButton : null}
      />
      {added ? (
        <AddedBanner
          key={added.connection.id}
          connection={added.connection}
          modelId={added.modelId}
          onReplace={setReplacing}
        />
      ) : null}
      <GoLiveNotices />
      <QueryState
        query={connections}
        label={t('models.loading')}
        permitted={can('integrations.manage')}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={t('models.empty.title')}
            description={t('setup.models.empty')}
            icon={<KeyRoundIcon className="size-6 text-text-muted" aria-hidden="true" />}
            action={addButton}
          />
        }
      >
        {(data) => (
          <div className="rounded-xl border border-border bg-surface shadow-sm">
            <Table data-testid="connections-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-start">{t('models.columns.label')}</TableHead>
                  <TableHead className="text-start">{t('models.columns.key')}</TableHead>
                  <TableHead className="text-start">{t('models.columns.models')}</TableHead>
                  <TableHead className="text-start">{t('setup.models.columns.lastTest')}</TableHead>
                  <TableHead className="text-start">{t('models.columns.status')}</TableHead>
                  <TableHead className="text-start">{t('models.columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((connection) => (
                  <TableRow key={connection.id} data-connection={connection.label}>
                    <TableCell className="font-medium">
                      <bdi>{connection.label}</bdi>
                      <span className="block text-xs font-normal text-text-secondary">
                        {t(`editor.providers.${connection.provider}`)} ·{' '}
                        {t('setup.models.addedOn', { date: formatDateTime(connection.createdAt) })}
                      </span>
                      {connection.baseUrl ? (
                        <bdi dir="ltr" className="block font-mono text-xs text-text-secondary">
                          {connection.baseUrl}
                        </bdi>
                      ) : null}
                    </TableCell>
                    <TableCell data-testid="key-ending">
                      <span className="sr-only">
                        {t('models.keyEnding', { hint: connection.keyHint })}
                      </span>
                      <span aria-hidden="true">
                        <KeyEnding hint={connection.keyHint} />
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {connection.allowedModels.length === 0 ? (
                        <span className="text-text-secondary">{t('models.anyModel')}</span>
                      ) : (
                        <bdi dir="ltr" className="font-mono text-xs">
                          {connection.allowedModels.join(', ')}
                        </bdi>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {connection.status === 'active' ? (
                        <LastTest test={tests.get(connection.id)} />
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={connection.status === 'active' ? 'success' : 'neutral'}>
                        {t(`models.status.${connection.status}`)}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      {connection.status === 'active' ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setTesting(connection)}
                            aria-label={t('setup.models.testLabel', { label: connection.label })}
                          >
                            {t('setup.models.test')}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setReplacing(connection)}
                            aria-label={t('setup.models.replace.label', {
                              label: connection.label,
                            })}
                          >
                            {t('setup.models.replace.action')}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setDisabling(connection)}
                            aria-label={t('models.disableLabel', { label: connection.label })}
                          >
                            {t('models.disable')}
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryState>
      {can('integrations.manage') ? <ServerKeys /> : null}
      <AddConnectionDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={(connection, modelId) => {
          setAdded({ connection, ...(modelId ? { modelId } : {}) });
          announce(t('models.added', { hint: connection.keyHint }));
        }}
      />
      <TestKeyDialog
        connection={testing}
        onOpenChange={(open) => {
          if (!open) setTesting(null);
        }}
      />
      <ReplaceKeyDialog
        connection={replacing}
        onOpenChange={(open) => {
          if (!open) setReplacing(null);
        }}
      />
      {disabling ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDisabling(null);
          }}
          title={t('models.disableTitle', { label: disabling.label })}
          confirmLabel={t('models.disableSubmit')}
          variant="destructive-solid"
          onConfirm={async () => {
            await disable.mutateAsync(disabling.id);
            announce(t('models.disabled', { label: disabling.label }));
          }}
        >
          <p>{t('models.disableBody')}</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
