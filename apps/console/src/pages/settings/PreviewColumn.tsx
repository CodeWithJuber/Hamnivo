import { InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField } from '../../components/Fields';
import { LANGUAGE_NAMES, LOCALES } from '../../i18n';
import type { ChatLanguage } from '../../lib/setup-data';

const LANGUAGES: readonly ChatLanguage[] = LOCALES;

/** The language to preview first: the interface's, when the chat speaks it. */
export const firstPreviewLanguage = (language: string): ChatLanguage =>
  (LANGUAGES as readonly string[]).includes(language) ? (language as ChatLanguage) : 'en';

/**
 * The column beside a form on the Chat widget page: what customers will see, in the language
 * chosen here, and (when the form has several) which part of the chat. It stays in view while the
 * form scrolls on wide screens, and comes after the form on narrow ones.
 */
export function PreviewColumn({
  id,
  lang,
  onLangChange,
  screen,
  screens,
  onScreenChange,
  note,
  notice,
  children,
}: {
  id: string;
  lang: ChatLanguage;
  onLangChange: (lang: ChatLanguage) => void;
  screen?: string;
  /** The parts of the chat this preview can show, when more than one. */
  screens?: readonly { value: string; label: string }[];
  onScreenChange?: (screen: string) => void;
  note?: ReactNode;
  /** Said above the picture when it shows something customers will not see right now. */
  notice?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20 lg:self-start" data-testid={id}>
      <h2 className="text-sm font-semibold text-text">{t('setup.appearance.previewTitle')}</h2>
      <p className="text-sm text-text-secondary">{t('chatWidget.preview.note')}</p>
      <div className={screens && screens.length > 1 ? 'grid grid-cols-2 gap-3' : 'grid gap-3'}>
        <SelectField
          id={`${id}-lang`}
          label={t('chatWidget.preview.language')}
          value={lang}
          onChange={(event) => onLangChange(event.target.value as ChatLanguage)}
          options={LANGUAGES.map((code) => ({ value: code, label: LANGUAGE_NAMES[code] }))}
        />
        {screens && screens.length > 1 && screen !== undefined && onScreenChange ? (
          <SelectField
            id={`${id}-screen`}
            label={t('chatWidget.preview.screen')}
            value={screen}
            onChange={(event) => onScreenChange(event.target.value)}
            options={screens.map((option) => ({ value: option.value, label: option.label }))}
          />
        ) : null}
      </div>
      {note ? <p className="text-sm text-text-secondary">{note}</p> : null}
      {notice ? (
        <p
          className="flex items-start gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text"
          data-testid={`${id}-notice`}
        >
          <InfoIcon className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden="true" />
          <span>{notice}</span>
        </p>
      ) : null}
      {children}
    </div>
  );
}
