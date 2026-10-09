import type { AnalyticsOverview, AnalyticsQuery } from '@hamnivo/contracts';
import { type Db, fromPublicId, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import { protectBreakdown, protectCount, protectedRate } from '@hamnivo/domain/analytics';
import { grantsPermission, isGrantActive, type Principal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

type Query = z.output<typeof AnalyticsQuery>;
type Overview = AnalyticsOverview;

const DAY = 86_400_000;
const MAX_DAYS = 366;

/** Where an actor's `analytics.read` grants reach (a tenant grant reaches everything). */
export interface AnalyticsScope {
  all: boolean;
  workspaceIds: string[];
  brandIds: string[];
  inboxIds: string[];
  teamIds: string[];
}

export function analyticsScope(principal: Principal, now: Date): AnalyticsScope | null {
  const scope: AnalyticsScope = {
    all: false,
    workspaceIds: [],
    brandIds: [],
    inboxIds: [],
    teamIds: [],
  };
  if (principal.status !== 'active') return null;
  for (const grant of principal.grants) {
    if (!isGrantActive(grant, now) || !grantsPermission(grant, 'analytics.read')) continue;
    switch (grant.scope.type) {
      case 'tenant':
        scope.all = true;
        break;
      case 'workspace':
        scope.workspaceIds.push(grant.scope.id);
        break;
      case 'brand':
        scope.brandIds.push(grant.scope.id);
        break;
      case 'inbox':
        scope.inboxIds.push(grant.scope.id);
        break;
      case 'team':
        scope.teamIds.push(grant.scope.id);
        break;
    }
  }
  const some =
    scope.workspaceIds.length +
    scope.brandIds.length +
    scope.inboxIds.length +
    scope.teamIds.length;
  return scope.all || some > 0 ? scope : null;
}

const uuidList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/**
 * The scope and filter condition over a conversation relation aliased `m` (brand_id, inbox_id),
 * joined with `b` (brands) and `s` (conversation_inbox_state), plus the channel expression.
 */
function conditions(scope: AnalyticsScope, filters: Filters, channel: SQL): SQL {
  // Chats an owner opened from Studio to try the widget are not part of the business.
  const parts: SQL[] = [
    sql`not exists (select 1 from test_conversations tc where tc.tenant_id = m.tenant_id and tc.conversation_id = m.id)`,
  ];
  if (!scope.all) {
    const any: SQL[] = [];
    if (scope.workspaceIds.length)
      any.push(sql`b.workspace_id in (${uuidList(scope.workspaceIds)})`);
    if (scope.brandIds.length) any.push(sql`m.brand_id in (${uuidList(scope.brandIds)})`);
    if (scope.inboxIds.length) any.push(sql`m.inbox_id in (${uuidList(scope.inboxIds)})`);
    if (scope.teamIds.length) any.push(sql`s.team_id in (${uuidList(scope.teamIds)})`);
    parts.push(sql`(${sql.join(any, sql` or `)})`);
  }
  if (filters.brandId) parts.push(sql`m.brand_id = ${filters.brandId}::uuid`);
  if (filters.teamId) parts.push(sql`s.team_id = ${filters.teamId}::uuid`);
  if (filters.channel) parts.push(sql`${channel} = ${filters.channel}`);
  return parts.length ? sql.join(parts, sql` and `) : sql`true`;
}

interface Filters {
  brandId: string | null;
  teamId: string | null;
  channel: string | null;
}

interface Range {
  from: string;
  to: string;
  days: number;
  start: Date;
  end: Date;
  previous: { from: string; to: string; start: Date; end: Date };
}

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const round = (value: number | null, digits = 4) =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * A share, withheld when its numerator is a small group: with the denominator shown, a rate would
 * give the withheld count away.
 */
function heldRate(numerator: number, denominator: number, k: number): number | null {
  return protectCount(numerator, k) === null ? null : protectedRate(numerator, denominator, k);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return isoDate(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY));
}

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A CSV cell: quoted, and never read as a formula by a spreadsheet. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text))) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Product analytics (O04): service quality, AI resolution and handoffs, commerce and cache use,
 * for the conversations the caller's `analytics.read` grants reach. Aggregates only, no message
 * content; groups smaller than ANALYTICS_MIN_GROUP_SIZE are withheld (and, where a total is
 * shown, one more group with them, so the hidden one cannot be worked out).
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private parseQuery(query: Query): {
    range: Omit<Range, 'start' | 'end' | 'previous'> & { previous: { from: string; to: string } };
    filters: Filters;
    timezone: string;
  } {
    if (!validTimeZone(query.timezone)) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'timezone', message: 'Not a time zone, e.g. Europe/Berlin or UTC' }],
      });
    }
    const days = Math.round((Date.parse(query.to) - Date.parse(query.from)) / DAY) + 1;
    if (days < 1) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'to', message: 'The end date comes before the start date.' }],
      });
    }
    if (days > MAX_DAYS) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'to', message: `Choose at most ${MAX_DAYS} days.` }],
      });
    }
    const id = (kind: 'brand' | 'team', value: string | undefined) => {
      if (!value) return null;
      try {
        return fromPublicId(kind, value);
      } catch {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: `${kind}Id`, message: 'Unknown id' }],
        });
      }
    };
    return {
      range: {
        from: query.from,
        to: query.to,
        days,
        previous: { from: addDays(query.from, -days), to: addDays(query.from, -1) },
      },
      filters: {
        brandId: id('brand', query.brandId),
        teamId: id('team', query.teamId),
        channel: query.channel ?? null,
      },
      timezone: query.timezone,
    };
  }

  private async bounds(
    tx: TenantTx,
    parsed: ReturnType<AnalyticsService['parseQuery']>,
  ): Promise<Range> {
    const tz = parsed.timezone;
    const { range } = parsed;
    const { rows } = await tx.execute<{ s: Date; e: Date; ps: Date; pe: Date }>(sql`
      select (${range.from}::date)::timestamp at time zone ${tz} as s,
             (${range.to}::date + 1)::timestamp at time zone ${tz} as e,
             (${range.previous.from}::date)::timestamp at time zone ${tz} as ps,
             (${range.previous.to}::date + 1)::timestamp at time zone ${tz} as pe`);
    const row = rows[0];
    if (!row) throw new Error('range not computed');
    return {
      ...range,
      start: new Date(row.s),
      end: new Date(row.e),
      previous: { ...range.previous, start: new Date(row.ps), end: new Date(row.pe) },
    };
  }

  async overview(principal: Principal, query: Query): Promise<Overview> {
    const now = this.clock();
    const scope = analyticsScope(principal, now);
    if (!scope) throw new AppError('SCOPE_DENIED');
    const parsed = this.parseQuery(query);
    const k = this.config.ANALYTICS_MIN_GROUP_SIZE;
    return withTenant(this.db, { tenantId: principal.tenantId }, async (tx) => {
      const range = await this.bounds(tx, parsed);
      const tz = parsed.timezone;
      const where = conditions(scope, parsed.filters, sql`m.channel`);
      const metricsFrom = sql`conversation_metrics m
        left join brands b on b.tenant_id = m.tenant_id and b.id = m.brand_id
        left join conversation_inbox_state s on s.tenant_id = m.tenant_id and s.conversation_id = m.id`;
      const inRange = sql`m.created_at >= ${range.start} and m.created_at < ${range.end}`;
      // A customer still waiting less than an hour is not missed yet.
      const hourAgo = new Date(now.getTime() - 3_600_000);

      const { rows: totalsRows } = await tx.execute<Record<string, unknown>>(sql`
        select
          count(*) filter (where ${inRange}) as conversations,
          count(*) filter (where m.created_at >= ${range.previous.start} and m.created_at < ${range.previous.end}) as previous,
          count(*) filter (where ${inRange} and m.started_with = 'ai') as ai_started,
          count(*) filter (where ${inRange} and m.started_with = 'ai' and m.handed_off_at is not null) as handed_off,
          count(*) filter (where ${inRange} and m.first_resolved_at is not null) as resolved,
          count(*) filter (where ${inRange} and m.started_with = 'ai' and m.first_resolved_at is not null and m.resolved_by = 'ai') as ai_resolved,
          count(*) filter (where ${inRange} and m.handoff_reason = 'ai_limit') as limit_handoffs,
          count(*) filter (where ${inRange} and m.first_response_at is not null and m.first_customer_message_at is not null) as frt_sample,
          percentile_cont(0.5) within group (order by extract(epoch from m.first_response_at - m.first_customer_message_at))
            filter (where ${inRange} and m.first_response_at is not null and m.first_customer_message_at is not null) as frt_median,
          count(*) filter (where ${inRange} and m.first_customer_message_at is not null
            and (m.first_response_at is not null or m.first_customer_message_at < ${hourAgo})) as missed_sample,
          count(*) filter (where ${inRange} and m.first_customer_message_at is not null
            and (m.first_response_at is null and m.first_customer_message_at < ${hourAgo}
                 or m.first_response_at > m.first_customer_message_at + interval '1 hour')) as missed,
          count(*) filter (where ${inRange} and s.ticket_source = 'offline_form') as offline_messages,
          count(*) filter (where ${inRange} and m.reopen_count > 0) as reopened,
          count(*) filter (where ${inRange} and m.first_resolved_at is not null) as resolution_sample,
          percentile_cont(0.5) within group (order by extract(epoch from m.first_resolved_at - m.created_at))
            filter (where ${inRange} and m.first_resolved_at is not null) as resolution_median
        from ${metricsFrom}
        where ${where}`);
      const t = totalsRows[0] ?? {};

      const { rows: csatRows } = await tx.execute<{ n: string; avg: string | null }>(sql`
        select count(*) as n, avg(f.rating)::float8 as avg
        from ${metricsFrom}
        join conversation_feedback f on f.tenant_id = m.tenant_id and f.conversation_id = m.id
        where ${where} and ${inRange}`);
      const csatSample = num(csatRows[0]?.n);

      const { rows: dailyRows } = await tx.execute<{
        day: string;
        current: string;
        previous: string;
      }>(sql`
        with days as (
          select d::date as day, (d - ${`${range.days} days`}::interval)::date as previous_day
          from generate_series(${range.from}::date, ${range.to}::date, interval '1 day') as d
        ),
        counted as (
          select (m.created_at at time zone ${tz})::date as day, count(*) as n
          from ${metricsFrom}
          where ${where}
            and m.created_at >= ${range.previous.start} and m.created_at < ${range.end}
          group by 1
        )
        select to_char(days.day, 'YYYY-MM-DD') as day,
               coalesce(c.n, 0) as current, coalesce(p.n, 0) as previous
        from days
        left join counted c on c.day = days.day
        left join counted p on p.day = days.previous_day
        order by days.day`);

      const { rows: reasonRows } = await tx.execute<{ reason: string | null; n: string }>(sql`
        select coalesce(m.handoff_reason, 'unknown') as reason, count(*) as n
        from ${metricsFrom}
        where ${where} and ${inRange} and m.started_with = 'ai' and m.handed_off_at is not null
        group by 1 order by 2 desc, 1`);

      const { rows: teamRows } = await tx.execute<Record<string, unknown>>(sql`
        select s.team_id as team_id, tm.name as name, count(*) as conversations,
          count(*) filter (where m.started_with = 'ai') as ai_started,
          count(*) filter (where m.started_with = 'ai' and m.handed_off_at is not null) as handed_off,
          count(*) filter (where m.first_response_at is not null and m.first_customer_message_at is not null) as frt_sample,
          percentile_cont(0.5) within group (order by extract(epoch from m.first_response_at - m.first_customer_message_at))
            filter (where m.first_response_at is not null and m.first_customer_message_at is not null) as frt_median,
          coalesce(sum(fb.n), 0) as csat_n,
          sum(fb.total)::float8 / nullif(sum(fb.n), 0) as csat_avg
        from ${metricsFrom}
        left join teams tm on tm.tenant_id = m.tenant_id and tm.id = s.team_id
        left join (
          select f.conversation_id, count(*) as n, sum(f.rating) as total
          from conversation_feedback f group by f.conversation_id
        ) fb on fb.conversation_id = m.id
        where ${where} and ${inRange}
        group by s.team_id, tm.name
        order by 3 desc, 2`);

      const { rows: channelRows } = await tx.execute<Record<string, unknown>>(sql`
        select m.channel as channel, count(*) as conversations,
          count(*) filter (where m.started_with = 'ai') as ai_started,
          count(*) filter (where m.started_with = 'ai' and m.handed_off_at is not null) as handed_off
        from ${metricsFrom}
        where ${where} and ${inRange}
        group by 1 order by 2 desc`);

      // Tickets (H19): opened in the range, and open now whenever they were opened.
      const ticketsFrom = sql`${metricsFrom}
        join conversation_controls c on c.tenant_id = m.tenant_id and c.id = m.id`;
      const opened = sql`s.ticket_opened_at >= ${range.start} and s.ticket_opened_at < ${range.end}`;
      const { rows: ticketRows } = await tx.execute<Record<string, unknown>>(sql`
        select
          count(*) filter (where ${opened}) as created,
          count(*) filter (where ${opened} and c.authority_status = 'resolved') as closed,
          count(*) filter (where c.authority_status <> 'resolved') as open_now,
          count(*) filter (where ${opened} and c.authority_status = 'resolved'
            and m.last_resolved_at >= s.ticket_opened_at) as close_sample,
          percentile_cont(0.5) within group (order by extract(epoch from m.last_resolved_at - s.ticket_opened_at))
            filter (where ${opened} and c.authority_status = 'resolved'
              and m.last_resolved_at >= s.ticket_opened_at) as close_median
        from ${ticketsFrom}
        where ${where} and s.ticket_number is not null`);
      const { rows: ticketPriorityRows } = await tx.execute<{
        priority: string | null;
        n: string;
      }>(sql`
        select s.priority as priority, count(*) as n
        from ${metricsFrom}
        where ${where} and s.ticket_number is not null and ${opened}
        group by 1 order by 2 desc, 1`);
      const { rows: ticketSourceRows } = await tx.execute<{ source: string; n: string }>(sql`
        select s.ticket_source as source, count(*) as n
        from ${metricsFrom}
        where ${where} and s.ticket_number is not null and ${opened}
        group by 1 order by 2 desc, 1`);

      // Commerce and AI runs reach conversations recorded before analytics began, too.
      const controlsFrom = sql`conversation_controls m
        left join brands b on b.tenant_id = m.tenant_id and b.id = m.brand_id
        left join conversation_inbox_state s on s.tenant_id = m.tenant_id and s.conversation_id = m.id
        left join authority_inboxes i on i.tenant_id = m.tenant_id and i.id = m.inbox_id`;
      const controlsWhere = conditions(scope, parsed.filters, sql`i.channel_type`);
      const { rows: commerceRows } = await tx.execute<Record<string, unknown>>(sql`
        with placed as (
          select o.currency, count(*) as orders,
                 coalesce(sum(o.total_minor) filter (where o.payment_state = 'captured'), 0) as revenue
          from ${controlsFrom}
          join orders o on o.tenant_id = m.tenant_id and o.conversation_id = m.id
          where ${controlsWhere} and o.placed_at >= ${range.start} and o.placed_at < ${range.end}
          group by 1
        ),
        refunded as (
          select r.currency, count(*) as refunds, coalesce(sum(r.amount_minor), 0) as amount
          from ${controlsFrom}
          join orders o on o.tenant_id = m.tenant_id and o.conversation_id = m.id
          join refunds r on r.tenant_id = o.tenant_id and r.order_id = o.id
          where ${controlsWhere} and r.state = 'succeeded'
            and coalesce(r.succeeded_at, r.requested_at) >= ${range.start}
            and coalesce(r.succeeded_at, r.requested_at) < ${range.end}
          group by 1
        )
        select coalesce(p.currency, f.currency) as currency,
               coalesce(p.orders, 0) as orders, coalesce(p.revenue, 0)::text as revenue,
               coalesce(f.refunds, 0) as refunds, coalesce(f.amount, 0)::text as refunded
        from placed p full join refunded f on f.currency = p.currency
        order by 1`);

      const { rows: aiRows } = await tx.execute<Record<string, unknown>>(sql`
        select count(*) filter (where r.outcome = 'replied') as replies,
               coalesce(sum(r.input_tokens), 0) as tokens_in,
               coalesce(sum(r.output_tokens), 0) as tokens_out
        from ${controlsFrom}
        join runs r on r.tenant_id = m.tenant_id and r.conversation_id = m.id
        where ${controlsWhere} and r.finished_at >= ${range.start} and r.finished_at < ${range.end}`);

      const cache = await this.cache(tx, scope, parsed.filters, range, k);

      const { rows: recordingRows } = await tx.execute<{
        since: Date | null;
        missing: boolean;
      }>(sql`
        select (select min(created_at) from conversation_metrics) as since,
               exists (
                 select 1 from conversation_controls c
                 where c.created_at >= ${range.start} and c.created_at < ${range.end}
                   and not exists (select 1 from conversation_metrics x where x.tenant_id = c.tenant_id and x.id = c.id)
               ) as missing`);

      const conversations = num(t.conversations);
      const aiStarted = num(t.ai_started);
      const resolved = num(t.resolved);
      const frtSample = num(t.frt_sample);
      const resolutionSample = num(t.resolution_sample);

      const daily = protectBreakdown(
        dailyRows.map((row) => ({
          date: row.day,
          count: num(row.current),
          previous: num(row.previous),
        })),
        { k, totalShown: true },
      );
      const previousHidden = new Set(
        protectBreakdown(
          dailyRows.map((row) => ({ date: row.day, count: num(row.previous) })),
          { k, totalShown: true },
        )
          .filter((row) => row.suppressed)
          .map((row) => row.date),
      );

      const reasons = protectBreakdown(
        reasonRows.map((row) => ({ reason: row.reason ?? 'unknown', count: num(row.n) })),
        { k, totalShown: true },
      );
      const teams = protectBreakdown(
        teamRows.map((row) => ({ row, count: num(row.conversations) })),
        { k, totalShown: true },
      );
      const channels = protectBreakdown(
        channelRows.map((row) => ({ row, count: num(row.conversations) })),
        { k, totalShown: true },
      );
      const ai = aiRows[0] ?? {};
      const tk = ticketRows[0] ?? {};
      const closeSample = num(tk.close_sample);
      /** A count, withheld when it is a small group. */
      const count = (value: number, sample: number) => ({
        value: protectCount(value, k),
        suppressed: protectCount(value, k) === null,
        sample,
      });

      return {
        range: { from: range.from, to: range.to, timezone: tz, days: range.days },
        previousRange: { from: range.previous.from, to: range.previous.to },
        minimumGroupSize: k,
        recordingSince: recordingRows[0]?.since
          ? new Date(recordingRows[0].since).toISOString()
          : null,
        partial: Boolean(recordingRows[0]?.missing),
        generatedAt: now.toISOString(),
        totals: {
          conversations: { value: conversations, previous: num(t.previous) },
          handedOff: {
            value: protectCount(num(t.handed_off), k),
            suppressed: protectCount(num(t.handed_off), k) === null,
            sample: aiStarted,
            rate: round(heldRate(num(t.handed_off), aiStarted, k)),
          },
          resolved: {
            value: protectCount(resolved, k),
            suppressed: protectCount(resolved, k) === null,
            sample: conversations,
            rate: round(heldRate(resolved, conversations, k)),
          },
          aiResolved: {
            value: protectCount(num(t.ai_resolved), k),
            suppressed: protectCount(num(t.ai_resolved), k) === null,
            sample: aiStarted,
            rate: round(heldRate(num(t.ai_resolved), aiStarted, k)),
          },
          firstResponseMedianSeconds: {
            value: frtSample >= k ? round(numOrNull(t.frt_median), 1) : null,
            suppressed: frtSample > 0 && frtSample < k,
            sample: frtSample,
          },
          resolutionMedianSeconds: {
            value: resolutionSample >= k ? round(numOrNull(t.resolution_median), 1) : null,
            suppressed: resolutionSample > 0 && resolutionSample < k,
            sample: resolutionSample,
          },
          csatAverage: {
            value: csatSample >= k ? round(numOrNull(csatRows[0]?.avg), 2) : null,
            suppressed: csatSample > 0 && csatSample < k,
            sample: csatSample,
          },
        },
        quality: {
          missed: {
            value: protectCount(num(t.missed), k),
            suppressed: protectCount(num(t.missed), k) === null,
            sample: num(t.missed_sample),
            rate: round(heldRate(num(t.missed), num(t.missed_sample), k)),
          },
          offlineMessages: count(num(t.offline_messages), conversations),
          reopened: {
            value: protectCount(num(t.reopened), k),
            suppressed: protectCount(num(t.reopened), k) === null,
            sample: resolved,
            rate: round(heldRate(num(t.reopened), resolved, k)),
          },
        },
        tickets: {
          created: count(num(tk.created), num(tk.created)),
          closed: count(num(tk.closed), num(tk.created)),
          openNow: count(num(tk.open_now), num(tk.open_now)),
          closeMedianSeconds: {
            value: closeSample >= k ? round(numOrNull(tk.close_median), 1) : null,
            suppressed: closeSample > 0 && closeSample < k,
            sample: closeSample,
          },
          byPriority: protectBreakdown(
            ticketPriorityRows.map((row) => ({ priority: row.priority, count: num(row.n) })),
            { k, totalShown: true },
          ).map((row) => ({
            priority: row.priority as Overview['tickets']['byPriority'][number]['priority'],
            count: row.suppressed ? null : row.count,
            suppressed: row.suppressed,
          })),
          bySource: protectBreakdown(
            ticketSourceRows.map((row) => ({ source: row.source, count: num(row.n) })),
            { k, totalShown: true },
          ).map((row) => ({
            source: row.source as Overview['tickets']['bySource'][number]['source'],
            count: row.suppressed ? null : row.count,
            suppressed: row.suppressed,
          })),
        },
        daily: daily.map((day) => ({
          date: day.date,
          conversations: day.suppressed ? null : day.count,
          previous: previousHidden.has(day.date) ? null : day.previous,
          suppressed: day.suppressed || previousHidden.has(day.date),
        })),
        handoffReasons: reasons.map((row) => ({
          reason: row.reason,
          count: row.suppressed ? null : row.count,
          suppressed: row.suppressed,
        })),
        teams: teams.map(({ row, count, suppressed }) => {
          const teamFrt = num(row.frt_sample);
          const csatN = num(row.csat_n);
          return {
            teamId: row.team_id ? toPublicId('team', String(row.team_id)) : null,
            name: (row.name as string | null) ?? null,
            conversations: suppressed ? null : count,
            firstResponseMedianSeconds:
              !suppressed && teamFrt >= k ? round(numOrNull(row.frt_median), 1) : null,
            handoffRate: suppressed
              ? null
              : round(heldRate(num(row.handed_off), num(row.ai_started), k)),
            csatAverage: !suppressed && csatN >= k ? round(numOrNull(row.csat_avg), 2) : null,
            csatResponses: suppressed ? 0 : csatN,
            suppressed,
          };
        }),
        channels: channels.map(({ row, count, suppressed }) => ({
          channel: (row.channel as string | null) ?? null,
          conversations: suppressed ? null : count,
          handoffRate: suppressed
            ? null
            : round(heldRate(num(row.handed_off), num(row.ai_started), k)),
          suppressed,
        })),
        commerce: commerceRows.map((row) => {
          const orders = num(row.orders);
          const refunds = num(row.refunds);
          const ordersHidden = orders > 0 && orders < k;
          const refundsHidden = refunds > 0 && refunds < k;
          return {
            currency: String(row.currency),
            orders: ordersHidden ? null : orders,
            revenueMinor: ordersHidden ? null : String(row.revenue ?? '0'),
            refunds: refundsHidden ? null : refunds,
            refundedMinor: refundsHidden ? null : String(row.refunded ?? '0'),
            suppressed: ordersHidden || refundsHidden,
          };
        }),
        ai: {
          replies: num(ai.replies),
          tokensInput: num(ai.tokens_in),
          tokensOutput: num(ai.tokens_out),
          limitHandoffs: protectCount(num(t.limit_handoffs), k),
        },
        cache,
      };
    });
  }

  /**
   * Answer-cache hit rate from the cache's daily counts (per brand, UTC days). Only measurable
   * for whole brands: a team, inbox or channel view has no cache counts of its own.
   */
  private async cache(
    tx: TenantTx,
    scope: AnalyticsScope,
    filters: Filters,
    range: Range,
    k: number,
  ): Promise<Overview['cache']> {
    const notMeasured = { status: 'not_measured' as const, hitRate: null };
    if (filters.teamId || filters.channel) return notMeasured;
    if (!scope.all && (scope.inboxIds.length > 0 || scope.teamIds.length > 0)) return notMeasured;
    const parts: SQL[] = [];
    if (!scope.all) {
      const any: SQL[] = [];
      if (scope.brandIds.length) any.push(sql`c.brand_id in (${uuidList(scope.brandIds)})`);
      if (scope.workspaceIds.length) {
        any.push(sql`b.workspace_id in (${uuidList(scope.workspaceIds)})`);
      }
      parts.push(sql`(${sql.join(any, sql` or `)})`);
    }
    if (filters.brandId) parts.push(sql`c.brand_id = ${filters.brandId}::uuid`);
    const { rows } = await tx.execute<{ hits: string; misses: string }>(sql`
      select coalesce(sum(c.hits), 0) as hits, coalesce(sum(c.misses), 0) as misses
      from cache_metrics_daily c
      left join brands b on b.tenant_id = c.tenant_id and b.id = c.brand_id
      where c.day between ${range.from}::date and ${range.to}::date
        ${parts.length ? sql`and ${sql.join(parts, sql` and `)}` : sql``}`);
    const hits = num(rows[0]?.hits);
    const lookups = hits + num(rows[0]?.misses);
    if (lookups === 0) return notMeasured;
    return { status: 'measured', hitRate: round(protectedRate(hits, lookups, k)) };
  }

  /** The overview as CSV, with the same withholding (empty cells are withheld values). */
  async csv(principal: Principal, query: Query): Promise<string> {
    const o = await this.overview(principal, query);
    const lines: unknown[][] = [
      ['section', 'key', 'value', 'previous_or_rate', 'withheld', 'sample'],
      ['range', `${o.range.from}..${o.range.to}`, o.range.days, o.range.timezone, '', ''],
      [
        'totals',
        'conversations',
        o.totals.conversations.value,
        o.totals.conversations.previous,
        false,
        '',
      ],
    ];
    const metric = (
      key: string,
      m: { value: number | null; suppressed: boolean; sample: number; rate?: number | null },
    ) => lines.push(['totals', key, m.value, m.rate ?? '', m.suppressed, m.sample]);
    metric('handed_off', o.totals.handedOff);
    metric('resolved', o.totals.resolved);
    metric('ai_resolved', o.totals.aiResolved);
    metric('first_response_median_seconds', o.totals.firstResponseMedianSeconds);
    metric('resolution_median_seconds', o.totals.resolutionMedianSeconds);
    metric('csat_average', o.totals.csatAverage);
    lines.push([
      'quality',
      'missed',
      o.quality.missed.value,
      o.quality.missed.rate ?? '',
      o.quality.missed.suppressed,
      o.quality.missed.sample,
    ]);
    lines.push([
      'quality',
      'offline_messages',
      o.quality.offlineMessages.value,
      '',
      o.quality.offlineMessages.suppressed,
      o.quality.offlineMessages.sample,
    ]);
    lines.push([
      'quality',
      'reopened',
      o.quality.reopened.value,
      o.quality.reopened.rate ?? '',
      o.quality.reopened.suppressed,
      o.quality.reopened.sample,
    ]);
    lines.push([
      'tickets',
      'created',
      o.tickets.created.value,
      '',
      o.tickets.created.suppressed,
      '',
    ]);
    lines.push(['tickets', 'closed', o.tickets.closed.value, '', o.tickets.closed.suppressed, '']);
    lines.push([
      'tickets',
      'open_now',
      o.tickets.openNow.value,
      '',
      o.tickets.openNow.suppressed,
      '',
    ]);
    lines.push([
      'tickets',
      'close_median_seconds',
      o.tickets.closeMedianSeconds.value,
      '',
      o.tickets.closeMedianSeconds.suppressed,
      o.tickets.closeMedianSeconds.sample,
    ]);
    for (const row of o.tickets.byPriority) {
      lines.push(['ticket_priority', row.priority ?? 'none', row.count, '', row.suppressed, '']);
    }
    for (const row of o.tickets.bySource) {
      lines.push(['ticket_source', row.source, row.count, '', row.suppressed, '']);
    }
    for (const day of o.daily) {
      lines.push(['daily', day.date, day.conversations, day.previous, day.suppressed, '']);
    }
    for (const reason of o.handoffReasons) {
      lines.push(['handoff_reason', reason.reason, reason.count, '', reason.suppressed, '']);
    }
    for (const team of o.teams) {
      lines.push([
        'team',
        team.name ?? team.teamId ?? 'no team',
        team.conversations,
        team.handoffRate,
        team.suppressed,
        '',
      ]);
    }
    for (const channel of o.channels) {
      lines.push([
        'channel',
        channel.channel ?? 'unknown',
        channel.conversations,
        channel.handoffRate,
        channel.suppressed,
        '',
      ]);
    }
    for (const row of o.commerce) {
      lines.push(['revenue_minor', row.currency, row.revenueMinor, row.orders, row.suppressed, '']);
      lines.push([
        'refunded_minor',
        row.currency,
        row.refundedMinor,
        row.refunds,
        row.suppressed,
        '',
      ]);
    }
    lines.push(['ai', 'replies', o.ai.replies, '', false, '']);
    lines.push(['ai', 'tokens_input', o.ai.tokensInput, '', false, '']);
    lines.push(['ai', 'tokens_output', o.ai.tokensOutput, '', false, '']);
    lines.push(['ai', 'limit_handoffs', o.ai.limitHandoffs, '', o.ai.limitHandoffs === null, '']);
    lines.push([
      'cache',
      'hit_rate',
      o.cache.hitRate,
      o.cache.status,
      o.cache.status === 'measured' && o.cache.hitRate === null,
      '',
    ]);
    return `${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }
}
