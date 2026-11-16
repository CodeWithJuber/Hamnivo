import {
  BrainIcon,
  EllipsisVerticalIcon,
  GlobeIcon,
  Maximize2Icon,
  Minimize2Icon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGE_NAMES, LOCALES, type Locale } from '../../i18n.js';
import { BrandMark } from '../BrandMark.js';

const iconButton =
  'hv-header-button inline-flex size-10 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-current';

/**
 * The chat's language (W13), small enough for one header row: the native list over a globe and
 * the language's short name, so phones still open their own picker and screen readers hear
 * "Language, combo box". The ring follows the keyboard.
 */
function LanguagePicker(props: { locale: Locale; onLocale: (next: Locale) => void }) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <label className="sr-only" htmlFor="hv-locale">
        {t('language')}
      </label>
      <select
        id="hv-locale"
        className="peer absolute inset-0 size-full cursor-pointer appearance-none opacity-0"
        value={props.locale}
        onChange={(e) => props.onLocale(e.target.value as Locale)}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LANGUAGE_NAMES[l]}
          </option>
        ))}
      </select>
      <span
        aria-hidden="true"
        className="flex h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium peer-hover:bg-[color-mix(in_srgb,currentColor_16%,transparent)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-[-2px] peer-focus-visible:outline-current"
      >
        <GlobeIcon className="size-4" />
        {props.locale.toUpperCase()}
      </span>
    </div>
  );
}

/**
 * The top of the chat, in the brand's colour (W03): its logo and name, what is true of this
 * conversation (a ticket, who can answer), and the few controls every screen needs. "More" opens
 * a small panel under itself: it closes with Escape or a click elsewhere and gives focus back,
 * and Escape then does not close the chat as well.
 */
export function Header(props: {
  brand: { name: string; logoUrl: string | null };
  locale: Locale;
  onLocale: (locale: Locale) => void;
  /** Lines under the name: the ticket, who can answer. */
  children?: ReactNode;
  /** The brand's words about its assistant, always in view (U09). */
  disclosure: string;
  memory: { pressed: boolean; onToggle: () => void } | null;
  menu: {
    id: string;
    open: boolean;
    onToggle: () => void;
    /** `focus` when the keyboard closed it, so focus goes back to the button. */
    onClose: (focus: boolean) => void;
    items: ReactNode;
  };
  /** Makes the chat larger or smaller, where the website's loader can. */
  expand: { expanded: boolean; onToggle: () => void } | null;
  onClose?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const { menu } = props;
  const root = useRef<HTMLElement>(null);
  const { open, onClose } = menu;
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      const panel = root.current?.querySelector('[data-testid="more-menu"]');
      const button = root.current?.querySelector('#hv-more');
      if (!panel?.contains(target) && !button?.contains(target)) onClose(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The panel closes; the chat stays (it listens for Escape that nobody answered).
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [open, onClose]);

  return (
    <header
      ref={root}
      className="hv-header relative z-20 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pt-2 pb-2 [@media(max-height:26rem)]:gap-y-0 [@media(max-height:26rem)]:py-0"
    >
      <BrandMark url={props.brand.logoUrl} />
      <div className="min-w-0 flex-1 basis-24 ps-1">
        <h1 className="truncate text-md font-semibold">{props.brand.name}</h1>
        {props.children}
      </div>
      <div className="flex items-center">
        <LanguagePicker locale={props.locale} onLocale={props.onLocale} />
        {props.expand ? (
          <button
            type="button"
            className={`${iconButton} max-[30rem]:hidden`}
            title={t(props.expand.expanded ? 'ui.smaller' : 'ui.larger')}
            aria-label={t(props.expand.expanded ? 'ui.smaller' : 'ui.larger')}
            onClick={props.expand.onToggle}
            data-testid="expand"
          >
            {props.expand.expanded ? (
              <Minimize2Icon className="size-[18px]" aria-hidden="true" />
            ) : (
              <Maximize2Icon className="size-[18px]" aria-hidden="true" />
            )}
          </button>
        ) : null}
        {props.memory ? (
          <button
            type="button"
            id="hv-memory-open"
            className={iconButton}
            title={t('memory.open')}
            aria-label={t('memory.open')}
            aria-pressed={props.memory.pressed}
            onClick={props.memory.onToggle}
          >
            <BrainIcon className="size-5" aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          id="hv-more"
          className={iconButton}
          title={t('surface.more')}
          aria-expanded={menu.open}
          aria-controls={menu.id}
          aria-label={t('surface.moreLabel')}
          onClick={menu.onToggle}
        >
          <EllipsisVerticalIcon className="size-5" aria-hidden="true" />
        </button>
        {props.onClose ? (
          <button
            type="button"
            className={iconButton}
            title={t('close')}
            aria-label={t('close')}
            onClick={props.onClose}
          >
            <XIcon className="size-5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <p
        className="w-full text-xs leading-snug [@media(max-height:26rem)]:line-clamp-1"
        data-testid="ai-disclosure"
      >
        {props.disclosure}
      </p>
      {menu.open ? (
        <ul
          id={menu.id}
          className="hv-pop absolute end-2 top-full z-30 -mt-1 flex max-w-[calc(100%-1rem)] min-w-52 flex-col gap-0.5 rounded-xl border border-border bg-surface p-1.5 text-text shadow-lg"
          data-testid="more-menu"
        >
          {menu.items}
        </ul>
      ) : null}
    </header>
  );
}
