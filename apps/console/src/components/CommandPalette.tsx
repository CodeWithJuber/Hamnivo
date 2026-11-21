import { Button } from '@hamnivo/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@hamnivo/ui/components/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@hamnivo/ui/components/dialog';
import { Kbd } from '@hamnivo/ui/components/kbd';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { CornerDownLeftIcon, SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { returnFocus, useOpener } from '../lib/focus';
import { navLabels } from '../lib/nav-labels';
import {
  isPaletteShortcut,
  type PaletteGroupId,
  type PalettePath,
  paletteScore,
  paletteSections,
  usesCommandKey,
} from '../lib/palette';
import { useTenant } from '../lib/tenant';

/** Another dialog or sheet is open: the shortcut leaves it alone rather than stacking on top. */
function otherDialogOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

/**
 * The command palette (HNV-03-05): a Search button in the header, and ⌘K / Ctrl+K anywhere in
 * Studio, open a list of every page this person can open, grouped as the menu is. Typing narrows
 * it (by the page's name in the person's language, its group's name, or its English name), the
 * arrow keys choose and Enter opens. Esc closes it and puts focus back where it was; opening a
 * page puts focus on that page's heading, as the menu does.
 */
export function CommandPalette() {
  const { t, i18n } = useTranslation();
  const { can, features } = useTenant();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const opener = useOpener(open);
  const isOpen = useRef(open);
  isOpen.current = open;
  // Whether closing is because a page is opening (its heading then takes focus, not the opener).
  const leaving = useRef(false);
  const commandKey = usesCommandKey();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || !isPaletteShortcut(event)) return;
      // Inside the palette the shortcut closes it; Radix lets the event through to here.
      if (!isOpen.current && otherDialogOpen()) return;
      event.preventDefault();
      if (isOpen.current) setQuery('');
      setOpen(!isOpen.current);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const sections = useMemo(() => {
    const own = navLabels(t);
    const english = navLabels(i18n.getFixedT('en'));
    const groupLabel = (id: PaletteGroupId) =>
      id === 'account' ? t('palette.account') : own.groups[id];
    const label = (labels: typeof own, to: PalettePath) =>
      to in labels.pages
        ? labels.pages[to as keyof typeof labels.pages]
        : labels.extras[to as keyof typeof labels.extras];
    return paletteSections(can, features).map((section) => ({
      id: section.id,
      heading: groupLabel(section.id),
      items: section.items.map((to) => ({
        to,
        label: label(own, to),
        keywords: [
          label(own, to),
          groupLabel(section.id),
          label(english, to),
          section.id === 'account' ? 'account' : english.groups[section.id],
        ],
      })),
    }));
  }, [t, i18n, can, features]);

  const change = (next: boolean) => {
    if (!next) setQuery('');
    setOpen(next);
  };

  const current = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  const go = (to: PalettePath) => {
    // Choosing the page already shown just closes the palette.
    const here = to === current;
    leaving.current = !here;
    change(false);
    if (!here) void navigate({ to });
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => change(true)}
        aria-label={t('palette.open')}
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        data-testid="palette-button"
        className="text-text-secondary"
      >
        <SearchIcon aria-hidden="true" />
        <span className="hidden sm:inline">{t('palette.button')}</span>
        <Kbd aria-hidden="true" className="hidden sm:inline-flex" dir="ltr">
          {commandKey ? '⌘K' : 'Ctrl K'}
        </Kbd>
      </Button>

      <Dialog open={open} onOpenChange={change}>
        <DialogContent
          showCloseButton={false}
          data-testid="command-palette"
          // Near the top, so the box stays put while the list grows and shrinks under it.
          className="top-[max(1rem,12dvh)] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // After opening a page, focus goes to its heading, as after following a menu link.
            // The shell's own move happens while the palette still traps focus, so it is done
            // here, once the palette has closed (returnFocus without an opener: the heading).
            returnFocus(leaving.current ? null : opener.current);
            leaving.current = false;
          }}
        >
          <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('palette.description')}</DialogDescription>
          <Command label={t('palette.title')} loop filter={paletteScore} className="rounded-lg">
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t('palette.placeholder')}
              className="h-12 text-base sm:text-sm"
            />
            <CommandList className="max-h-[min(26rem,60dvh)] p-1">
              <CommandEmpty className="flex flex-col gap-1 px-4 py-8 text-center text-sm">
                <span className="font-medium text-text">
                  {t('palette.empty', { query: query.trim() })}
                </span>
                <span className="text-text-secondary">{t('palette.emptyHint')}</span>
              </CommandEmpty>
              {sections.map((section) => (
                <CommandGroup
                  key={section.id}
                  heading={section.heading}
                  className="[&_[cmdk-group-heading]]:text-text-secondary"
                >
                  {section.items.map((item) => {
                    const here = item.to === current;
                    return (
                      <CommandItem
                        key={item.to}
                        value={item.to}
                        keywords={item.keywords}
                        onSelect={() => go(item.to)}
                        data-testid="palette-item"
                        data-path={item.to}
                        className="group min-h-11 gap-3 px-3"
                      >
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {here ? (
                          <span className="shrink-0 text-xs text-text-secondary">
                            {t('palette.current')}
                          </span>
                        ) : null}
                        <CornerDownLeftIcon
                          aria-hidden="true"
                          className="invisible size-4 shrink-0 text-text-secondary group-data-[selected=true]:visible rtl:-scale-x-100"
                        />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
            <p
              aria-hidden="true"
              className="hidden items-center gap-4 border-t border-border px-4 py-2 text-xs text-text-secondary sm:flex"
            >
              <span className="flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                {t('palette.hint.move')}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd dir="ltr">Enter</Kbd>
                {t('palette.hint.open')}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd dir="ltr">Esc</Kbd>
                {t('palette.hint.close')}
              </span>
            </p>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
