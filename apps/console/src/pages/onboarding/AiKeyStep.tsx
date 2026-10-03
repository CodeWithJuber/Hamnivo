import { Button } from '@hamnivo/ui/components/button';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useModelConnections } from '../../lib/queries';
import { hasServerKey, type ModelProbeResult, useModelStatus } from '../../lib/setup';
import { useTenant } from '../../lib/tenant';
import type { ModelConnection } from '../../lib/types';
import { AddConnectionForm } from '../models/AddConnectionDialog';
import { AddedBanner } from '../models/AddedBanner';
import { ReplaceKeyDialog } from '../models/ReplaceKeyDialog';
import { TestKeyDialog } from '../models/TestKeyDialog';

/**
 * Step 4: an AI key, and proof that it works. The same form and the same one-message test as the
 * AI keys page, inline. A workspace that already has a key tests it instead of asking for another,
 * and one whose server holds a key of its own is told it can answer without one here.
 */
export function AiKeyStep({ onDone }: { onDone: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const connections = useModelConnections();
  const status = useModelStatus();
  const [added, setAdded] = useState<{ connection: ModelConnection; modelId?: string } | null>(
    null,
  );
  const [worked, setWorked] = useState(false);
  const [testing, setTesting] = useState<ModelConnection | null>(null);
  const [replacing, setReplacing] = useState<ModelConnection | null>(null);
  const existing = (connections.data?.items ?? []).filter((c) => c.status === 'active');
  const serverKey = hasServerKey(status.data) === true;
  const last = new Map((status.data?.tests ?? []).map((test) => [test.connectionId, test]));

  if (!can('integrations.manage')) {
    return (
      <p className="text-sm text-text-secondary" data-testid="aikey-no-permission">
        {t('setup.onboarding.aikey.noPermission')}
      </p>
    );
  }

  const report = (result: ModelProbeResult) => setWorked(result.ok);

  return (
    <div className="flex flex-col gap-5" data-testid="onboarding-aikey">
      {serverKey ? (
        <p
          className="rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text"
          data-testid="aikey-server-key"
        >
          {t('setup.onboarding.aikey.serverKey')}
        </p>
      ) : null}
      {added ? (
        <div className="flex flex-col gap-4">
          <AddedBanner
            key={added.connection.id}
            connection={added.connection}
            modelId={added.modelId}
            onReplace={setReplacing}
            onResult={report}
          />
          {worked ? (
            <div>
              <Button type="button" onClick={() => void onDone()}>
                {t('setup.onboarding.continue')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : existing.length > 0 ? (
        <div className="flex flex-col gap-4" data-testid="aikey-existing">
          <p className="text-sm text-text">{t('setup.onboarding.aikey.have')}</p>
          <ul className="flex flex-col gap-2">
            {existing.map((connection) => {
              const test = last.get(connection.id);
              return (
                <li
                  key={connection.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
                >
                  <span className="flex min-w-0 flex-col">
                    <bdi className="font-medium text-text">{connection.label}</bdi>
                    <span className="text-text-secondary">
                      {t(`editor.providers.${connection.provider}`)} ·{' '}
                      {t('models.keyEnding', { hint: connection.keyHint })}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {test ? (
                      <StatusBadge tone={test.ok ? 'success' : 'danger'}>
                        {test.ok
                          ? t('setup.models.lastTest.ok')
                          : t(`setup.models.probe.${test.kind}.title`)}
                      </StatusBadge>
                    ) : null}
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setTesting(connection)}
                    >
                      {t('setup.models.test')}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => void onDone()}>
              {t('setup.onboarding.continue')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="max-w-xl">
          <AddConnectionForm
            onAdded={(connection, modelId) =>
              setAdded({ connection, ...(modelId ? { modelId } : {}) })
            }
          />
        </div>
      )}
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
        onResult={report}
      />
    </div>
  );
}
