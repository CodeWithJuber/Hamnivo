import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../lib/format';
import type { AnalyticsOverview } from '../../lib/reports';

type Day = AnalyticsOverview['daily'][number];

const HEIGHT = 220;
const MARGIN = { top: 12, bottom: 28, start: 44, end: 16 };
/** Above this many days, points are not marked (the line carries the shape). */
const MARKED_DAYS = 31;

/** A clean upper bound for the axis: 1, 2 or 5 times a power of ten, at least 4. */
export function niceMax(value: number): number {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= value) return step * power;
  }
  return 10 * power;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Consecutive runs of shown values (withheld days break the line). */
function segments(values: (number | null)[]): { index: number; value: number }[][] {
  const runs: { index: number; value: number }[][] = [];
  let current: { index: number; value: number }[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length) runs.push(current);
      current = [];
    } else current.push({ index, value });
  });
  if (current.length) runs.push(current);
  return runs;
}

/**
 * Conversations per day against the period before (board 23). One accent line for this period
 * and a dashed de-emphasis line for the previous one (an emphasis chart: the dash is the second
 * channel, so the two never rely on colour alone). Withheld days are gaps, never zeros. Hovering
 * or focusing the chart shows every series for a day; the same numbers are in the table below.
 */
export function ConversationsChart({
  days,
  previousRange,
  minimumGroupSize,
}: {
  days: Day[];
  previousRange: { from: string; to: string };
  minimumGroupSize: number;
}) {
  const { t, i18n } = useTranslation();
  const rtl = i18n.dir() === 'rtl';
  const locale = i18n.resolvedLanguage ?? 'en';
  const { ref, width } = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const plotWidth = width - MARGIN.start - MARGIN.end;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  /** Left edge of the plot in SVG coordinates (the axis sits on the reading-start side). */
  const plotStart = rtl ? MARGIN.end : MARGIN.start;
  const values = days.map((day) => day.conversations);
  const previous = days.map((day) => day.previous);
  const top = niceMax(Math.max(0, ...values.map((v) => v ?? 0), ...previous.map((v) => v ?? 0)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => Math.round(top * share));
  const step = days.length > 1 ? plotWidth / (days.length - 1) : 0;
  // Time runs with the reading direction: right to left in Arabic and Urdu.
  const x = (index: number) =>
    rtl
      ? width - MARGIN.start - (days.length > 1 ? index * step : plotWidth / 2)
      : MARGIN.start + (days.length > 1 ? index * step : plotWidth / 2);
  const y = (value: number) => MARGIN.top + plotHeight - (value / top) * plotHeight;
  const dayLabel = (date: string) =>
    new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
      new Date(`${date}T00:00:00Z`),
    );
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotWidth / 72))));
  const path = (runs: { index: number; value: number }[][]) =>
    runs
      .map((run) =>
        run.map((point, i) => `${i === 0 ? 'M' : 'L'}${x(point.index)},${y(point.value)}`).join(''),
      )
      .join('');
  const nearest = (clientX: number, rect: DOMRect) => {
    const offset = rtl ? rect.right - clientX - MARGIN.start : clientX - rect.left - MARGIN.start;
    if (days.length <= 1) return 0;
    return Math.min(days.length - 1, Math.max(0, Math.round(offset / step)));
  };
  const onKey = (event: KeyboardEvent) => {
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (event.key === forward) setActive((i) => Math.min(days.length - 1, (i ?? -1) + 1));
    else if (event.key === back) setActive((i) => Math.max(0, (i ?? days.length) - 1));
    else if (event.key === 'Home') setActive(0);
    else if (event.key === 'End') setActive(days.length - 1);
    else if (event.key === 'Escape') setActive(null);
    else return;
    event.preventDefault();
  };
  const shown = active !== null ? days[active] : undefined;
  const withheld = t('reports.withheld');
  const summary = t('reports.chart.summary', {
    from: days[0] ? dayLabel(days[0].date) : '',
    to: days.at(-1) ? dayLabel(days.at(-1)?.date ?? '') : '',
  });

  return (
    <figure className="flex flex-col gap-3" data-testid="conversations-chart">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text-secondary">
        <span className="flex items-center gap-2">
          <svg width="20" height="8" aria-hidden="true">
            <line
              x1="1"
              y1="4"
              x2="19"
              y2="4"
              className="stroke-brand"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          {t('reports.chart.current')}
        </span>
        <span className="flex items-center gap-2">
          <svg width="20" height="8" aria-hidden="true">
            <line
              x1="1"
              y1="4"
              x2="19"
              y2="4"
              className="stroke-border-input"
              strokeWidth="2"
              strokeDasharray="4 3"
              strokeLinecap="round"
            />
          </svg>
          {t('reports.chart.previous', {
            from: dayLabel(previousRange.from),
            to: dayLabel(previousRange.to),
          })}
        </span>
      </div>
      <div ref={ref} className="relative w-full">
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={summary}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the plot takes arrow keys to move between days
          tabIndex={0}
          className="block rounded-md focus-visible:outline-2"
          onKeyDown={onKey}
          onFocus={() => setActive((i) => i ?? days.length - 1)}
          onBlur={() => setActive(null)}
          onPointerMove={(event) =>
            setActive(nearest(event.clientX, event.currentTarget.getBoundingClientRect()))
          }
          onPointerLeave={() => setActive(null)}
          data-testid="chart-plot"
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={plotStart}
                x2={plotStart + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-border"
                strokeWidth="1"
              />
              <text
                x={rtl ? width - MARGIN.start + 8 : MARGIN.start - 8}
                y={y(tick)}
                dy="0.32em"
                textAnchor={rtl ? 'start' : 'end'}
                className="fill-text-muted text-xs tabular-nums"
              >
                {formatNumber(tick)}
              </text>
            </g>
          ))}
          {days.map((day, index) =>
            index % labelEvery === 0 || index === days.length - 1 ? (
              <text
                key={day.date}
                x={x(index)}
                y={HEIGHT - 8}
                textAnchor="middle"
                className="fill-text-muted text-xs"
              >
                {dayLabel(day.date)}
              </text>
            ) : null,
          )}
          <path
            d={path(segments(previous))}
            fill="none"
            className="stroke-border-input"
            strokeWidth="2"
            strokeDasharray="4 3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={path(segments(values))}
            fill="none"
            className="stroke-brand"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {days.length <= MARKED_DAYS
            ? values.map((value, index) =>
                value === null ? null : (
                  <circle
                    key={days[index]?.date}
                    cx={x(index)}
                    cy={y(value)}
                    r="4"
                    className="fill-brand stroke-surface"
                    strokeWidth="2"
                  />
                ),
              )
            : null}
          {active !== null ? (
            <line
              x1={x(active)}
              x2={x(active)}
              y1={MARGIN.top}
              y2={MARGIN.top + plotHeight}
              className="stroke-text-muted"
              strokeWidth="1"
            />
          ) : null}
        </svg>
        {shown ? (
          <div
            role="status"
            data-testid="chart-tooltip"
            className="pointer-events-none absolute top-2 z-10 flex min-w-40 flex-col gap-1 rounded-lg border border-border bg-surface p-3 text-sm shadow-md"
            style={{
              insetInlineStart: Math.min(
                Math.max(0, (rtl ? width - x(active ?? 0) : x(active ?? 0)) + 12),
                Math.max(0, width - 180),
              ),
            }}
          >
            <span className="font-medium text-text">{dayLabel(shown.date)}</span>
            <span className="flex items-center gap-2">
              <svg width="14" height="6" aria-hidden="true">
                <line x1="1" y1="3" x2="13" y2="3" className="stroke-brand" strokeWidth="2" />
              </svg>
              <strong className="text-text">
                {shown.conversations === null ? withheld : formatNumber(shown.conversations)}
              </strong>
              <span className="text-text-secondary">{t('reports.chart.currentShort')}</span>
            </span>
            <span className="flex items-center gap-2">
              <svg width="14" height="6" aria-hidden="true">
                <line
                  x1="1"
                  y1="3"
                  x2="13"
                  y2="3"
                  className="stroke-border-input"
                  strokeWidth="2"
                  strokeDasharray="4 3"
                />
              </svg>
              <strong className="text-text">
                {shown.previous === null ? withheld : formatNumber(shown.previous)}
              </strong>
              <span className="text-text-secondary">{t('reports.chart.previousShort')}</span>
            </span>
          </div>
        ) : null}
      </div>
      <figcaption className="text-xs text-text-secondary">
        {t('reports.chart.caption', { count: minimumGroupSize })}
      </figcaption>
      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer p-3 text-sm font-medium text-text">
          {t('reports.chart.table')}
        </summary>
        <div className="overflow-x-auto p-3 pt-0">
          <Table data-testid="chart-table">
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-normal">{t('reports.chart.date')}</TableHead>
                <TableHead className="whitespace-normal">{t('reports.chart.current')}</TableHead>
                <TableHead className="whitespace-normal">
                  {t('reports.chart.previous', {
                    from: dayLabel(previousRange.from),
                    to: dayLabel(previousRange.to),
                  })}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {days.map((day) => (
                <TableRow key={day.date}>
                  <TableCell className="whitespace-normal">{dayLabel(day.date)}</TableCell>
                  <TableCell className="whitespace-normal tabular-nums">
                    {day.conversations === null ? withheld : formatNumber(day.conversations)}
                  </TableCell>
                  <TableCell className="whitespace-normal tabular-nums">
                    {day.previous === null ? withheld : formatNumber(day.previous)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </figure>
  );
}
