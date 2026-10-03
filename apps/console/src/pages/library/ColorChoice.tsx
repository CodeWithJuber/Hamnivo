import { CheckIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_TAG_COLOR, paletteColor, TAG_COLORS } from '../../lib/library';

/**
 * The colour of a tag: ready-made colours in a row, each one a radio button with its name for
 * people who cannot tell colours apart, and the chosen one named underneath. A colour made
 * elsewhere (in the chat service itself) is kept as one more choice, so editing a tag never changes
 * it unless asked.
 */
export function ColorChoice({
  id,
  legend,
  value,
  onChange,
}: {
  id: string;
  legend: string;
  /** A colour like `#1f93ff`, lower case. */
  value: string;
  onChange: (hex: string) => void;
}) {
  const { t } = useTranslation();
  const options = [
    ...(paletteColor(value)
      ? []
      : [
          {
            hex: value,
            name: t('inboxAlerts.library.tags.colors.custom', { hex: value.toUpperCase() }),
          },
        ]),
    ...TAG_COLORS.map((color) => ({
      hex: color.hex as string,
      name: t(`inboxAlerts.library.tags.colors.${color.id}`),
    })),
  ];
  const chosen = options.find((option) => option.hex === value);
  return (
    <fieldset className="flex min-w-0 flex-col gap-2" data-testid="tag-colors">
      <legend className="mb-1 text-sm font-medium text-text">{legend}</legend>
      <div className="flex flex-wrap gap-2.5">
        {options.map((option) => (
          <label key={option.hex} className="relative cursor-pointer">
            <input
              type="radio"
              name={`${id}-color`}
              value={option.hex}
              checked={option.hex === value}
              onChange={() => onChange(option.hex)}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-full border border-border ring-offset-2 ring-offset-surface peer-checked:ring-2 peer-checked:ring-text peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-checked:[&>svg]:opacity-100"
              style={{ backgroundColor: option.hex }}
            >
              <CheckIcon className="size-4 text-white opacity-0" />
            </span>
            <span className="sr-only">{option.name}</span>
          </label>
        ))}
      </div>
      {chosen ? (
        <p className="text-sm text-text-secondary">
          {t('inboxAlerts.library.tags.dialog.colorChosen', { name: chosen.name })}
        </p>
      ) : null}
    </fieldset>
  );
}

/** A tag's colour as a dot, with the tag's name beside it (never colour alone). */
export function TagDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3 shrink-0 rounded-full border border-border"
      style={{ backgroundColor: color ?? DEFAULT_TAG_COLOR }}
    />
  );
}
