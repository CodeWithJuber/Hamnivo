import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type MouseEvent, memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyText } from '../../clipboard.js';
import type { renderMarkdown } from '../../markdown.js';
import { directionOf } from '../BidiText.js';

type Render = typeof renderMarkdown;

let render: Render | undefined;
let loading: Promise<Render> | undefined;

/**
 * The parser and the sanitizer (marked and DOMPurify) load with the first answer, not with the
 * chat: a visitor who only looks at the home screen never downloads them.
 */
function loadRender(): Promise<Render> {
  loading ??= import('../../markdown.js').then(
    (module) => {
      render = module.renderMarkdown;
      return render;
    },
    (error: unknown) => {
      // The answer stays plain text; the next answer to appear tries again.
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

function useRender(): Render | undefined {
  const [ready, setReady] = useState<Render | undefined>(() => render);
  useEffect(() => {
    if (ready) return;
    let live = true;
    loadRender().then(
      (loaded) => {
        if (live) setReady(() => loaded);
      },
      (error: unknown) => console.warn('Formatting for answers did not load', error),
    );
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}

/**
 * An answer's text as formatted, safe HTML (W08). The copy button of a piece of code and the
 * numbers of sources are real buttons and links inside it; their clicks are handled here, once,
 * for the whole answer. An answer that did not change is not parsed again. Until the formatter
 * has loaded (the first answer only), the text shows as it is, escaped by React.
 */
export const Markdown = memo(function Markdown(props: {
  text: string;
  /** How many sources the answer lists, so `[n]` in it can link to them. */
  sources?: number;
  /** Still being written: a caret follows the last word, and nothing is kept for later. */
  streaming?: boolean;
  className?: string;
  testId?: string;
  onCite?: ((number: number) => void) | undefined;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const { text, sources = 0, streaming = false, onCite } = props;
  const format = useRender();
  const labels = useMemo(
    () => ({
      copy: t('ui.copyCode'),
      table: t('ui.table'),
      source: t('ui.sourceLink', { n: '{n}' }),
    }),
    [t],
  );
  const html = useMemo(
    () => format?.(text, { labels, sources, cache: !streaming }),
    [format, text, labels, sources, streaming],
  );
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const cite = target.closest<HTMLElement>('[data-hv-cite]');
    if (cite) {
      // The link only points inside this answer; the frame's own address stays as it is.
      event.preventDefault();
      onCite?.(Number(cite.dataset.hvCite));
      return;
    }
    const button = target.closest<HTMLButtonElement>('[data-hv-copy]');
    if (!button) return;
    const code = button.closest('.hv-code')?.querySelector('pre')?.textContent ?? '';
    void copyText(code).then((copied) => {
      announce(t(copied ? 'ui.copied' : 'ui.copyFailed'));
      if (!copied) return;
      button.textContent = t('ui.copied');
      setTimeout(() => {
        button.textContent = labels.copy;
      }, 1600);
    });
  };
  const className = `hv-markdown ${streaming ? 'hv-streaming' : ''} ${props.className ?? ''}`;
  if (html === undefined)
    return (
      <div
        dir={directionOf(text)}
        data-testid={props.testId}
        className={`${className} whitespace-pre-wrap`}
      >
        {text}
      </div>
    );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicks come from the buttons and links inside
    // biome-ignore lint/a11y/useKeyWithClickEvents: those are operated by the keyboard natively
    <div
      dir={directionOf(text)}
      data-testid={props.testId}
      className={className}
      onClick={onClick}
      // Sanitized by renderMarkdown: a short allow-list of tags and http(s) links only.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
