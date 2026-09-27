import i18next from 'i18next';

/** Dates, numbers and sizes in the interface language, always through Intl. */
const locale = () => i18next.resolvedLanguage ?? i18next.language ?? 'en';

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'full' }).format(new Date(iso));
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat(locale()).format(value);
}

export function formatScore(value: number): string {
  return new Intl.NumberFormat(locale(), {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(value);
}

/** Milliseconds as "850 ms" or "1.2 sec" in the interface language. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) {
    return new Intl.NumberFormat(locale(), {
      style: 'unit',
      unit: 'millisecond',
      unitDisplay: 'short',
    }).format(ms);
  }
  return new Intl.NumberFormat(locale(), {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(ms / 1000);
}

export function formatBytes(bytes: number): string {
  const units = ['byte', 'kilobyte', 'megabyte'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(locale(), {
    style: 'unit',
    unit: units[unit],
    // "147 bytes" but "12.3 kB": the short form of byte is not plural in every locale.
    unitDisplay: unit === 0 ? 'long' : 'short',
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

/** "5 minutes ago", "yesterday" — for recent events next to an exact date. */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) {
      return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(
        Math.round(value),
        unit,
      );
    }
    value /= size;
  }
  return '';
}
