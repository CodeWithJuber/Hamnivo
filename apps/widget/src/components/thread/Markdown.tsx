import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type MouseEvent, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { copyText } from '../../clipboard.js';
import { renderMarkdown } from '../../markdown.js';
import { directionOf } from '../BidiText.js';

/**
 * An answer's text as formatted, safe HTML (W08). The copy button of a piece of code and the
 * numbers of sources are real buttons and links inside it; their clicks are handled here, once,
 * for the whole answer. An answer that did not change is not parsed again.
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
  const labels = useMemo(
    () => ({
      copy: t('ui.copyCode'),
      table: t('ui.table'),
      source: t('ui.sourceLink', { n: '{n}' }),
    }),
    [t],
  );
  const html = useMemo(
    () => renderMarkdown(text, { labels, sources, cache: !streaming }),
    [text, labels, sources, streaming],
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
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicks come from the buttons and links inside
    // biome-ignore lint/a11y/useKeyWithClickEvents: those are operated by the keyboard natively
    <div
      dir={directionOf(text)}
      data-testid={props.testId}
      className={`hv-markdown ${streaming ? 'hv-streaming' : ''} ${props.className ?? ''}`}
      onClick={onClick}
      // Sanitized by renderMarkdown: a short allow-list of tags and http(s) links only.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
