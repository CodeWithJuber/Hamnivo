import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../lib/format';

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
export const count = (metric: { value: number | null }) =>
  metric.value === null ? null : formatNumber(metric.value);

/** One headline number with what it stands on; withheld values say why, in neutral text. */
export function Tile({
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

/** A short table of counts by name, with withheld counts said in words, like the reasons above. */
export function CountTable({
  testId,
  head,
  rows,
  countHead,
  empty,
}: {
  testId: string;
  head: string;
  rows: Array<{ key: string; name: string; count: number | null }>;
  /** The count column's heading; tickets by default. */
  countHead?: string;
  /** Said when there are no rows. */
  empty?: string;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return <p className="text-sm text-text-secondary">{empty ?? t('reports.tickets.emptyList')}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <Table data-testid={testId}>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-normal">{head}</TableHead>
            <TableHead className="whitespace-normal">
              {countHead ?? t('reports.tickets.count')}
            </TableHead>
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
