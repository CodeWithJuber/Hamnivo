import { Button } from '@hamnivo/ui/components/button';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import type { TFunction } from 'i18next';
import { DownloadIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatNumber } from '../../lib/format';
import {
  downloadExport,
  type PrivacyRequest,
  useCustomerDataAccess,
  usePrivacyRequests,
} from '../../lib/privacy';
import { isCancelled, withReauth } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import { Section } from '../PageHeader';
import { ActionError, QueryState } from '../States';

const TONES: Record<PrivacyRequest['state'], StatusTone> = {
  queued: 'neutral',
  running: 'info',
  completed: 'success',
  blocked: 'warning',
  failed: 'danger',
};

/** Exports and erasures asked for (A10), with each export's file while it can be downloaded. */
export function PrivacyRequests() {
  const { t } = useTranslation();
  const requests = usePrivacyRequests();
  return (
    <Section
      id="privacy-requests"
      title={t('privacy.requests.title')}
      description={t('privacy.requests.description')}
    >
      <QueryState query={requests} label={t('privacy.requests.loading')}>
        {(data) =>
          data.items.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('privacy.requests.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label={t('privacy.requests.title')}>
              {data.items.map((request) => (
                <RequestRow key={request.id} request={request} />
              ))}
            </ul>
          )
        }
      </QueryState>
    </Section>
  );
}

function outcome(t: TFunction, request: PrivacyRequest): string | null {
  const n = (key: string) => formatNumber(request.counts[key] ?? 0);
  if (request.state === 'blocked') return t('privacy.requests.blocked');
  if (request.state === 'failed') return t('privacy.requests.failed');
  if (request.state !== 'completed') return null;
  if (request.kind === 'export') {
    return t('privacy.requests.exported', { conversations: n('conversations'), files: n('files') });
  }
  const conversations = Math.max(
    request.counts.conversations ?? 0,
    request.counts.chatwootConversations ?? 0,
  );
  return t('privacy.requests.erasedCounts', {
    conversations: formatNumber(conversations),
    contacts: n('chatwootContacts'),
  });
}

function RequestRow({ request }: { request: PrivacyRequest }) {
  const { t } = useTranslation();
  const { tenantId } = useTenant();
  const access = useCustomerDataAccess();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      await withReauth(() => downloadExport(request.id, tenantId));
    } catch (caught) {
      if (!isCancelled(caught)) setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const result = outcome(t, request);
  return (
    <li
      data-testid="privacy-request"
      data-state={request.state}
      className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-medium text-text">
            {t(`privacy.requests.kind.${request.kind}`)}
          </span>
          <StatusBadge tone={TONES[request.state]}>
            {t(`privacy.requests.state.${request.state}`)}
          </StatusBadge>
        </span>
        <span className="text-text-secondary">{formatDateTime(request.createdAt)}</span>
      </div>
      <p className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-text-secondary">
        <code className="break-all font-mono text-xs text-text">{request.customerId}</code>
        <span>{request.brand.name}</span>
        {request.requestedBy ? (
          <span dir="auto">{t('privacy.requests.by', { name: request.requestedBy.name })}</span>
        ) : null}
        {request.reference ? <span dir="auto">{request.reference}</span> : null}
      </p>
      {result ? <p className="text-text">{result}</p> : null}
      {request.kind === 'export' && request.state === 'completed' ? (
        request.file ? (
          <div className="flex flex-wrap items-center gap-3">
            {access.export ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                busy={busy}
                data-testid="privacy-download"
                onClick={() => void download()}
              >
                <DownloadIcon aria-hidden="true" />
                {t('privacy.requests.download')}
              </Button>
            ) : null}
            <span className="text-text-secondary">
              {t('privacy.requests.until', { date: formatDateTime(request.file.expiresAt) })}
            </span>
          </div>
        ) : (
          <p className="text-text-secondary">{t('privacy.requests.gone')}</p>
        )
      ) : null}
      <ActionError error={error} />
    </li>
  );
}
