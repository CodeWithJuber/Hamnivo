import type { HamnivoClient } from '@hamnivo/client';
import type { HelpArticle, WidgetConfig } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { MailIcon, SearchIcon } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BidiText } from './BidiText.js';
import { StatusLine } from './StatusLine.js';

/** Only web links open from the chat. */
const webLink = (url: string | null): string | null => {
  try {
    return url && /^https?:$/.test(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
};

/**
 * The chat's home before a conversation (W11, W17, W19): the brand's greeting, who can answer
 * right now, the words of a proactive prompt the visitor opened, the brand's suggested questions
 * (each starts the conversation) and a search of the brand's public help. Results are the brand's
 * own articles, never generated text. While nobody can answer, a card offers to leave a message;
 * the questions and the message box stay, since the assistant may still help. While chat isn't
 * available to this visitor (H20), help search stays and the questions show without starting a
 * chat; the chat says why below, in neutral words.
 */
export function Home(props: {
  client: HamnivoClient;
  greeting: string;
  /** The prompt the visitor opened the chat from, in the brand's own words. */
  prompt: { brand: string; text: string } | null;
  suggestions: readonly string[];
  search: boolean;
  /** Who can answer right now; left out where the configuration does not say. */
  availability?: WidgetConfig['availability'] | undefined;
  locale?: string;
  /** Opens the contact form; null while someone can answer or the brand has none. */
  onContact?: (() => void) | null;
  /** False while chat isn't available to this visitor: nothing here starts a chat. */
  available?: boolean;
  onAsk: (question: string) => void;
}) {
  const { t } = useTranslation();
  const searchId = useId();
  const available = props.available !== false;
  const [query, setQuery] = useState('');
  const [state, setState] = useState<
    | { phase: 'idle' }
    | { phase: 'searching' }
    | { phase: 'done'; query: string; items: HelpArticle[] }
    | { phase: 'failed' }
  >({ phase: 'idle' });
  const results = useRef<HTMLHeadingElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    setState({ phase: 'searching' });
    try {
      const found = await props.client.helpSearch(q);
      setState({ phase: 'done', query: q, items: found.items });
      requestAnimationFrame(() => results.current?.focus());
    } catch {
      setState({ phase: 'failed' });
    }
  };

  return (
    <div className="mb-4 flex flex-col gap-4" data-testid="home">
      {props.prompt ? (
        <section
          aria-label={t('surface.proactive.from', { brand: props.prompt.brand })}
          className="rounded-2xl border border-border bg-surface px-3 py-2 text-[0.9375rem] text-text"
          data-testid="proactive-greeting"
        >
          <BidiText text={props.prompt.text} />
        </section>
      ) : null}
      <p
        className="rounded-2xl border border-border bg-surface px-3 py-2 text-[0.9375rem] text-text"
        data-testid="greeting"
      >
        {props.greeting}
      </p>
      {props.availability && available ? (
        <StatusLine availability={props.availability} locale={props.locale ?? 'en'} />
      ) : null}
      {props.onContact && available ? (
        <section
          aria-labelledby={`${searchId}-contact`}
          className="flex flex-col gap-2 rounded-2xl border border-primary/40 bg-surface p-4"
          data-testid="contact-card"
        >
          <h2 id={`${searchId}-contact`} className="text-[0.9375rem] font-semibold text-text">
            {t('surface.contact.title')}
          </h2>
          <p className="text-sm text-text">{t('surface.contact.body')}</p>
          <Button
            id="hv-contact-open"
            className="h-auto min-h-11 self-start whitespace-normal py-2"
            onClick={props.onContact}
          >
            <MailIcon className="size-4" aria-hidden="true" />
            {t('surface.contact.open')}
          </Button>
        </section>
      ) : null}
      {props.suggestions.length ? (
        <section aria-labelledby={`${searchId}-suggestions`} className="flex flex-col gap-2">
          <h2 id={`${searchId}-suggestions`} className="text-sm font-medium text-text">
            {t('surface.home.suggestions')}
          </h2>
          <ul className="flex flex-wrap gap-2" data-testid="suggestions">
            {props.suggestions.map((question) => (
              <li key={question} className="max-w-full">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-auto min-h-10 max-w-full whitespace-normal py-1.5 text-start"
                  dir="auto"
                  disabled={!available}
                  onClick={() => props.onAsk(question)}
                >
                  {question}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {props.search ? (
        <section className="flex flex-col gap-2" data-testid="help-search">
          <search>
            <form className="flex items-end gap-2" onSubmit={(e) => void submit(e)}>
              <label htmlFor={searchId} className="sr-only">
                {t('surface.home.searchLabel')}
              </label>
              <input
                id={searchId}
                type="search"
                value={query}
                maxLength={200}
                dir="auto"
                placeholder={t('surface.home.searchPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
                className="min-h-11 min-w-0 flex-1 rounded-xl border border-input bg-bg px-3 py-2 text-base text-text"
              />
              <Button
                type="submit"
                variant="outline"
                className="min-h-11"
                busy={state.phase === 'searching'}
                aria-label={t('surface.home.search')}
              >
                <SearchIcon className="size-4" aria-hidden="true" />
              </Button>
            </form>
          </search>
          <div aria-live="polite" className="flex flex-col gap-2">
            {state.phase === 'searching' ? (
              <p className="text-sm text-text-muted">{t('surface.home.searching')}</p>
            ) : null}
            {state.phase === 'failed' ? (
              <p className="text-sm text-text-muted">
                {available ? t('surface.home.searchFailed') : t('surface.home.searchFailedOnly')}
              </p>
            ) : null}
            {state.phase === 'done' ? (
              state.items.length === 0 ? (
                <p className="text-sm text-text-muted">
                  {available
                    ? t('surface.home.noResults', { query: state.query })
                    : t('surface.home.noResultsOnly', { query: state.query })}
                </p>
              ) : (
                <>
                  <h2
                    ref={results}
                    tabIndex={-1}
                    className="text-sm font-medium text-text outline-none"
                  >
                    {t('surface.home.resultsFor', { query: state.query })}
                  </h2>
                  <ul className="flex flex-col gap-2" data-testid="help-results">
                    {state.items.map((article) => (
                      <li
                        key={article.id}
                        className="rounded-xl border border-border bg-surface px-3 py-2 text-sm"
                      >
                        <h3 className="font-medium text-text" dir="auto">
                          {article.title}
                        </h3>
                        {article.heading ? (
                          <p className="text-xs text-text-muted" dir="auto">
                            {article.heading}
                          </p>
                        ) : null}
                        <p className="mt-1 text-text" dir="auto">
                          {article.excerpt}
                        </p>
                        {webLink(article.url) ? (
                          <a
                            href={webLink(article.url) as string}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            className="mt-1 inline-block text-link underline underline-offset-2"
                          >
                            {t('surface.home.openArticle')}
                          </a>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              )
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
