import { Spinner } from '@hamnivo/ui/components/spinner';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlertIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { keys } from '../lib/queries';
import { useProvisioning } from '../lib/saas';
import { useTenant } from '../lib/tenant';

/**
 * The automatic Chatwoot set-up of a brand (its workspace's first brand, or one a billing system
 * created): queued, running with its current step, or stopped with the reason. Connect stays
 * available as the retry, and continues where the set-up stopped.
 */
export function ProvisioningProgress({ brandId }: { brandId: string }) {
  const { t } = useTranslation();
  const { tenantId } = useTenant();
  const client = useQueryClient();
  const provisioning = useProvisioning();
  const item = provisioning.data?.items.find((entry) => entry.brandId === brandId);
  const previous = useRef(item?.state);
  useEffect(() => {
    // Finished while the page was open: show the connection it made.
    if (item?.state === 'connected' && previous.current && previous.current !== 'connected') {
      void client.invalidateQueries({ queryKey: [tenantId, ...keys.connections] });
      void client.invalidateQueries({ queryKey: [tenantId, ...keys.agents] });
    }
    previous.current = item?.state;
  }, [item?.state, client, tenantId]);
  if (!item || item.state === 'connected' || item.state === 'not_configured') return null;
  if (item.state === 'failed') {
    return (
      <p
        role="alert"
        className="flex items-start gap-2 text-sm text-text"
        data-testid="provisioning-progress"
        data-state="failed"
      >
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
        {t('billing.provisioning.failed', { error: item.lastError ?? '' })}
      </p>
    );
  }
  return (
    <p
      role="status"
      className="flex items-center gap-2 text-sm text-text"
      data-testid="provisioning-progress"
      data-state={item.state}
    >
      <Spinner className="size-4" aria-hidden="true" />
      {item.state === 'queued'
        ? t('billing.provisioning.queued')
        : t('billing.provisioning.running', {
            step: t(`billing.provisioning.steps.${stepOf(item.step)}`),
          })}
    </p>
  );
}

const STEPS = [
  'account',
  'integration_user',
  'account_user',
  'inbox',
  'bot',
  'bot_attached',
  'webhook',
  'dashboard_app',
  'done',
] as const;

/** The step a running set-up is on: the one after the last completed. */
export function stepOf(done: string | null): (typeof STEPS)[number] {
  const index = done === null ? -1 : STEPS.indexOf(done as (typeof STEPS)[number]);
  return STEPS[Math.min(index + 1, STEPS.length - 1)] ?? 'account';
}
