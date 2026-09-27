import { EmptyState } from '@hamnivo/ui/components/async-states';
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
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { BrainIcon, SearchIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField, TextField } from '../components/Fields';
import { ConsentBadge, customerName } from '../components/MemoryBadges';
import { PageHeader } from '../components/PageHeader';
import { Forbidden, QueryState } from '../components/States';
import { formatDateTime, formatNumber } from '../lib/format';
import { useBrandRefs, useNames } from '../lib/names';
import { useMemoryCustomers } from '../lib/queries';
import { useTenant } from '../lib/tenant';

/** Customer memory (board 15): customers with memory or a memory choice (HNV-15-02, 15-06). */
export function MemoryPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_studio/memory/' });
  const brands = useBrandRefs();
  const names = useNames();
  const [text, setText] = useState(search.q ?? '');
  const customers = useMemoryCustomers({ query: search.q, brandId: search.brand });
  const permitted = can('memory.read');

  useEffect(() => setText(search.q ?? ''), [search.q]);

  const go = (next: { q?: string | undefined; brand?: string | undefined }) =>
    navigate({
      to: '/memory',
      search: {
        ...(next.q ? { q: next.q } : {}),
        ...(next.brand ? { brand: next.brand } : {}),
      },
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void go({ q: text.trim(), brand: search.brand });
  };

  const brandItems = brands.items ?? [];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('memory.title')} description={t('memory.description')} />
      {permitted ? (
        <search aria-label={t('memory.list.searchLabel')}>
          <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
            <div className="min-w-60 flex-1">
              <TextField
                id="memory-search"
                type="search"
                dir="auto"
                label={t('memory.list.search')}
                hint={t('memory.list.searchHint')}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
            {brandItems.length > 1 ? (
              <div className="min-w-48">
                <SelectField
                  id="memory-brand"
                  label={t('memory.list.brand')}
                  value={search.brand ?? ''}
                  onChange={(event) => void go({ q: search.q, brand: event.target.value })}
                  options={[
                    { value: '', label: t('memory.list.allBrands') },
                    ...brandItems.map((brand) => ({ value: brand.id, label: brand.name })),
                  ]}
                />
              </div>
            ) : null}
            <Button type="submit" variant="secondary" className="mb-7">
              <SearchIcon aria-hidden="true" />
              {t('memory.list.submit')}
            </Button>
          </form>
        </search>
      ) : null}
      <QueryState
        query={customers}
        label={t('memory.list.loading')}
        permitted={permitted}
        forbidden={
          <Forbidden
            title={t('memory.forbidden.title')}
            description={t('memory.forbidden.description')}
          />
        }
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            kind="no-records"
            title={search.q ? t('memory.list.noMatch.title') : t('memory.list.empty.title')}
            description={
              search.q ? t('memory.list.noMatch.description') : t('memory.list.empty.description')
            }
            icon={<BrainIcon className="size-6 text-text-muted" aria-hidden="true" />}
            action={
              can('agents.read') && !search.q ? (
                <Button asChild variant="secondary">
                  <Link to="/agents">{t('memory.list.empty.action')}</Link>
                </Button>
              ) : (
                <span />
              )
            }
          />
        }
      >
        {(data) => (
          <section aria-labelledby="memory-customers-title" className="flex flex-col gap-3">
            <h2 id="memory-customers-title" className="text-lg font-semibold text-text">
              {t('memory.list.title')}
            </h2>
            <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
              <Table data-testid="memory-customers">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-start">
                      {t('memory.list.columns.customer')}
                    </TableHead>
                    <TableHead className="text-start">{t('memory.list.columns.brand')}</TableHead>
                    <TableHead className="text-start">{t('memory.list.columns.choice')}</TableHead>
                    <TableHead className="text-start">
                      {t('memory.list.columns.remembered')}
                    </TableHead>
                    <TableHead className="text-start">{t('memory.list.columns.review')}</TableHead>
                    <TableHead className="text-start">{t('memory.list.columns.changed')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((summary) => (
                    <TableRow key={summary.customer.id} data-customer={summary.customer.id}>
                      <TableCell className="max-w-72 whitespace-normal">
                        <Link
                          to="/memory/$customerId"
                          params={{ customerId: summary.customer.id }}
                          className="font-medium text-link underline-offset-4 hover:underline"
                        >
                          <bdi>{customerName(t, summary.customer)}</bdi>
                        </Link>
                        {summary.customer.email ? (
                          <bdi dir="ltr" className="block truncate text-xs text-text-secondary">
                            {summary.customer.email}
                          </bdi>
                        ) : null}
                        {summary.customer.verified ? (
                          <span className="block text-xs text-text-secondary">
                            {t('memory.customer.verified')}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <bdi>{names.brand(summary.customer.brandId) ?? '—'}</bdi>
                      </TableCell>
                      <TableCell>
                        <ConsentBadge state={summary.consent} />
                      </TableCell>
                      <TableCell>{formatNumber(summary.active)}</TableCell>
                      <TableCell>
                        {summary.pending > 0 ? (
                          <StatusBadge tone="warning">
                            {t('memory.list.toReview', { total: formatNumber(summary.pending) })}
                          </StatusBadge>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {summary.lastChangedAt ? formatDateTime(summary.lastChangedAt) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        )}
      </QueryState>
    </div>
  );
}
