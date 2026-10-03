import type { BusinessHours } from '@hamnivo/contracts';
import { useTranslation } from 'react-i18next';
import { daysText, groupDays, spansText } from '../../lib/hours';

/** A brand's business hours in words: the days that are open and when, and the time zone. */
export function HoursSummary({ hours }: { hours: BusinessHours | null }) {
  const { t, i18n } = useTranslation();
  if (!hours) {
    return (
      <p className="text-sm text-text-secondary" data-testid="hours-summary">
        {t('setup.hours.notSet')}
      </p>
    );
  }
  const groups = groupDays(hours.weekly);
  const to = t('setup.hours.to');
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="hours-summary">
      {groups.length === 0 ? (
        <p className="text-text-secondary">{t('setup.hours.closedAlways')}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {groups.map((group) => (
            <li key={group.days.join('-')} className="text-text">
              <span className="font-medium">{daysText(group.days, i18n.language, to)}</span>{' '}
              <bdi dir="ltr">{spansText(group.spans, to)}</bdi>
            </li>
          ))}
        </ul>
      )}
      <p className="text-text-secondary">
        <bdi dir="ltr">{hours.timezone}</bdi>
        {hours.closedDates.length > 0
          ? ` · ${t('setup.hours.closedDays', { n: hours.closedDates.length })}`
          : ''}
      </p>
    </div>
  );
}
