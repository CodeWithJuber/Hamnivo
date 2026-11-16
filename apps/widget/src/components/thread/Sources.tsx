import { ExternalLinkIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { webHref } from '../PrivacyLink.js';
import type { Source } from './model.js';

/**
 * The knowledge an answer cites (G06), numbered as in its text. Each source is a small button
 * that opens what the answer read from it; its page opens outside the chat. A source that may
 * have changed since says so in words. `focused` is the number the visitor followed from the
 * text: that source opens and takes focus.
 */
export function Sources(props: {
  sources: readonly Source[];
  /** `at` tells one visit from the next, so following the same number twice works twice. */
  focused: { number: number; at: number } | null;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState<number | null>(null);
  const chips = useRef(new Map<number, HTMLButtonElement>());
  useEffect(() => {
    if (props.focused === null) return;
    setOpen(props.focused.number);
    chips.current.get(props.focused.number)?.focus();
  }, [props.focused]);
  const shown = open === null ? undefined : props.sources[open - 1];
  const href = webHref(shown?.url);
  return (
    <div
      className="flex max-w-[92%] flex-col gap-1.5 text-xs text-text-muted"
      data-testid="sources"
    >
      <p className="font-medium">{t('sources')}</p>
      <ol className="flex flex-wrap gap-1.5">
        {props.sources.map((source, index) => {
          const number = index + 1;
          return (
            <li key={source.id} className="max-w-full">
              <button
                type="button"
                ref={(element) => {
                  if (element) chips.current.set(number, element);
                  else chips.current.delete(number);
                }}
                dir="auto"
                aria-expanded={open === number}
                aria-controls={`${id}-detail`}
                className="flex min-h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-surface py-0.5 ps-1 pe-2.5 text-start text-text hover:bg-surface-sunken aria-expanded:border-primary"
                onClick={() => setOpen(open === number ? null : number)}
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[0.6875rem] font-semibold">
                  {number}
                </span>
                <span className="truncate">{source.title}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div id={`${id}-detail`}>
        {shown ? (
          <div
            className="hv-fade flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-2.5 text-text"
            data-testid="source-detail"
          >
            <p className="font-medium" dir="auto">
              {shown.title}
            </p>
            {shown.excerpt ? (
              <p className="text-text-secondary" dir="auto">
                {shown.excerpt}
              </p>
            ) : null}
            {shown.freshness === 'current' ? null : (
              <p className="text-warning">{t(`ui.${shown.freshness}`)}</p>
            )}
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1 self-start text-link underline underline-offset-2"
              >
                {t('ui.openSource')}
                <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
