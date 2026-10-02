import { Button } from '@hamnivo/ui/components/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField } from '../../components/Fields';
import { Section } from '../../components/PageHeader';
import { QueryState } from '../../components/States';
import { api } from '../../lib/api';
import {
  developerKeys,
  type Page,
  useEventTypes,
  type WebhookEventSummary,
} from '../../lib/developer';
import { formatDateTime, formatNumber } from '../../lib/format';
import { useTenant } from '../../lib/tenant';

/** Events sent to endpoints, newest first, with what happened to their deliveries. */
export function EventLogTab() {
  const { t } = useTranslation();
  const { tenantId, can } = useTenant();
  const types = useEventTypes();
  const [type, setType] = useState('');
  const events = useInfiniteQuery({
    queryKey: [tenantId, ...developerKeys.events(type)],
    queryFn: ({ pageParam, signal }) =>
      api<Page<WebhookEventSummary>>(
        `/v1/admin/webhooks/events?limit=25${type ? `&type=${encodeURIComponent(type)}` : ''}${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''
        }`,
        { tenant: tenantId, signal },
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: can('webhooks.read'),
    meta: { studio: true },
  });
  const query = {
    data: events.data ? events.data.pages.flatMap((page) => page.items) : undefined,
    error: events.error,
    isPending: events.isPending,
    isRefetching: events.isRefetching,
    refetch: events.refetch,
  };
  return (
    <Section
      id="event-log"
      title={t('developer.events.title')}
      description={t('developer.events.description')}
    >
      <div className="max-w-xs">
        <SelectField
          id="event-type-filter"
          label={t('developer.events.filter')}
          value={type}
          onChange={(event) => setType(event.target.value)}
          options={[
            { value: '', label: t('developer.events.allTypes') },
            ...(types.data?.items ?? []).map((item) => ({ value: item.type, label: item.type })),
          ]}
        />
      </div>
      <QueryState
        query={query}
        label={t('developer.events.loading')}
        permitted={can('webhooks.read')}
        isEmpty={(items) => items.length === 0}
        empty={
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">
            {type ? t('developer.events.emptyFiltered') : t('developer.events.empty')}
          </p>
        }
      >
        {(items) => (
          <div className="flex flex-col gap-3">
            <div>
              <Table data-testid="event-log">
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-normal">
                      {t('developer.events.columns.type')}
                    </TableHead>
                    <TableHead className="whitespace-normal">
                      {t('developer.events.columns.occurred')}
                    </TableHead>
                    <TableHead className="whitespace-normal">
                      {t('developer.events.columns.deliveries')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="whitespace-normal">
                        <bdi dir="ltr" className="block font-mono text-xs text-text">
                          {event.type}
                        </bdi>
                        <span className="block text-xs text-text-secondary">
                          <span className="sr-only">{t('developer.events.columns.id')}: </span>
                          <bdi dir="ltr" className="break-all font-mono">
                            {event.id}
                          </bdi>
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {formatDateTime(event.occurredAt)}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {t('developer.events.counts', {
                          succeeded: formatNumber(event.deliveries.succeeded),
                          failed: formatNumber(event.deliveries.failed),
                          pending: formatNumber(event.deliveries.pending),
                        })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {events.hasNextPage ? (
              <div>
                <Button
                  variant="secondary"
                  busy={events.isFetchingNextPage}
                  onClick={() => void events.fetchNextPage()}
                >
                  {t('developer.events.more')}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </QueryState>
    </Section>
  );
}
