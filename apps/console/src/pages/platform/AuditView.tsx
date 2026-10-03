import { Button } from '@hamnivo/ui/components/button';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { useTranslation } from 'react-i18next';
import { ErrorPanel, ListSkeleton } from '../../components/States';
import { auditActionLabel } from '../../lib/access-text';
import { formatDateTime } from '../../lib/format';
import { usePlatformAudit } from '../../lib/platform';

/** The platform's own audit log (A17): operator actions and workspace decisions on access. */
export function AuditView() {
  const { t } = useTranslation();
  const log = usePlatformAudit(true);
  const items = log.data?.pages.flatMap((page) => page.items) ?? [];
  if (log.isPending) {
    return (
      <div role="status" aria-busy="true" aria-label={t('platform.audit.loading')}>
        <ListSkeleton rows={4} />
      </div>
    );
  }
  if (log.isError && items.length === 0) {
    return (
      <ErrorPanel error={log.error} onRetry={() => log.refetch()} retrying={log.isRefetching} />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-sm text-text-secondary">{t('platform.audit.intro')}</p>
      {items.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('platform.audit.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
          <Table data-testid="platform-audit">
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{t('access.audit.columns.time')}</TableHead>
                <TableHead className="text-start">{t('platform.audit.operator')}</TableHead>
                <TableHead className="text-start">{t('access.audit.columns.action')}</TableHead>
                <TableHead className="text-start">{t('platform.audit.tenant')}</TableHead>
                <TableHead className="text-start">{t('access.audit.columns.outcome')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((event) => (
                <TableRow key={event.seq} data-action={event.action}>
                  <TableCell>{formatDateTime(event.occurredAt)}</TableCell>
                  <TableCell>
                    {event.operator ? (
                      <bdi>{event.operator.name}</bdi>
                    ) : (
                      <span className="text-text-secondary">
                        {t('platform.audit.workspaceDecision')}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-col">
                      <span>{auditActionLabel(t, event.action)}</span>
                      <code dir="ltr" className="text-xs text-text-secondary">
                        {event.action}
                      </code>
                    </span>
                  </TableCell>
                  <TableCell>{event.tenant ? <bdi>{event.tenant.name}</bdi> : '—'}</TableCell>
                  <TableCell>
                    <StatusBadge tone={event.outcome === 'success' ? 'success' : 'warning'}>
                      {t(`access.audit.outcomes.${event.outcome}`)}
                    </StatusBadge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {log.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-start"
          busy={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {t('platform.audit.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
