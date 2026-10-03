import { Button } from '@hamnivo/ui/components/button';
import { Spinner } from '@hamnivo/ui/components/spinner';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionBadge } from '../../components/Badges';
import { ActionError } from '../../components/States';
import { api, newIdempotencyKey } from '../../lib/api';
import { keys, useAuthorityConnections, useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import type { AuthorityConnection, Brand } from '../../lib/types';
import { connectionFor } from '../OverviewPage';

/** How often the connection is looked at while it is still being set up, in milliseconds. */
const POLL_MS = 3000;

/**
 * Step 3: the chat engine, which carries a customer's messages to the team. It sets itself up:
 * this step starts the same connection the brand's page offers, shows it coming up and says when
 * it is ready. A person who may not connect it is told who can.
 */
export function EngineStep({
  brand,
  onDone,
}: {
  brand: Brand;
  onDone: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const { can, tenantId } = useTenant();
  const client = useQueryClient();
  const connections = useAuthorityConnections();
  const connection = connectionFor(connections.data?.items, brand.id);
  const mayConnect = can('integrations.manage');
  const idempotencyKey = useRef(newIdempotencyKey());
  const started = useRef<string | null>(null);

  const connect = useStudioMutation(
    (_: undefined, tenant) =>
      api<AuthorityConnection>('/v1/admin/authority/connections', {
        method: 'POST',
        body: { brandId: brand.id },
        tenant,
        idempotencyKey: idempotencyKey.current,
      }),
    [keys.connections, keys.agents],
  );

  // Setting up starts by itself, once for this brand, when the list says it has none yet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once per brand
  useEffect(() => {
    if (!mayConnect || !connections.data || connection) return;
    if (started.current === brand.id) return;
    started.current = brand.id;
    connect.mutate(undefined);
  }, [mayConnect, connections.data, connection, brand.id]);

  // While it is coming up, look again until it is ready.
  const provisioning = connection?.status === 'provisioning';
  useEffect(() => {
    if (!provisioning) return;
    const timer = setInterval(() => {
      void client.invalidateQueries({ queryKey: [tenantId, ...keys.connections] });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [provisioning, client, tenantId]);

  const ready = connection?.status === 'active' || connection?.status === 'degraded';
  const failed = connect.isError && !isCancelled(connect.error);

  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-engine">
      <div className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
        <p className="text-text">{t('brands.chat.engineNote')}</p>
        <p className="text-text">{t('brands.chat.connectIntro')}</p>
        <ul className="list-disc ps-5 text-text">
          <li>{t('brands.chat.connectItem1')}</li>
          <li>{t('brands.chat.connectItem2')}</li>
          <li>{t('brands.chat.connectItem3')}</li>
        </ul>
      </div>
      {!mayConnect ? (
        <p className="text-sm text-text-secondary" data-testid="engine-no-permission">
          {t('brands.chat.noPermission')}
        </p>
      ) : connections.isPending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
          <Spinner aria-hidden="true" role="presentation" />
          {t('setup.onboarding.engine.checking')}
        </p>
      ) : ready ? (
        <div className="flex flex-col gap-3" data-testid="engine-ready">
          <div className="flex flex-wrap items-center gap-2">
            <ConnectionBadge status={connection.status} />
            <span className="text-sm text-text">{t('setup.onboarding.engine.ready')}</span>
          </div>
          <div>
            <Button type="button" onClick={() => void onDone()}>
              {t('setup.onboarding.continue')}
            </Button>
          </div>
        </div>
      ) : connection?.status === 'disabled' ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="engine-disabled">
          <ConnectionBadge status="disabled" />
          <span className="text-sm text-text">{t('setup.onboarding.engine.disabled')}</span>
        </div>
      ) : failed ? (
        <div className="flex flex-col gap-3">
          <ActionError error={connect.error} />
          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                // A new attempt gets its own key, so it is not mistaken for the one that failed.
                idempotencyKey.current = newIdempotencyKey();
                connect.reset();
                started.current = null;
                connect.mutate(undefined);
              }}
            >
              {t('setup.onboarding.engine.retry')}
            </Button>
          </div>
        </div>
      ) : (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-text-secondary"
          data-testid="engine-working"
        >
          <Spinner aria-hidden="true" role="presentation" />
          {t('setup.onboarding.engine.working', { name: brand.name })}
        </p>
      )}
    </div>
  );
}
