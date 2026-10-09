import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@hamnivo/ui/components/tabs';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { BarChart3Icon, DownloadIcon, InfoIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField, TextField } from '../../components/Fields';
import { PageHeader, Section } from '../../components/PageHeader';
import { ActionError, Forbidden, QueryState } from '../../components/States';
import { formatAmount } from '../../lib/commerce';
import { formatDate, formatNumber } from '../../lib/format';
import {
  type AnalyticsOverview,
  downloadCsv,
  noTickets,
  type ReportFilters,
  ticketsByPriority,
  ticketsBySource,
  useAnalytics,
} from '../../lib/reports';
import { useTenant } from '../../lib/tenant';
import type { ReportRange, ReportsSearch, ReportsTab } from '../../routes/_studio/reports';
import { BillingTab } from './BillingTab';
import { ConversationsChart } from './ConversationsChart';

const TAB = 'text-text-secondary hover:text-text data-[state=active]:text-text';
/** Why conversations went from the AI to people (the ownership reasons the gateway records). */
const REASONS = [
  'customer_request',
  'ai_unavailable',
  'ai_blocked',
  'ai_limit',
  'ai_stopped',
  'no_agent',
  'assist_mode',
  'channel_ai_off',
  'staff_takeover',
  'staff_reply',
  'staff_assign',
  'staff_release',
  'authority_assignment',
  'authority_handoff',
  'human_reply',
  'return_to_ai',
  'unknown',
] as const;
type Reason = (typeof REASONS)[number];
const isReason = (value: string): value is Reason => (REASONS as readonly string[]).includes(value);
const RANGES: readonly ReportRange[] = ['7d', '30d', '90d', 'custom'];

function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Today's date (YYYY-MM-DD) in a time zone. */
function today(zone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const isDate = (value: string | undefined): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

export function useLocaleFormat() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? 'en';
  return {
    percent: (value: number | null) =>
      value === null
        ? null
        : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
            value,
          ),
    /** Seconds as "45 sec", "6.5 min" or "2.1 hr". */
    seconds: (value: number | null) => {
      if (value === null) return null;
      const [amount, unit] =
        value < 60
          ? [value, 'second']
          : value < 3600
            ? [value / 60, 'minute']
            : [value / 3600, 'hour'];
      return new Intl.NumberFormat(locale, {
        style: 'unit',
        unit,
        unitDisplay: 'short',
        maximumFractionDigits: amount < 10 ? 1 : 0,
      }).format(amount);
    },
    rating: (value: number | null) =>
      value === null
        ? null
        : new Intl.NumberFormat(locale, {
            maximumFractionDigits: 1,
            minimumFractionDigits: 1,
          }).format(value),
  };
}

/** A count as the page writes it, or null (shown as withheld) when too few stand behind it. */
const count = (metric: { value: number | null }) =>
  metric.value === null ? null : formatNumber(metric.value);

/** One headline number with what it stands on; withheld values say why, in neutral text. */
function Tile({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string | null;
  note?: ReactNode;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface p-4"
      data-testid={testId}
    >
      <p className="text-sm text-text-secondary">{label}</p>
      <p className="text-2xl font-semibold text-text">
        {value ?? (
          <span className="text-base font-medium text-text-secondary">
            {t('reports.smallSample')}
          </span>
        )}
      </p>
      {note ? <p className="text-xs text-text-secondary">{note}</p> : null}
    </div>
  );
}

