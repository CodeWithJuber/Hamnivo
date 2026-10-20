import { cn } from '@hamnivo/ui/lib/utils';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { NavPath } from '../lib/nav';

export interface SectionTab {
  to: NavPath;
  label: string;
  /** The page being shown is this one (or below it, such as one agent). */
  current: boolean;
  advanced?: boolean;
}

/**
 * The pages of a menu entry, as a row of links above the page (AppShell shows it when a person
 * can open two or more of them). They are links, not in-page tabs: each one is a page of its
 * own. On a narrow screen the row scrolls sideways, and the current page is brought into view.
 */
export function SectionTabs({ label, tabs }: { label: string; tabs: readonly SectionTab[] }) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLUListElement>(null);
  const currentRef = useRef<HTMLAnchorElement>(null);
  const current = tabs.find((tab) => tab.current)?.to;

  // A page far along the row (the ninth of nine, on a phone) must not start out of sight. Only the
  // row moves: scrolling the page itself would undo the position the browser restores on Back.
  useEffect(() => {
    const row = rowRef.current;
    const tab = currentRef.current;
    if (!current || !row || !tab) return;
    const rowBox = row.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    if (tabBox.left < rowBox.left) row.scrollBy({ left: tabBox.left - rowBox.left });
    else if (tabBox.right > rowBox.right) row.scrollBy({ left: tabBox.right - rowBox.right });
  }, [current]);

  return (
    <nav aria-label={label} data-testid="section-tabs" className="mb-6 border-b border-border">
      <ul
        ref={rowRef}
        className="-mb-px flex gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:thin]"
      >
        {tabs
          .filter((tab) => !tab.advanced || tab.current)
          .map((tab) => (
            <li key={tab.to} className="shrink-0">
              <Link
                ref={tab.current ? currentRef : undefined}
                to={tab.to}
                aria-current={tab.current ? 'page' : undefined}
                className={cn(
                  // The focus ring sits inside the link: the row clips whatever is drawn outside it.
                  'relative flex min-h-10 items-center rounded-t-md px-3 text-sm font-medium whitespace-nowrap focus-visible:-outline-offset-2',
                  tab.current
                    ? 'text-text after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand'
                    : 'text-text-secondary hover:text-text',
                )}
              >
                {tab.label}
              </Link>
            </li>
          ))}
      </ul>
      {tabs.some((tab) => tab.advanced && !tab.current) ? (
        <details className="py-2 text-sm">
          <summary className="w-fit cursor-pointer text-text-secondary">
            {t('agentic.advanced')}
          </summary>
          <div className="flex flex-wrap gap-3 py-2">
            {tabs
              .filter((tab) => tab.advanced && !tab.current)
              .map((tab) => (
                <Link key={tab.to} to={tab.to} className="text-link underline">
                  {tab.label}
                </Link>
              ))}
          </div>
        </details>
      ) : null}
    </nav>
  );
}
