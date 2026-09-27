import { NativeSelect, NativeSelectOption } from '@hamnivo/ui/components/native-select';
import { LanguagesIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { changeLocale, isLocale, LANGUAGE_NAMES, LOCALES } from '../i18n';

/** Says, in the language itself, that a translation still awaits review by native speakers. */
export function TranslationNote({ className }: { className?: string }) {
  const { t } = useTranslation();
  const note = t('app.translationNote');
  if (!note) return null;
  return <p className={className ?? 'text-xs text-text-secondary'}>{note}</p>;
}

/** Interface language. Each option is named in its own language and marked with its lang. */
export function LanguageSelect({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="flex items-center gap-1.5">
      <LanguagesIcon className="size-4 text-text-muted" aria-hidden="true" />
      <label htmlFor={id} className="sr-only">
        {t('app.language')}
      </label>
      <NativeSelect
        id={id}
        size="sm"
        value={i18n.language}
        onChange={(event) => {
          if (isLocale(event.target.value)) void changeLocale(event.target.value);
        }}
      >
        {LOCALES.map((locale) => (
          <NativeSelectOption key={locale} value={locale} lang={locale}>
            {LANGUAGE_NAMES[locale]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}
