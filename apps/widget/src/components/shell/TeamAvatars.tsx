import type { WidgetConfig } from '@hamnivo/contracts';
import { useTranslation } from 'react-i18next';

type Team = NonNullable<WidgetConfig['team']>;

/** Up to two letters for a name, the way someone without a photo is drawn. */
export const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('')
    .toLocaleUpperCase();

/** "Sara", "Sara and Ali", "Sara, Ali and Hana", in the chat's language. */
export function namesText(names: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}

/** Minutes as "5 minutes", "1 hour", "1 day", in the chat's language. */
export function durationText(minutes: number, locale: string): string {
  const [value, unit] =
    minutes >= 1440
      ? [Math.round(minutes / 1440), 'day']
      : minutes >= 60
        ? [Math.round(minutes / 60), 'hour']
        : [minutes, 'minute'];
  try {
    return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(
      value,
    );
  } catch {
    return `${value} ${unit}${value === 1 ? '' : 's'}`;
  }
}

/**
 * Who on the team is online (W17), the way Tawk and Intercom show it: their photos, or initials,
 * overlapping in a row, then their first names, then how soon people usually reply. Only what each
 * person chose to show reaches the chat; the photos are decoration, the words say it.
 */
export function TeamAvatars(props: { team: Team; locale: string }) {
  const { t } = useTranslation();
  const { online, replyMinutes } = props.team;
  if (online.length === 0 && replyMinutes === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="team">
      {online.length > 0 ? (
        <div className="flex shrink-0 -space-x-2 rtl:space-x-reverse" aria-hidden="true">
          {online.map((person, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: at most three, in a fixed order
              key={index}
              className="hv-team-avatar flex size-9 items-center justify-center overflow-hidden rounded-full text-xs font-semibold ring-2"
              data-testid="team-avatar"
            >
              {person.photoUrl ? (
                <img
                  src={person.photoUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="size-full object-cover"
                />
              ) : (
                initialsOf(person.name)
              )}
            </span>
          ))}
        </div>
      ) : null}
      <div className="min-w-0 text-sm leading-snug">
        {online.length > 0 ? (
          <p className="font-medium" data-testid="team-online">
            {t('surface.team.online', {
              count: online.length,
              names: namesText(
                online.map((p) => p.name),
                props.locale,
              ),
            })}
          </p>
        ) : null}
        {replyMinutes !== null ? (
          <p className="opacity-90" data-testid="team-reply">
            {t('surface.team.reply', { time: durationText(replyMinutes, props.locale) })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