function Filters({
  search,
  overview,
  onChange,
  zone,
}: {
  search: ReportsSearch;
  overview: AnalyticsOverview | undefined;
  onChange: (next: Partial<ReportsSearch>) => void;
  zone: string;
}) {
  const { t } = useTranslation();
  const range = search.range ?? '7d';
  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="report-filters">
      <div className="w-44">
        <SelectField
          id="report-range"
          label={t('reports.filters.range')}
          value={range}
          onChange={(event) =>
            onChange({
              range: event.target.value as ReportRange,
              ...(event.target.value === 'custom'
                ? {
                    from: search.from ?? addDays(today(zone), -6),
                    to: search.to ?? today(zone),
                  }
                : { from: undefined, to: undefined }),
            })
          }
          options={RANGES.map((value) => ({
            value,
            label: t(`reports.filters.ranges.${value}`),
          }))}
        />
      </div>
      {range === 'custom' ? (
        <>
          <div className="w-40">
            <TextField
              id="report-from"
              type="date"
              label={t('reports.filters.from')}
              value={search.from ?? ''}
              max={search.to}
              onChange={(event) => onChange({ from: event.target.value })}
            />
          </div>
          <div className="w-40">
            <TextField
              id="report-to"
              type="date"
              label={t('reports.filters.to')}
              value={search.to ?? ''}
              min={search.from}
              onChange={(event) => onChange({ to: event.target.value })}
            />
          </div>
        </>
      ) : null}
      <div className="w-48">
        <SelectField
          id="report-team"
          label={t('reports.filters.team')}
          value={search.team ?? ''}
          onChange={(event) => onChange({ team: event.target.value || undefined })}
          options={[
            { value: '', label: t('reports.filters.allTeams') },
            ...(overview?.teams ?? [])
              .filter((team) => team.teamId)
              .map((team) => ({
                value: team.teamId as string,
                label: team.name ?? t('reports.teams.unnamed'),
              })),
          ]}
        />
      </div>
      <div className="w-48">
        <SelectField
          id="report-channel"
          label={t('reports.filters.channel')}
          value={search.channelType ?? ''}
          onChange={(event) => onChange({ channelType: event.target.value || undefined })}
          options={[
            { value: '', label: t('reports.filters.allChannels') },
            ...(overview?.channels ?? [])
              .filter((channel) => channel.channel)
              .map((channel) => ({
                value: channel.channel as string,
                label: channel.channel as string,
              })),
          ]}
        />
      </div>
    </div>
  );
}

