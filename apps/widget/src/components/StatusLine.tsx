import type { WidgetConfig } from '@hamnivo/contracts';
import { HourglassIcon, InboxIcon, MoonIcon, UserRoundCheckIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { availabilityOf, backAt } from '../availability.js';

const ICONS = {
  online: UserRoundCheckIcon,
  busy: HourglassIcon,
  away: MoonIcon,
  nobody: InboxIcon,
} as const;

/**
 * Who can answer right now (W11), in words with an icon beside them: never colour alone. On the
 * home screen it sits under the greeting; `compact` is the small line under the chat's header.
 */
export function StatusLine({
  availability,
  locale,
  compact = false,
}: {
  availability: WidgetConfig['availability'];
  locale: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const status = availabilityOf(availability);
  const Icon = ICONS[status.kind];
  const text =
    status.kind === 'away'
      ? t('surface.availability.away', {
          when: backAt(status.until, locale, availability.timezone),
        })
      : t(`surface.availability.${status.kind}`);
  return (
    <p
      className={`flex items-start gap-2 ${compact ? 'text-xs text-text-muted' : 'px-1 text-sm text-text'}`}
      data-testid="availability"
      data-state={status.kind}
    >
      <Icon className={`mt-0.5 shrink-0 ${compact ? 'size-3.5' : 'size-4'}`} aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}
