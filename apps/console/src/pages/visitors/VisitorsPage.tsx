import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  BanIcon,
  ExternalLinkIcon,
  MessageSquarePlusIcon,
  UsersIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BlockVisitorDialog } from '../../components/BlockVisitorDialog';
import { SelectField } from '../../components/Fields';
import { PageHeader } from '../../components/PageHeader';
import { Forbidden, QueryState } from '../../components/States';
import type { BlockTarget } from '../../lib/blocks';
import { formatNumber } from '../../lib/format';
import { useBrandRefs } from '../../lib/names';
import { useTenant } from '../../lib/tenant';
import {
  countryName,
  deviceLine,
  formatSpan,
  type LiveVisitor,
  pathOf,
  useLiveVisitors,
} from '../../lib/visitors';
import { timeOfDay } from '../inbox/parts';
import { InviteDialog } from './InviteDialog';
import { VisitorSettingsPanel } from './VisitorSettings';

/** How long this visit has lasted, as the list sees it (up to the moment it was made). */
export function timeOnSite(visitor: LiveVisitor, generatedAt: string): number {
  return Math.max(0, Math.round((Date.parse(generatedAt) - Date.parse(visitor.startedAt)) / 1000));
}

function VisitorRow({
  visitor,
  generatedAt,
  locale,
  onInvite,
  onBlock,
}: {
  visitor: LiveVisitor;
  generatedAt: string;
  locale: string;
  onInvite: (visitor: LiveVisitor) => void;
  /** Null when this person may not block visitors. */
  onBlock: ((visitor: LiveVisitor) => void) | null;
}) {
  const { t } = useTranslation();
  const span = formatSpan(timeOnSite(visitor, generatedAt), locale);
  const country = countryName(visitor.country, locale);
  return (
    <TableRow data-testid="visitor-row" data-returning={visitor.returning ? 'true' : undefined}>
      <TableCell className="min-w-36">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-text">
            <bdi>{visitor.name}</bdi>
          </span>
          <span className="text-xs text-text-secondary">
            <bdi>{visitor.brand.name}</bdi>
          </span>
        </div>
      </TableCell>
      <TableCell className="max-w-64 min-w-40">
        <a
          href={visitor.page.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 flex-col rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex min-w-0 items-center gap-1 text-text">
            <bdi className="truncate">{visitor.page.title?.trim() || pathOf(visitor.page.url)}</bdi>
            <ExternalLinkIcon className="size-3 shrink-0 text-text-muted" aria-hidden="true" />
          </span>
          <span dir="ltr" className="truncate text-xs text-text-secondary">
            {pathOf(visitor.page.url)}
          </span>
        </a>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {span ?? t('inboxAlerts.visitor.underMinute')}
      </TableCell>
      <TableCell>{country ?? '—'}</TableCell>
      <TableCell className="min-w-32">
        <bdi>
          {deviceLine(visitor.device, t(`inboxAlerts.visitor.types.${visitor.device.type}`))}
        </bdi>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {visitor.returning ? (
          <StatusBadge tone="info" icon={null}>
            {t('inboxAlerts.live.returning', { number: formatNumber(visitor.visitCount) })}
          </StatusBadge>
        ) : (
          <StatusBadge tone="neutral" icon={null}>
            {t('inboxAlerts.live.new')}
          </StatusBadge>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-2">
          {visitor.conversationId ? (
            <Button asChild variant="secondary" size="sm">
              <Link
                to="/inbox/$conversationId"
                params={{ conversationId: visitor.conversationId }}
                search={{}}
                aria-label={t('inboxAlerts.live.openChatFor', { name: visitor.name })}
              >
                {t('inboxAlerts.live.openChat')}
              </Link>
            </Button>
          ) : visitor.canInvite ? (
            <Button
              variant="secondary"
              size="sm"
              aria-label={t('inboxAlerts.live.inviteFor', { name: visitor.name })}
              onClick={() => onInvite(visitor)}
              data-testid="invite-visitor"
            >
              <MessageSquarePlusIcon aria-hidden="true" />
              {t('inboxAlerts.live.invite')}
            </Button>
          ) : null}
          {onBlock ? (
            <Button
              variant="secondary"
              size="sm"
              aria-label={t('inbox.blocking.actionFor', { name: visitor.name })}
              onClick={() => onBlock(visitor)}
              data-testid="block-visitor"
            >
              <BanIcon aria-hidden="true" />
              {t('inbox.blocking.action')}
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * Who is on the websites of the brands this person can see right now: the page, how long, from
 * where, on what, and whether they have been here before. A visitor can be invited to chat: the
 * invitation shows next to the chat button on the page they are viewing, like a proactive prompt.
 */
export function VisitorsPage() {
  const { t, i18n } = useTranslation();
  const { can } = useTenant();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const permitted = can('conversations.read');
  const [brandId, setBrandId] = useState('');
  const [inviting, setInviting] = useState<LiveVisitor | null>(null);
  const [blocking, setBlocking] = useState<BlockTarget | null>(null);
  const canBlock = can('visitors.block');
  const brands = useBrandRefs();
  const live = useLiveVisitors(brandId);

  const brandOptions = useMemo(() => {
    const known = new Map<string, string>();
    for (const brand of brands.items ?? []) known.set(brand.id, brand.name);
    for (const visitor of live.data?.items ?? []) known.set(visitor.brand.id, visitor.brand.name);
    return [...known].map(([value, label]) => ({ value, label }));
  }, [brands.items, live.data]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('inboxAlerts.live.title')}
        description={t('inboxAlerts.live.description')}
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link to="/inbox" search={{}}>
              <ArrowLeftIcon className="rtl:-scale-x-100" aria-hidden="true" />
              {t('inboxAlerts.live.back')}
            </Link>
          </Button>
        }
      />
      {permitted ? (
        <>
          {brandOptions.length > 1 ? (
            <div className="max-w-xs">
              <SelectField
                id="live-brand"
                label={t('inboxAlerts.live.brand')}
                value={brandId}
                onChange={(event) => setBrandId(event.target.value)}
                options={[{ value: '', label: t('inboxAlerts.live.allBrands') }, ...brandOptions]}
              />
            </div>
          ) : null}
          <QueryState
            query={live}
            label={t('inboxAlerts.live.loading')}
            isEmpty={(data) => data.items.length === 0}
            empty={
              <EmptyState
                kind="no-records"
                title={t('inboxAlerts.live.empty.title')}
                description={t('inboxAlerts.live.empty.description')}
                icon={<UsersIcon className="size-6 text-text-muted" aria-hidden="true" />}
                action={
                  <Button asChild variant="secondary">
                    <Link to="/inbox" search={{}}>
                      {t('inboxAlerts.live.back')}
                    </Link>
                  </Button>
                }
              />
            }
          >
            {(data) => (
              <div className="flex flex-col gap-3">
                <p
                  role="status"
                  className="flex flex-wrap items-baseline gap-x-3 text-sm text-text-secondary"
                >
                  <span className="font-medium text-text" data-testid="visitor-count">
                    {t('inboxAlerts.live.summary', { number: formatNumber(data.items.length) })}
                  </span>
                  <span>
                    {t('inboxAlerts.live.updated', { time: timeOfDay(data.generatedAt) })}
                  </span>
                </p>
                <div className="rounded-xl border border-border bg-surface shadow-sm">
                  <Table data-testid="visitors-table">
                    <TableCaption className="sr-only">{t('inboxAlerts.live.table')}</TableCaption>
                    <TableHeader>
                      <TableRow>
                        {(['visitor', 'page', 'time', 'country', 'device', 'visits'] as const).map(
                          (column) => (
                            <TableHead key={column} className="text-start">
                              {t(`inboxAlerts.live.columns.${column}`)}
                            </TableHead>
                          ),
                        )}
                        <TableHead className="text-start">
                          {t('inboxAlerts.live.columns.actions')}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.items.map((visitor) => (
                        <VisitorRow
                          key={visitor.id}
                          visitor={visitor}
                          generatedAt={data.generatedAt}
                          locale={locale}
                          onInvite={setInviting}
                          onBlock={
                            canBlock
                              ? (row) =>
                                  setBlocking({
                                    kind: 'visitor',
                                    visitorId: row.id,
                                    name: row.name,
                                  })
                              : null
                          }
                        />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </QueryState>
          <VisitorSettingsPanel />
        </>
      ) : (
        <Forbidden
          title={t('inboxAlerts.live.forbidden.title')}
          description={t('inboxAlerts.live.forbidden.description')}
        />
      )}
      <InviteDialog visitor={inviting} onClose={() => setInviting(null)} />
      <BlockVisitorDialog target={blocking} onClose={() => setBlocking(null)} />
    </div>
  );
}
