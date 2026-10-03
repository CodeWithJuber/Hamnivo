import { SendIcon, StarIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type ChatLanguage, DEFAULT_WIDGET_TEXT, PREVIEW_TEXT } from '../../lib/setup-data';

/**
 * The chat as customers will see it, drawn from the values being edited, before anything is
 * saved. It is a picture of the chat panel (white, with ink text, as the real one always is), so
 * it keeps its own colours whatever theme Studio is in. The real chat is one button away
 * ("Test chat").
 */
export interface PreviewLook {
  name: string;
  /** Main colour and the text colour used on it, both `#RRGGBB`. */
  colour: string;
  on: string;
  /** Corner radius in pixels, 0 to 24. */
  radius: number;
  logoUrl: string | null;
  greeting: string;
  /** What customers read when nobody is online, with `{when}` already filled in. */
  away: string;
  showAway: boolean;
  csat: boolean;
  privacyUrl: string | null;
  lang: ChatLanguage;
}

const INK = '#192A30';
const MUTED = '#F1F2F2';
const BORDER = '#D9DDDF';

/** The design's corner sizes at the default radius (6, 8, 12, 16 px), scaled with the brand's choice. */
export const corner = (radius: number, base: 6 | 8 | 12 | 16): string =>
  `${Math.round(((base * radius) / 12) * 10) / 10}px`;

/** "Monday 9:00 AM": a sample of when people are back, in the language being previewed. */
export function sampleWhen(lang: ChatLanguage): string {
  return new Intl.DateTimeFormat(lang, {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2026, 0, 5, 9, 0)));
}

/** The brand's own words in one language, its English when that language is empty, else the default. */
export function previewText(
  own: Readonly<Record<ChatLanguage, string>>,
  lang: ChatLanguage,
  fallback: string,
): string {
  return own[lang].trim() || own.en.trim() || fallback;
}

export const previewAway = (own: Readonly<Record<ChatLanguage, string>>, lang: ChatLanguage) =>
  previewText(own, lang, DEFAULT_WIDGET_TEXT.away[lang]).replaceAll('{when}', sampleWhen(lang));

export function WidgetPreview({ look }: { look: PreviewLook }) {
  const { t } = useTranslation();
  const rtl = look.lang === 'ar' || look.lang === 'ur';
  const words = PREVIEW_TEXT[look.lang];
  const bubble = { borderRadius: corner(look.radius, 12) };
  return (
    <section
      aria-label={t('setup.appearance.previewLabel')}
      data-testid="widget-preview"
      lang={look.lang}
      dir={rtl ? 'rtl' : 'ltr'}
      className="mx-auto flex w-full max-w-[340px] flex-col overflow-hidden border shadow-lg"
      style={{
        borderRadius: corner(look.radius, 16),
        backgroundColor: '#FFFFFF',
        color: INK,
        borderColor: BORDER,
      }}
    >
      <header
        className="flex items-center gap-3 px-4 py-3"
        style={{ backgroundColor: look.colour, color: look.on }}
        data-testid="preview-header"
      >
        {look.logoUrl ? (
          <img
            src={look.logoUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="size-7 shrink-0 rounded-sm bg-white object-contain"
            style={{ borderRadius: corner(look.radius, 6) }}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          <bdi>{look.name}</bdi>
        </span>
        <XIcon className="size-4 shrink-0" aria-hidden="true" />
      </header>
      <div className="flex min-h-56 flex-col gap-3 p-4 text-sm">
        <p
          className="max-w-[85%] self-start px-3 py-2"
          style={{ ...bubble, backgroundColor: MUTED }}
          data-testid="preview-greeting"
        >
          {look.greeting}
        </p>
        <p
          className="max-w-[85%] self-end px-3 py-2"
          style={{ ...bubble, backgroundColor: look.colour, color: look.on }}
          data-testid="preview-customer"
        >
          {words.question}
        </p>
        {look.showAway ? (
          <p
            className="max-w-[90%] self-start px-3 py-2"
            style={{ ...bubble, backgroundColor: MUTED }}
            data-testid="preview-away"
          >
            {look.away}
          </p>
        ) : null}
        {look.csat ? (
          <div
            className="mt-auto flex flex-col items-center gap-1 border-t pt-3 text-xs"
            style={{ borderColor: BORDER }}
            data-testid="preview-csat"
          >
            <span className="font-medium">{words.rating}</span>
            <span className="flex gap-1" aria-hidden="true">
              {[1, 2, 3, 4, 5].map((n) => (
                <StarIcon key={n} className="size-5" style={{ color: look.colour }} />
              ))}
            </span>
          </div>
        ) : null}
      </div>
      <div
        className="flex items-center gap-2 border-t px-3 py-2"
        style={{ borderColor: BORDER }}
        aria-hidden="true"
      >
        <span
          className="flex-1 border px-3 py-2 text-xs"
          style={{ borderRadius: corner(look.radius, 8), borderColor: BORDER, color: '#5A6A70' }}
        >
          {words.placeholder}
        </span>
        <span
          className="flex size-9 items-center justify-center"
          style={{
            borderRadius: corner(look.radius, 8),
            backgroundColor: look.colour,
            color: look.on,
          }}
        >
          <SendIcon className="size-4 rtl:-scale-x-100" />
        </span>
      </div>
      {look.privacyUrl ? (
        <p
          className="border-t px-4 py-2 text-center text-xs underline"
          style={{ borderColor: BORDER }}
          data-testid="preview-privacy"
        >
          {words.privacy}
        </p>
      ) : null}
    </section>
  );
}