function QualityTab({ overview }: { overview: AnalyticsOverview }) {
  const { t } = useTranslation();
  const format = useLocaleFormat();
  const totals = overview.totals;
  const quality = overview.quality;
  const k = overview.minimumGroupSize;
  const rateNote = (rate: number | null, sample: number) =>
    rate === null
      ? t('reports.fewer', { count: k })
      : t('reports.rateOf', { rate: format.percent(rate), count: sample });
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          testId="tile-conversations"
          label={t('reports.tiles.conversations')}
          value={formatNumber(totals.conversations.value)}
          note={t('reports.previousValue', { count: totals.conversations.previous })}
        />
        <Tile
          testId="tile-handoffs"
          label={t('reports.tiles.handoffs')}
          value={totals.handedOff.value === null ? null : formatNumber(totals.handedOff.value)}
          note={rateNote(totals.handedOff.rate, totals.handedOff.sample)}
        />
        <Tile
          testId="tile-resolved"
          label={t('reports.tiles.resolved')}
          value={totals.resolved.value === null ? null : formatNumber(totals.resolved.value)}
          note={rateNote(totals.resolved.rate, totals.resolved.sample)}
        />
        <Tile
          testId="tile-feedback"
          label={t('reports.tiles.feedback')}
          value={
            totals.csatAverage.value === null
              ? null
              : t('reports.outOfFive', { value: format.rating(totals.csatAverage.value) })
          }
          note={t('reports.responses', { count: totals.csatAverage.sample })}
        />
        <Tile
          testId="tile-ai-resolved"
          label={t('reports.tiles.aiResolved')}
          value={totals.aiResolved.value === null ? null : formatNumber(totals.aiResolved.value)}
          note={rateNote(totals.aiResolved.rate, totals.aiResolved.sample)}
        />
        <Tile
          testId="tile-first-response"
          label={t('reports.tiles.firstResponse')}
          value={format.seconds(totals.firstResponseMedianSeconds.value)}
          note={t('reports.basedOn', { count: totals.firstResponseMedianSeconds.sample })}
        />
        <Tile
          testId="tile-resolution"
          label={t('reports.tiles.resolution')}
          value={format.seconds(totals.resolutionMedianSeconds.value)}
          note={t('reports.basedOn', { count: totals.resolutionMedianSeconds.sample })}
        />
      </div>
      <Section
        id="went-wrong"
        title={t('reports.quality.title')}
        description={t('reports.quality.description')}
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Tile
            testId="tile-missed"
            label={t('reports.quality.missed')}
            value={count(quality.missed)}
            note={
              quality.missed.rate === null
                ? t('reports.fewer', { count: k })
                : t('reports.quality.missedNote', {
                    rate: format.percent(quality.missed.rate),
                    count: quality.missed.sample,
                  })
            }
          />
          <Tile
            testId="tile-offline-messages"
            label={t('reports.quality.offlineMessages')}
            value={count(quality.offlineMessages)}
            note={t('reports.quality.offlineMessagesNote')}
          />
          <Tile
            testId="tile-reopened"
            label={t('reports.quality.reopened')}
            value={format.percent(quality.reopened.rate)}
            note={
              quality.reopened.rate === null
                ? t('reports.fewer', { count: k })
                : t('reports.quality.reopenedNote', { count: quality.reopened.sample })
            }
          />
        </div>
      </Section>
      <Section id="per-day" title={t('reports.chart.title')}>
        <ConversationsChart
          days={overview.daily}
          previousRange={overview.previousRange}
          minimumGroupSize={k}
        />
      </Section>
      <Section id="handoff-reasons" title={t('reports.reasons.title')}>
        {overview.handoffReasons.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('reports.reasons.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="handoff-reasons">
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-normal">{t('reports.reasons.reason')}</TableHead>
                  <TableHead className="whitespace-normal">{t('reports.reasons.count')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.handoffReasons.map((row) => (
                  <TableRow key={row.reason}>
                    <TableCell className="whitespace-normal">
                      {isReason(row.reason) ? t(`reports.reasons.names.${row.reason}`) : row.reason}
                    </TableCell>
                    <TableCell className="whitespace-normal tabular-nums">
                      {row.count === null ? t('reports.smallSample') : formatNumber(row.count)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
      <Section
        id="commerce"
        title={t('reports.commerce.title')}
        description={t('reports.commerce.description')}
      >
        {overview.commerce.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('reports.commerce.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="commerce-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-normal">
                    {t('reports.commerce.currency')}
                  </TableHead>
                  <TableHead className="whitespace-normal">
                    {t('reports.commerce.orders')}
                  </TableHead>
                  <TableHead className="whitespace-normal">
                    {t('reports.commerce.revenue')}
                  </TableHead>
                  <TableHead className="whitespace-normal">
                    {t('reports.commerce.refunds')}
                  </TableHead>
                  <TableHead className="whitespace-normal">
                    {t('reports.commerce.refunded')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.commerce.map((row) => (
                  <TableRow key={row.currency}>
                    <TableCell className="whitespace-normal">
                      <bdi dir="ltr">{row.currency}</bdi>
                    </TableCell>
                    <TableCell className="whitespace-normal tabular-nums">
                      {row.orders === null ? t('reports.smallSample') : formatNumber(row.orders)}
                    </TableCell>
                    <TableCell className="whitespace-normal tabular-nums">
                      {row.revenueMinor === null
                        ? t('reports.smallSample')
                        : formatAmount(row.revenueMinor, row.currency)}
                    </TableCell>
                    <TableCell className="whitespace-normal tabular-nums">
                      {row.refunds === null ? t('reports.smallSample') : formatNumber(row.refunds)}
                    </TableCell>
                    <TableCell className="whitespace-normal tabular-nums">
                      {row.refundedMinor === null
                        ? t('reports.smallSample')
                        : formatAmount(row.refundedMinor, row.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </div>
  );
}

function TeamsTab({ overview }: { overview: AnalyticsOverview }) {
  const { t } = useTranslation();
  const format = useLocaleFormat();
  const small = t('reports.smallSample');
  return (
    <div className="flex flex-col gap-6">
      <Section
        id="queues"
        title={t('reports.teams.title')}
        description={t('reports.teams.description')}
      >
        <div className="overflow-x-auto">
          <Table data-testid="team-table">
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-normal">{t('reports.teams.team')}</TableHead>
                <TableHead className="whitespace-normal">
                  {t('reports.teams.conversations')}
                </TableHead>
                <TableHead className="whitespace-normal">
                  {t('reports.teams.firstResponse')}
                </TableHead>
                <TableHead className="whitespace-normal">
                  {t('reports.teams.handoffRate')}
                </TableHead>
                <TableHead className="whitespace-normal">{t('reports.teams.feedback')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.teams.map((team) => (
                <TableRow key={team.teamId ?? 'none'}>
                  <TableCell className="whitespace-normal font-medium text-text">
                    <bdi>
                      {team.teamId
                        ? (team.name ?? t('reports.teams.unnamed'))
                        : t('reports.teams.none')}
                    </bdi>
                  </TableCell>
                  <TableCell className="whitespace-normal tabular-nums">
                    {team.conversations === null ? small : formatNumber(team.conversations)}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {format.seconds(team.firstResponseMedianSeconds) ?? small}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {format.percent(team.handoffRate) ?? small}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {team.csatAverage === null
                      ? small
                      : t('reports.outOfFive', { value: format.rating(team.csatAverage) })}
                    <span className="block text-xs text-text-secondary">
                      {t('reports.responses', { count: team.csatResponses })}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>
      <Section id="channels" title={t('reports.channels.title')}>
        <div className="overflow-x-auto">
          <Table data-testid="channel-table">
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-normal">{t('reports.channels.channel')}</TableHead>
                <TableHead className="whitespace-normal">
                  {t('reports.teams.conversations')}
                </TableHead>
                <TableHead className="whitespace-normal">
                  {t('reports.teams.handoffRate')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.channels.map((channel) => (
                <TableRow key={channel.channel ?? 'unknown'}>
                  <TableCell className="whitespace-normal">
                    <bdi dir="ltr">{channel.channel ?? t('reports.channels.unknown')}</bdi>
                  </TableCell>
                  <TableCell className="whitespace-normal tabular-nums">
                    {channel.conversations === null ? small : formatNumber(channel.conversations)}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {format.percent(channel.handoffRate) ?? small}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>
    </div>
  );
}

/** A short table of counts by name, with withheld counts said in words, like the reasons above. */
function CountTable({
  testId,
  head,
  rows,
}: {
  testId: string;
  head: string;
  rows: Array<{ key: string; name: string; count: number | null }>;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return <p className="text-sm text-text-secondary">{t('reports.tickets.emptyList')}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <Table data-testid={testId}>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-normal">{head}</TableHead>
            <TableHead className="whitespace-normal">{t('reports.tickets.count')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key} data-key={row.key}>
              <TableCell className="whitespace-normal">{row.name}</TableCell>
              <TableCell className="whitespace-normal tabular-nums">
                {row.count === null ? t('reports.smallSample') : formatNumber(row.count)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TicketsTab({ overview }: { overview: AnalyticsOverview }) {
  const { t } = useTranslation();
  const format = useLocaleFormat();
  const tickets = overview.tickets;
  // Highest priority first, then tickets with none; sources in a fixed order, always in words.
  const byPriority = ticketsByPriority(tickets).map((row) => ({
    key: row.priority ?? 'none',
    name: t(`reports.tickets.priorities.${row.priority ?? 'none'}`),
    count: row.count,
  }));
  const bySource = ticketsBySource(tickets).map((row) => ({
    key: row.source,
    name: t(`reports.tickets.sources.${row.source}`),
    count: row.count,
  }));
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          testId="tile-tickets-created"
          label={t('reports.tickets.created')}
          value={count(tickets.created)}
          note={t('reports.tickets.createdNote')}
        />
        <Tile
          testId="tile-tickets-closed"
          label={t('reports.tickets.closed')}
          value={count(tickets.closed)}
          note={t('reports.tickets.closedNote')}
        />
        <Tile
          testId="tile-tickets-open"
          label={t('reports.tickets.openNow')}
          value={count(tickets.openNow)}
          note={t('reports.tickets.openNowNote')}
        />
        <Tile
          testId="tile-tickets-close-time"
          label={t('reports.tickets.closeMedian')}
          value={format.seconds(tickets.closeMedianSeconds.value)}
          note={t('reports.basedOn', { count: tickets.closeMedianSeconds.sample })}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section id="tickets-by-priority" title={t('reports.tickets.byPriority')}>
          <CountTable
            testId="tickets-by-priority"
            head={t('reports.tickets.priority')}
            rows={byPriority}
          />
        </Section>
        <Section id="tickets-by-source" title={t('reports.tickets.bySource')}>
          <CountTable
            testId="tickets-by-source"
            head={t('reports.tickets.source')}
            rows={bySource}
          />
        </Section>
      </div>
    </div>
  );
}

function AiTab({ overview }: { overview: AnalyticsOverview }) {
  const { t } = useTranslation();
  const format = useLocaleFormat();
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          testId="tile-ai-replies"
          label={t('reports.ai.replies')}
          value={formatNumber(overview.ai.replies)}
        />
        <Tile
          testId="tile-ai-tokens"
          label={t('reports.ai.tokens')}
          value={formatNumber(overview.ai.tokensInput + overview.ai.tokensOutput)}
          note={t('reports.ai.tokensSplit', {
            input: formatNumber(overview.ai.tokensInput),
            output: formatNumber(overview.ai.tokensOutput),
          })}
        />
        <Tile
          testId="tile-ai-limit"
          label={t('reports.ai.limitHandoffs')}
          value={
            overview.ai.limitHandoffs === null ? null : formatNumber(overview.ai.limitHandoffs)
          }
          note={t('reports.ai.limitHandoffsNote')}
        />
        <Tile
          testId="tile-cache"
          label={t('reports.ai.cache')}
          value={
            overview.cache.status === 'not_measured'
              ? t('reports.ai.notMeasured')
              : format.percent(overview.cache.hitRate)
          }
          note={
            overview.cache.status === 'not_measured'
              ? t('reports.ai.notMeasuredNote')
              : t('reports.ai.cacheNote')
          }
        />
      </div>
    </div>
  );
}

/** Reports (O04, board 23): service quality, teams, tickets, AI use and billing, aggregates only. */
export function ReportsPage() {
  const { t } = useTranslation();
  const { can, tenantId } = useTenant();
  const announce = useAnnouncer();
  const search = useSearch({ from: '/_studio/reports' });
  const navigate = useNavigate({ from: '/reports' });
  const zone = timeZone();
  const range = search.range ?? '7d';
  const end = range === 'custom' && isDate(search.to) ? search.to : today(zone);
  const start =
    range === 'custom' && isDate(search.from)
      ? search.from
      : addDays(end, -(Number.parseInt(range === 'custom' ? '7' : range, 10) - 1));
  const filters: ReportFilters = {
    from: start,
    to: end,
    timezone: zone,
    teamId: search.team,
    channel: search.channelType,
  };
  const analytics = useAnalytics(filters);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);
  const visible: Record<ReportsTab, boolean> = {
    quality: can('analytics.read'),
    teams: can('analytics.read'),
    tickets: can('analytics.read'),
    ai: can('analytics.read'),
    billing: can('billing.read'),
  };
  const tabs = (Object.keys(visible) as ReportsTab[]).filter((tab) => visible[tab]);
  const tab: ReportsTab = search.tab && visible[search.tab] ? search.tab : (tabs[0] ?? 'quality');
  const go = (next: Partial<ReportsSearch>) =>
    void navigate({
      search: (current) =>
        Object.fromEntries(
          Object.entries({ ...current, ...next }).filter(
            ([, value]) => value !== undefined && value !== '',
          ),
        ) as ReportsSearch,
      replace: true,
    });
  const overview = analytics.data;
  const empty =
    overview !== undefined &&
    overview.totals.conversations.value === 0 &&
    overview.totals.conversations.previous === 0;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('reports.title')}
        description={t('reports.description')}
        actions={
          can('analytics.read') && tab !== 'billing' ? (
            <Button
              variant="secondary"
              busy={exporting}
              data-testid="export-csv"
              onClick={async () => {
                setExporting(true);
                setExportError(null);
                try {
                  await downloadCsv(filters, tenantId);
                  announce(t('reports.exported'));
                } catch (error) {
                  setExportError(error);
                } finally {
                  setExporting(false);
                }
              }}
            >
              <DownloadIcon aria-hidden="true" />
              {t('reports.export')}
            </Button>
          ) : null
        }
      />
      <ActionError error={exportError} />
      {tabs.length === 0 ? (
        <Forbidden />
      ) : (
        <Tabs value={tab} onValueChange={(value) => go({ tab: value as ReportsTab })}>
          <TabsList variant="line" className="h-auto flex-wrap justify-start">
            {tabs.map((value) => (
              <TabsTrigger key={value} value={value} className={TAB} data-testid={`tab-${value}`}>
                {t(`reports.tabs.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          {tab !== 'billing' ? (
            <div className="flex flex-col gap-4 pt-4">
              <Filters search={search} overview={overview} onChange={go} zone={zone} />
              <p className="text-sm text-text-secondary" data-testid="report-range">
                {t('reports.rangeNote', {
                  from: formatDate(`${start}T12:00:00Z`),
                  to: formatDate(`${end}T12:00:00Z`),
                  zone,
                })}
              </p>
              {overview?.partial ? (
                <p className="flex items-start gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text">
                  <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {overview.recordingSince
                    ? t('reports.partialSince', { date: formatDate(overview.recordingSince) })
                    : t('reports.partial')}
                </p>
              ) : null}
              <p className="text-xs text-text-secondary">
                {t('reports.privacy', { count: overview?.minimumGroupSize ?? 5 })}
              </p>
            </div>
          ) : null}
          {(['quality', 'teams', 'tickets', 'ai'] as const).map((value) => (
            <TabsContent key={value} value={value} className="pt-4">
              <QueryState
                query={analytics}
                label={t('reports.loading')}
                permitted={can('analytics.read')}
                isEmpty={(data) => (value === 'tickets' ? noTickets(data) : empty)}
                empty={
                  <div
                    className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-8 text-center"
                    data-testid="report-empty"
                  >
                    <BarChart3Icon className="size-6 text-text-muted" aria-hidden="true" />
                    <p className="font-medium text-text">
                      {value === 'tickets'
                        ? t('reports.tickets.empty.title')
                        : t('reports.empty.title')}
                    </p>
                    <p className="text-sm text-text-secondary">
                      {value === 'tickets'
                        ? t('reports.tickets.empty.description')
                        : t('reports.empty.description')}
                    </p>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        go({
                          range: undefined,
                          from: undefined,
                          to: undefined,
                          team: undefined,
                          channelType: undefined,
                        })
                      }
                    >
                      {t('reports.empty.reset')}
                    </Button>
                  </div>
                }
              >
                {(data) =>
                  value === 'quality' ? (
                    <QualityTab overview={data} />
                  ) : value === 'teams' ? (
                    <TeamsTab overview={data} />
                  ) : value === 'tickets' ? (
                    <TicketsTab overview={data} />
                  ) : (
                    <AiTab overview={data} />
                  )
                }
              </QueryState>
            </TabsContent>
          ))}
          <TabsContent value="billing" className="pt-4">
            <BillingTab />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
