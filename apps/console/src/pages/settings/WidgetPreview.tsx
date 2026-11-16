import {
  CheckCircle2Icon,
  ChevronDownIcon,
  PaperclipIcon,
  SendIcon,
  StarIcon,
  XIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { draftOf, drawnColour, isHttpsUrl, textsOf } from '../../lib/appearance';
import { onColour, type WidgetAppearance } from '../../lib/setup';
import {
  type ChatLanguage,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_RADIUS,
  DEFAULT_WIDGET_TEXT,
  PREVIEW_TEXT,
} from '../../lib/setup-data';
import type { FieldKind } from '../../lib/widget-forms';

/**
 * The chat as customers will see it, drawn from the values being edited, before anything is
 * saved. It is a picture of the chat panel in the chat's own light or dark colours, so it keeps
 * them whatever theme Studio is in. The real chat is one button away ("Test chat").
 */
export interface PreviewLook {
  name: string;
  fontFamily?: WidgetAppearance['fontFamily'];
  showBranding?: boolean;
  /** Light or dark; `auto` follows the website, and is drawn light here. */
  theme?: WidgetAppearance['theme'];
  headerStyle?: WidgetAppearance['headerStyle'];
  /** The launcher is drawn under the panel only when its picture is given. */
  launcherIcon?: WidgetAppearance['launcherIcon'];
  launcherSize?: WidgetAppearance['launcherSize'];
  /** Which side of the window the launcher is on. */
  launcherSide?: 'bottom-right' | 'bottom-left';
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

/**
 * Which part of the chat the picture shows: the start (`home`), the form before a chat
 * (`prechat`), the contact form while nobody can answer (`offline`), the consent question
 * (`consent`) or what customers read after sending the contact form (`thanks`).
 */
export type PreviewScreen = 'home' | 'prechat' | 'offline' | 'consent' | 'thanks';

/** A form field as the customer sees it, in the language being previewed. */
export interface PreviewField {
  id: string;
  kind: FieldKind;
  label: string;
  required: boolean;
  /** The answers of a list, in order. */
  options: string[];
}

export interface PreviewContent {
  /** The fields of the form on the `prechat` or `offline` screen. */
  fields?: readonly PreviewField[];
  /** The consent words on the `consent` screen. */
  consent?: string;
  /** What customers read on the `thanks` screen. */
  thanks?: string;
  /** Questions offered before the customer writes (W17), on the `home` screen. */
  suggestions?: readonly string[];
  /** Customers may send files (W09): a paperclip in the text box. */
  attachments?: boolean;
}

/** The chat's own colours (packages/brand tokens), light and dark. */
const PALETTES = {
  light: {
    surface: '#FFFFFF',
    ink: '#192A30',
    muted: '#F1F2F2',
    border: '#D9DDDF',
    secondary: '#5A6A70',
    subtle: '#EEF1F2',
  },
  dark: {
    surface: '#16242A',
    ink: '#F2EFE8',
    muted: '#1B2C33',
    border: '#2A3B42',
    secondary: '#C9D1D4',
    subtle: '#1F3139',
  },
} as const;
type Palette = (typeof PALETTES)[keyof typeof PALETTES];

/** The launcher's pictures, as the loader draws them (one path each, on a 24 px grid). */
const LAUNCHER_ICONS: Record<NonNullable<WidgetAppearance['launcherIcon']>, string> = {
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z',
  message: 'M4 5h16v11H10l-5 4v-4H4z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.7.4-1.2 1-1.2 1.8M12 17h.01',
  sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2zM19 3v4M17 5h4',
};
const LAUNCHER_SIZES = { small: 48, medium: 56, large: 64 } as const;

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

/**
 * The look of a brand's saved appearance, for pages that preview something else (the forms, the
 * consent question). Before the appearance has loaded, the chat's own colours stand in.
 */
export function previewLookOf(
  appearance: WidgetAppearance | undefined,
  name: string,
  lang: ChatLanguage,
): PreviewLook {
  const draft = appearance ? draftOf(appearance) : null;
  const colour = draft ? drawnColour(draft, DEFAULT_PRIMARY_COLOR) : DEFAULT_PRIMARY_COLOR;
  return {
    name,
    fontFamily: appearance?.fontFamily,
    showBranding: appearance?.showBranding,
    theme: appearance?.theme,
    headerStyle: appearance?.headerStyle,
    colour,
    on: onColour(colour),
    radius: draft?.radius ?? DEFAULT_RADIUS,
    logoUrl: draft?.logoUrl && isHttpsUrl(draft.logoUrl) ? draft.logoUrl : null,
    greeting: previewText(
      draft?.greeting ?? textsOf(null),
      lang,
      DEFAULT_WIDGET_TEXT.greeting[lang],
    ),
    away: previewAway(draft?.offline ?? textsOf(null), lang),
    showAway: false,
    csat: false,
    privacyUrl: draft?.privacyUrl && isHttpsUrl(draft.privacyUrl) ? draft.privacyUrl : null,
    lang,
  };
}

/** A form field drawn as the chat draws it: its label, and an empty box to answer in. */
function FieldPicture({
  field,
  radius,
  optional,
  choose,
  palette,
}: {
  field: PreviewField;
  radius: number;
  optional: string;
  choose: string;
  palette: Palette;
}) {
  const BORDER = palette.border;
  const SECONDARY = palette.secondary;
  const box: CSSProperties = { borderRadius: corner(radius, 8), borderColor: BORDER };
  const long = field.kind === 'question' || field.kind === 'text';
  const list = field.kind === 'choice' || field.kind === 'department';
  return (
    <div className="flex flex-col gap-1" data-testid="preview-field" data-kind={field.kind}>
      <span className="text-xs font-medium">
        <bdi>{field.label}</bdi>
        {field.required ? null : <span style={{ color: SECONDARY }}> ({optional})</span>}
      </span>
      {list ? (
        <span
          className="flex items-center justify-between gap-2 border px-3 py-1.5 text-xs"
          style={{ ...box, color: SECONDARY }}
        >
          <span className="truncate">{choose}</span>
          <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
        </span>
      ) : (
        <span className={`block border ${long ? 'h-14' : 'h-8'}`} style={box} />
      )}
      {list && field.options.length > 0 ? (
        <span className="flex flex-wrap gap-1 text-[11px]" style={{ color: SECONDARY }}>
          {field.options.map((option, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: answers of a picture, never reordered here
            <span key={index} className="rounded-full border px-2" style={{ borderColor: BORDER }}>
              <bdi>{option}</bdi>
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

export function WidgetPreview({
  look,
  screen = 'home',
  content = {},
}: {
  look: PreviewLook;
  screen?: PreviewScreen;
  content?: PreviewContent;
}) {
  const { t } = useTranslation();
  const rtl = look.lang === 'ar' || look.lang === 'ur';
  const words = PREVIEW_TEXT[look.lang];
  const dark = look.theme === 'dark';
  const palette = dark ? PALETTES.dark : PALETTES.light;
  const { ink: INK, muted: MUTED, border: BORDER, secondary: SECONDARY } = palette;
  const bubble = { borderRadius: corner(look.radius, 12) };
  const filled: CSSProperties = {
    borderRadius: corner(look.radius, 8),
    backgroundColor: look.colour,
    color: look.on,
  };
  // As the chat draws it: the brand's colour with a soft fall, a calm dark one on a dark chat
  // (the brand's colour is kept for buttons there), or the panel's own colour.
  const plain = look.headerStyle === 'plain';
  const header: CSSProperties = plain
    ? { backgroundColor: palette.surface, color: INK, borderBottom: `1px solid ${BORDER}` }
    : dark
      ? {
          backgroundColor: palette.subtle,
          color: INK,
          backgroundImage: `linear-gradient(180deg, ${palette.subtle}, ${palette.surface})`,
        }
      : {
          backgroundColor: look.colour,
          color: look.on,
          backgroundImage: `linear-gradient(180deg, ${look.colour}, color-mix(in srgb, ${look.colour} 82%, #000))`,
        };
  const fields = content.fields ?? [];
  const form = screen === 'prechat' || screen === 'offline';
  const launcherSize = LAUNCHER_SIZES[look.launcherSize ?? 'medium'];
  const panel = (
    <section
      aria-label={t('setup.appearance.previewLabel')}
      data-testid="widget-preview"
      data-screen={screen}
      data-theme={dark ? 'dark' : 'light'}
      data-header={plain ? 'plain' : 'brand'}
      lang={look.lang}
      dir={rtl ? 'rtl' : 'ltr'}
      className="mx-auto flex w-full max-w-[340px] flex-col overflow-hidden border shadow-lg"
      style={{
        fontFamily:
          look.fontFamily === 'system'
            ? 'system-ui, sans-serif'
            : look.fontFamily === 'noto-sans'
              ? '"Noto Sans", sans-serif'
              : undefined,
        borderRadius: corner(look.radius, 16),
        backgroundColor: palette.surface,
        color: INK,
        borderColor: BORDER,
      }}
    >
      <header
        className="flex items-center gap-3 px-4 py-3"
        style={header}
        data-testid="preview-header"
      >
        {look.logoUrl ? (
          <img
            src={look.logoUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="size-8 shrink-0 bg-white object-contain"
            style={{ borderRadius: corner(look.radius, 8) }}
          />
        ) : (
          <span
            className="flex size-8 shrink-0 items-center justify-center"
            style={{
              borderRadius: corner(look.radius, 8),
              backgroundColor: 'color-mix(in srgb, currentColor 16%, transparent)',
            }}
            aria-hidden="true"
          >
            <LauncherPicture icon="chat" className="size-4" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          <bdi>{look.name}</bdi>
        </span>
        <ChevronDownIcon className="size-4 shrink-0 opacity-80" aria-hidden="true" />
        <XIcon className="size-4 shrink-0" aria-hidden="true" />
      </header>
      {screen === 'home' ? (
        <div className="flex min-h-56 flex-col gap-3 p-4 text-sm">
          <div className="flex max-w-[88%] items-end gap-2 self-start">
            <span
              className="mb-0.5 size-6 shrink-0 rounded-full"
              style={{ backgroundColor: look.colour }}
              aria-hidden="true"
            />
            <p
              className="px-3 py-2"
              style={{ ...bubble, backgroundColor: MUTED }}
              data-testid="preview-greeting"
            >
              {look.greeting}
            </p>
          </div>
          {content.suggestions && content.suggestions.length > 0 ? (
            <ul className="flex flex-wrap gap-2 ps-8" data-testid="preview-suggestions">
              {content.suggestions.map((question, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: questions of a picture, in their order
                <li key={index}>
                  <span
                    className="inline-block border px-3 py-1 text-xs"
                    style={{ borderRadius: '999px', borderColor: look.colour }}
                  >
                    <bdi>{question}</bdi>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
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
      ) : null}
      {form ? (
        <div className="flex min-h-56 flex-col gap-3 p-4 text-sm" data-testid="preview-form">
          <p className="px-3 py-2" style={{ ...bubble, backgroundColor: MUTED }}>
            {screen === 'prechat' ? words.prechatIntro : words.offlineIntro}
          </p>
          {fields.map((field) => (
            <FieldPicture
              key={field.id}
              field={field}
              radius={look.radius}
              optional={words.optional}
              choose={words.choose}
              palette={palette}
            />
          ))}
          <span
            className="mt-auto px-3 py-2 text-center text-sm font-medium"
            style={filled}
            data-testid="preview-submit"
          >
            {screen === 'prechat' ? words.startChat : words.send}
          </span>
        </div>
      ) : null}
      {screen === 'consent' ? (
        <div className="flex min-h-56 flex-col gap-3 p-4 text-sm">
          <p
            className="px-3 py-2 whitespace-pre-line"
            style={{ ...bubble, backgroundColor: MUTED }}
            data-testid="preview-consent"
          >
            <bdi>{content.consent ?? ''}</bdi>
          </p>
          <span
            className="mt-auto px-3 py-2 text-center text-sm font-medium"
            style={filled}
            data-testid="preview-agree"
          >
            {words.agree}
          </span>
        </div>
      ) : null}
      {screen === 'thanks' ? (
        <div
          className="flex min-h-56 flex-col items-center justify-center gap-3 p-4 text-center text-sm"
          data-testid="preview-thanks"
        >
          <CheckCircle2Icon className="size-8" style={{ color: look.colour }} aria-hidden="true" />
          <p>
            <bdi>{content.thanks ?? ''}</bdi>
          </p>
          <p className="text-xs" style={{ color: SECONDARY }}>
            {words.reference}
          </p>
        </div>
      ) : null}
      {screen === 'home' ? (
        <div className="px-3 pb-2" aria-hidden="true">
          <div
            className="flex items-center gap-2 border py-1.5 ps-3 pe-1.5"
            style={{ borderRadius: corner(look.radius, 16), borderColor: BORDER }}
          >
            {content.attachments ? (
              <PaperclipIcon
                className="size-4 shrink-0"
                style={{ color: SECONDARY }}
                data-testid="preview-attach"
              />
            ) : null}
            <span className="flex-1 truncate text-xs" style={{ color: SECONDARY }}>
              {words.placeholder}
            </span>
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: look.colour, color: look.on }}
            >
              <SendIcon className="size-4 rtl:-scale-x-100" />
            </span>
          </div>
        </div>
      ) : null}
      {look.showBranding !== false ? (
        <p className="pb-2 text-center text-[10px]" style={{ color: SECONDARY }}>
          Hamnivo
        </p>
      ) : null}
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
  if (!look.launcherIcon) return panel;
  return (
    <div className="mx-auto flex w-full max-w-[340px] flex-col gap-3">
      {panel}
      <span
        className="flex items-center justify-center rounded-full shadow-lg"
        style={{
          width: launcherSize,
          height: launcherSize,
          backgroundColor: look.colour,
          color: look.on,
          alignSelf: look.launcherSide === 'bottom-left' ? 'flex-start' : 'flex-end',
        }}
        data-testid="preview-launcher"
        data-icon={look.launcherIcon}
        data-size={look.launcherSize ?? 'medium'}
        aria-hidden="true"
      >
        <LauncherPicture
          icon={look.launcherIcon}
          className={launcherSize > 56 ? 'size-7' : launcherSize < 56 ? 'size-5' : 'size-6'}
        />
      </span>
    </div>
  );
}

/** One of the launcher's pictures, drawn as the loader draws it. */
function LauncherPicture({
  icon,
  className,
}: {
  icon: NonNullable<WidgetAppearance['launcherIcon']>;
  className: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={LAUNCHER_ICONS[icon]} />
    </svg>
  );
}
