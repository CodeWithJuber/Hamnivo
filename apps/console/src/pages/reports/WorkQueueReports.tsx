import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { InfoIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Section } from '../../components/PageHeader';
import { formatDate, formatNumber } from '../../lib/format';
import type { AnalyticsOverview } from '../../lib/reports';
import { CountTable, count, Tile, useLocaleFormat } from './parts';

/** A note above a report, such as how far back it goes. */
function Note({ text, testId }: { text: string; testId: string }) {
  return (
    <p
      className="flex items-start gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text"
      data-testid={testId}
    >
      <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {text}
    </p>
  );
}

/** A table of rows with a count and a share, withheld rows said in words. */
function ShareTable({
  testId,
  heads,
  rows,
}: {
  testId: string;
  heads: [string, string, string];
  rows: Array<{ key: string; name: string; count: number | null; rate: number | null }>;
}) {
  const { t } = useTranslation();
  const format = useLocaleFormat();
  const small = t('reports.smallSample');
  return (
    <div className="overflow-x-auto">
      <Table data-testid={testId}>
        <TableHeader>
          <TableRow>
            {heads.map((head) => (
              <TableHead key={head} className="whitespace-normal">
                {head}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key} data-key={row.key}>
              <TableCell className="whitespace-normal font-medium text-text">
                <bdi>{row.name}</bdi>
              </TableCell>
              <TableCell className="whitespace-normal tabular-nums">
                {row.count === null ? small : formatNumber(row.count)}
              </TableCell>
              <TableCell className="whitespace-normal">
                {row.count === 0 ? '–' : (format.percent(row.rate) ?? small)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Reply-time targets (H12, O04): how often a person replied in time, from the clocks that ended
 * in the range. Clocks that ended without a person's reply are counted apart, never as missed.
 */
export function ReplyTargetsReport({ overview }: { overview: AnalyticsOverview }) {
  const { t } = useTranslation();
  const format = useLocaleFormat();
  const r = overview.replyTargets;
  const k = overview.minimumGroupSize;
  const replies = r.met.sample;
  const days = r.daily.filter((day) => day.replies !== 0);
  return (
    <Section
      id="reply-targets"
      title={t('reports.replyTargets.title')}
      description={t('reports.replyTargets.description')}
    >
      <div className="flex flex-col gap-4" data-testid="reply-targets-report">
        {r.recordingSince ? (
          <p className="text-xs text-text-secondary">
            {t('reports.replyTargets.recordingSince', { date: formatDate(r.recordingSince) })}
          </p>
        ) : (
          <Note text={t('reports.replyTargets.notRecorded')} testId="reply-targets-not-recorded" />
        )}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Tile
            testId="tile-targets-met"
            label={t('reports.replyTargets.met')}
            value={format.percent(r.met.rate)}
            note={
              r.met.rate === null && replies > 0
                ? t('reports.fewer', { count: k })
                : t('reports.replyTargets.metNote', { count: replies })
            }
          />
          <Tile
            testId="tile-targets-missed"
            label={t('reports.replyTargets.missed')}
            value={count(r.missed)}
            note={t('reports.replyTargets.missedNote')}
          />
          <Tile
            testId="tile-first-reply"
            label={t('reports.replyTargets.firstReply')}
            value={
              r.firstReplyMedianMinutes.value === null
                ? null
                : format.seconds(r.firstReplyMedianMinutes.value * 60)
            }
            note={t('reports.replyTargets.firstReplyNote', {
              count: r.firstReplyMedianMinutes.sample,
            })}
          />
          <Tile
            testId="tile-targets-stopped"
            label={t('reports.replyTargets.stopped')}
            value={count(r.stopped)}
            note={t('reports.replyTargets.stoppedNote')}
          />
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-text">
              {t('reports.replyTargets.byPriority')}
            </h3>
            <ShareTable
              testId="reply-targets-by-priority"
              heads={[
                t('reports.tickets.priority'),
                t('reports.replyTargets.replies'),
                t('reports.replyTargets.metShare'),
              ]}
              rows={r.byPriority.map((row) => ({
                key: row.priority,
                name: t(`reports.tickets.priorities.${row.priority}`),
                count: row.replies,
                rate: row.metRate,
              }))}
            />
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-text">{t('reports.replyTargets.byDay')}</h3>
            {days.length === 0 ? (
              <p className="text-sm text-text-secondary">{t('reports.replyTargets.none')}</p>
            ) : (
              <ShareTable
                testId="reply-targets-by-day"
                heads={[
                  t('reports.chart.date'),
                  t('reports.replyTargets.replies'),
                  t('reports.replyTargets.metShare'),
                ]}
                rows={days.map((day) => ({
                  key: day.date,
                  name: formatDate(`${day.date}T12:00:00Z`),
                  count: day.replies,
                  rate: day.metRate,
                }))}
              />
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

/**
 * Chats offered to one person at a time (HNV-10-03, HNV-10-06): accepted, declined or run out,
 * why people declined, the hand-offs nobody took, and each team's share accepted.
 */
export function OffersReport({ overview }: { overview: AnalyticsOverview }) {
  const { t } = useTranslation();
  const format = useLocaleFormat();
  const offers = overview.offers;
  const k = overview.minimumGroupSize;
  const share = (metric: { rate: number | null; sample: number; value: number | null }) =>
    metric.rate === null && metric.value !== 0
      ? t('reports.fewer', { count: k })
      : t('reports.rateOf', { rate: format.percent(metric.rate ?? 0), count: metric.sample });
  return (
    <Section
      id="offers-report"
      title={t('reports.offers.title')}
      description={t('reports.offers.description')}
    >
      <div className="flex flex-col gap-4" data-testid="offers-report">
        {offers.windowLimited ? (
          <Note text={t('reports.offers.windowLimited')} testId="offers-window-limited" />
        ) : null}
        {offers.offered.value === 0 ? (
          <p className="text-sm text-text-secondary">{t('reports.offers.none')}</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Tile
                testId="tile-offers-accepted"
                label={t('reports.offers.accepted')}
                value={format.percent(offers.accepted.rate)}
                note={
                  offers.accepted.rate === null && offers.accepted.value !== 0
                    ? t('reports.fewer', { count: k })
                    : t('reports.offers.acceptedNote', { count: offers.accepted.sample })
                }
              />
              <Tile
                testId="tile-offers-declined"
                label={t('reports.offers.declined')}
                value={count(offers.declined)}
                note={share(offers.declined)}
              />
              <Tile
                testId="tile-offers-expired"
                label={t('reports.offers.expired')}
                value={count(offers.expired)}
                note={share(offers.expired)}
              />
              <Tile
                testId="tile-offers-accept-time"
                label={t('reports.offers.acceptTime')}
                value={format.seconds(offers.acceptMedianSeconds.value)}
                note={t('reports.offers.acceptTimeNote', {
                  count: offers.acceptMedianSeconds.sample,
                })}
              />
              <Tile
                testId="tile-offers-left"
                label={t('reports.offers.leftInQueue')}
                value={count(offers.leftInQueue)}
                note={t('reports.offers.leftInQueueNote', { count: offers.leftInQueue.sample })}
              />
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-text">
                  {t('reports.offers.declineReasons')}
                </h3>
                <CountTable
                  testId="offers-decline-reasons"
                  head={t('reports.offers.reason')}
                  countHead={t('reports.offers.declinedCount')}
                  empty={t('reports.offers.noDeclines')}
                  rows={offers.declineReasons.map((row) => ({
                    key: row.reason,
                    name: t(`reports.offers.reasons.${row.reason}`),
                    count: row.count,
                  }))}
                />
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-text">{t('reports.offers.byTeam')}</h3>
                <ShareTable
                  testId="offers-by-team"
                  heads={[
                    t('reports.teams.team'),
                    t('reports.offers.offered'),
                    t('reports.offers.accepted'),
                  ]}
                  rows={offers.byTeam.map((row) => ({
                    key: row.teamId,
                    name: row.name,
                    count: row.offered,
                    rate: row.acceptRate,
                  }))}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

/**
 * AI drafts for review (HNV-09-05, G03): how many were sent as written or edited, rejected and
 * why, set aside and why, per AI agent.
 */
export function AiDraftsReport({ overview }: { overview: AnalyticsOverview }) {
  const { t } = useTranslation();
  const format = useLocaleFormat();
  const drafts = overview.aiDrafts;
  const k = overview.minimumGroupSize;
  const share = (metric: { rate: number | null; sample: number; value: number | null }) =>
    metric.rate === null && metric.value !== 0
      ? t('reports.fewer', { count: k })
      : t('reports.rateOf', { rate: format.percent(metric.rate ?? 0), count: metric.sample });
  return (
    <Section
      id="ai-drafts-report"
      title={t('reports.aiDrafts.title')}
      description={t('reports.aiDrafts.description')}
    >
      <div className="flex flex-col gap-4" data-testid="ai-drafts-report">
        {drafts.windowLimited ? (
          <Note text={t('reports.aiDrafts.windowLimited')} testId="ai-drafts-window-limited" />
        ) : null}
        {drafts.written.value === 0 ? (
          <p className="text-sm text-text-secondary">{t('reports.aiDrafts.none')}</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Tile
                testId="tile-drafts-sent"
                label={t('reports.aiDrafts.sent')}
                value={format.percent(drafts.sent.rate)}
                note={
                  drafts.sent.rate === null && drafts.sent.value !== 0
                    ? t('reports.fewer', { count: k })
                    : t('reports.aiDrafts.sentNote', { count: drafts.sent.sample })
                }
              />
              <Tile
                testId="tile-drafts-edited"
                label={t('reports.aiDrafts.edited')}
                value={count(drafts.edited)}
                note={share(drafts.edited)}
              />
              <Tile
                testId="tile-drafts-rejected"
                label={t('reports.aiDrafts.rejected')}
                value={count(drafts.rejected)}
                note={share(drafts.rejected)}
              />
              <Tile
                testId="tile-drafts-set-aside"
                label={t('reports.aiDrafts.setAside')}
                value={count(drafts.setAside)}
                note={t('reports.aiDrafts.setAsideNote', { count: drafts.written.sample })}
              />
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-text">
                  {t('reports.aiDrafts.rejectReasons')}
                </h3>
                <CountTable
                  testId="drafts-reject-reasons"
                  head={t('reports.aiDrafts.reason')}
                  countHead={t('reports.aiDrafts.drafts')}
                  empty={t('reports.aiDrafts.noRejects')}
                  rows={drafts.rejectReasons.map((row) => ({
                    key: row.reason,
                    name: t(`reports.aiDrafts.rejectNames.${row.reason}`),
                    count: row.count,
                  }))}
                />
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-text">
                  {t('reports.aiDrafts.setAsideReasons')}
                </h3>
                <CountTable
                  testId="drafts-set-aside-reasons"
                  head={t('reports.aiDrafts.reason')}
                  countHead={t('reports.aiDrafts.drafts')}
                  empty={t('reports.aiDrafts.noSetAside')}
                  rows={drafts.setAsideReasons.map((row) => ({
                    key: row.reason,
                    name: t(`reports.aiDrafts.setAsideNames.${row.reason}`),
                    count: row.count,
                  }))}
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-text">{t('reports.aiDrafts.byAgent')}</h3>
              <ShareTable
                testId="drafts-by-agent"
                heads={[
                  t('reports.aiDrafts.agent'),
                  t('reports.aiDrafts.drafts'),
                  t('reports.aiDrafts.sent'),
                ]}
                rows={drafts.byAgent.map((row) => ({
                  key: row.agentId ?? 'none',
                  name: row.name ?? t('reports.aiDrafts.unknownAgent'),
                  count: row.written,
                  rate: row.sentRate,
                }))}
              />
            </div>
          </>
        )}
      </div>
    </Section>
  );
}
